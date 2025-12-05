#!/usr/bin/env node
/**
 * Nx-aware I/O Tracer - Traces file I/O and compares against declared inputs/outputs
 *
 * Usage: [sudo] node tracer-nx.mjs <project>:<target>
 * Example: sudo node tracer-nx.mjs data-processor:process-data
 *
 * Auto-detects platform:
 *   - macOS: uses fs_usage (requires sudo)
 *   - Linux: uses strace
 *
 * Compares traced I/O against Nx project configuration and reports mismatches.
 */

import { spawn, execSync } from 'child_process';
import { dirname, relative, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
  workspaceRoot: resolve(__dirname),
  ignoredDirs: ['node_modules', '.nx', '.git', '.angular', '.pnpm-store', 'proc', 'dev', 'sys', 'private', 'var', 'tmp'],
  straceOutputFile: '/tmp/nx-tracer-strace.txt',
};

// ============================================================================
// Platform Detection
// ============================================================================

function getPlatform() {
  const p = platform();
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return 'unsupported';
}

function checkSudo() {
  return process.getuid?.() === 0;
}

// ============================================================================
// Nx Project Config
// ============================================================================

function getNxProjectConfig(project, target) {
  try {
    const output = execSync(`npx nx show project ${project} --json`, {
      cwd: CONFIG.workspaceRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NX_DAEMON: 'false' },
    });
    const config = JSON.parse(output);
    const targetConfig = config.targets?.[target];

    if (!targetConfig) {
      throw new Error(`Target "${target}" not found in project "${project}"`);
    }

    return {
      root: config.root,
      target: targetConfig,
      inputs: targetConfig.inputs || [],
      outputs: targetConfig.outputs || [],
    };
  } catch (err) {
    throw new Error(`Failed to get Nx project config: ${err.message}`);
  }
}

/**
 * Expand Nx path tokens like {projectRoot}, {workspaceRoot}
 */
function expandNxPath(pattern, projectRoot) {
  return pattern
    .replace(/\{projectRoot\}/g, projectRoot)
    .replace(/\{workspaceRoot\}/g, CONFIG.workspaceRoot);
}

/**
 * Check if a file path matches any of the declared patterns
 */
function matchesPatterns(filePath, patterns, projectRoot) {
  const absolutePath = filePath.startsWith('/')
    ? filePath
    : join(CONFIG.workspaceRoot, filePath);

  for (const pattern of patterns) {
    // Skip non-file patterns (like ^default, externalDependencies, etc.)
    if (typeof pattern !== 'string' || pattern.startsWith('^') || pattern.startsWith('!')) {
      continue;
    }

    const expandedPattern = expandNxPath(pattern, projectRoot);
    const absolutePattern = expandedPattern.startsWith('/')
      ? expandedPattern
      : join(CONFIG.workspaceRoot, expandedPattern);

    // Simple glob matching (just * for now)
    if (absolutePattern.includes('*')) {
      const regex = new RegExp('^' + absolutePattern.replace(/\*/g, '.*') + '$');
      if (regex.test(absolutePath)) return true;
    } else {
      // Exact match or prefix match for directories
      if (absolutePath === absolutePattern || absolutePath.startsWith(absolutePattern + '/')) {
        return true;
      }
    }
  }
  return false;
}

// ============================================================================
// macOS: fs_usage tracer
// ============================================================================

function parseFsUsageOutput(fsUsageOutput) {
  const reads = new Set();
  const writes = new Set();

  const lines = fsUsageOutput.split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    // Match open syscalls with flags pattern
    const openMatch = line.match(/\bopen\s+F=\d+\s+\(([^)]+)\)\s+(\/[^\s]+)/);
    if (openMatch) {
      const [, flags, filePath] = openMatch;

      if (!isRelevantPath(filePath)) continue;

      const relativePath = relative(CONFIG.workspaceRoot, filePath);
      if (!relativePath || relativePath.startsWith('..')) continue;

      const isReadOnly = flags[0] === 'R';
      const isWrite = flags[1] === 'W';
      const isCreate = flags[2] === 'C';
      const isTrunc = flags[4] === 'T';

      if (isReadOnly) {
        reads.add(relativePath);
      }
      if (isWrite || isCreate || isTrunc) {
        writes.add(relativePath);
      }
    }
  }

  return {
    reads: Array.from(reads).sort(),
    writes: Array.from(writes).sort(),
  };
}

async function traceMacOS(command, args) {
  if (!checkSudo()) {
    console.error('Error: fs_usage requires root privileges on macOS.');
    console.error('Please run with: sudo node tracer-nx.mjs <project>:<target>');
    process.exit(1);
  }

  // Start fs_usage FIRST (without PID filter - we'll filter by path instead)
  // This captures all filesystem activity, which we filter to workspace only
  const fsUsageProcess = spawn('fs_usage', ['-w', '-f', 'filesys'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let fsUsageOutput = '';

  fsUsageProcess.stdout.on('data', (data) => {
    fsUsageOutput += data.toString();
  });
  fsUsageProcess.stderr.on('data', (data) => {
    fsUsageOutput += data.toString();
  });

  // Give fs_usage a moment to start
  await new Promise(r => setTimeout(r, 200));

  // Now start the target process
  const targetProcess = spawn(command, args, {
    cwd: CONFIG.workspaceRoot,
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, NX_DAEMON: 'false' },
  });

  const pid = targetProcess.pid;
  console.log(`[tracer] Target process PID: ${pid}`);
  console.log(`[tracer] fs_usage tracing all filesystem activity (filtering by workspace path)`);

  targetProcess.stdout.on('data', (data) => {
    process.stdout.write(data);
  });
  targetProcess.stderr.on('data', (data) => {
    process.stderr.write(data);
  });

  const exitCode = await new Promise((resolve) => {
    targetProcess.on('close', (code) => resolve(code));
  });

  // Give fs_usage a moment to capture final events
  await new Promise(r => setTimeout(r, 500));
  fsUsageProcess.kill('SIGINT');

  await new Promise((resolve) => {
    fsUsageProcess.on('close', () => resolve());
    setTimeout(resolve, 1000);
  });

  return { exitCode, ...parseFsUsageOutput(fsUsageOutput) };
}

// ============================================================================
// Linux: strace tracer
// ============================================================================

function parseStraceOutput(straceOutput) {
  const reads = new Set();
  const writes = new Set();

  const lines = straceOutput.split('\n');

  for (const line of lines) {
    const openatMatch = line.match(/openat\(AT_FDCWD,\s*"([^"]+)",\s*([^)]+)\)\s*=\s*(\d+)/);
    if (openatMatch) {
      const [, filePath, flags] = openatMatch;

      if (!isRelevantPath(filePath)) continue;

      const relativePath = relative(CONFIG.workspaceRoot, filePath);
      if (!relativePath || relativePath.startsWith('..')) continue;

      if (flags.includes('O_WRONLY') || flags.includes('O_RDWR') || flags.includes('O_CREAT') || flags.includes('O_TRUNC')) {
        writes.add(relativePath);
      }
      if (flags.includes('O_RDONLY') || flags.includes('O_RDWR') || (!flags.includes('O_WRONLY'))) {
        reads.add(relativePath);
      }
    }
  }

  return {
    reads: Array.from(reads).sort(),
    writes: Array.from(writes).sort(),
  };
}

async function traceLinux(command, args) {
  const straceProcess = spawn('strace', [
    '-f',
    '-e', 'trace=openat',
    '-o', CONFIG.straceOutputFile,
    '-s', '0',
    '--', command, ...args
  ], {
    cwd: CONFIG.workspaceRoot,
    stdio: 'inherit',
    env: { ...process.env, NX_DAEMON: 'false' },
  });

  console.log(`[tracer] Starting strace with PID: ${straceProcess.pid}`);

  const exitCode = await new Promise((resolve, reject) => {
    straceProcess.on('close', (code) => resolve(code));
    straceProcess.on('error', (err) => reject(err));
  });

  let straceOutput = '';
  try {
    straceOutput = readFileSync(CONFIG.straceOutputFile, 'utf-8');
    unlinkSync(CONFIG.straceOutputFile);
  } catch (err) {
    console.error(`[tracer] Failed to read strace output: ${err.message}`);
  }

  return { exitCode, ...parseStraceOutput(straceOutput) };
}

// ============================================================================
// Common utilities
// ============================================================================

function isRelevantPath(filePath) {
  if (!filePath.startsWith(CONFIG.workspaceRoot)) return false;
  if (CONFIG.ignoredDirs.some(dir => filePath.includes(`/${dir}/`))) return false;
  return true;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || !args[0].includes(':')) {
    console.log('Usage: [sudo] node tracer-nx.mjs <project>:<target>');
    console.log('Example: sudo node tracer-nx.mjs data-processor:process-data');
    process.exit(1);
  }

  const [project, target] = args[0].split(':');
  const currentPlatform = getPlatform();

  console.log('='.repeat(60));
  console.log('Nx I/O Tracer - File Access Monitor');
  console.log('='.repeat(60));
  console.log(`Platform: ${currentPlatform}`);
  console.log(`Workspace: ${CONFIG.workspaceRoot}`);
  console.log(`Project: ${project}`);
  console.log(`Target: ${target}`);
  console.log('');

  if (currentPlatform === 'unsupported') {
    console.error(`Error: Unsupported platform "${platform()}". Use macOS or Linux.`);
    process.exit(1);
  }

  // Get Nx project configuration
  console.log('[tracer] Fetching Nx project configuration...');
  const projectConfig = getNxProjectConfig(project, target);
  console.log(`[tracer] Project root: ${projectConfig.root}`);
  console.log(`[tracer] Declared inputs: ${projectConfig.inputs.length} patterns`);
  console.log(`[tracer] Declared outputs: ${projectConfig.outputs.length} patterns`);
  console.log('');

  // Run the Nx command with tracing
  const command = 'npx';
  const commandArgs = ['nx', 'run', `${project}:${target}`, '--skip-nx-cache'];

  let results;
  if (currentPlatform === 'macos') {
    results = await traceMacOS(command, commandArgs);
  } else {
    results = await traceLinux(command, commandArgs);
  }

  console.log('');
  console.log(`[tracer] Process exited with code ${results.exitCode}`);

  // Compare against declared inputs/outputs
  const undeclaredReads = results.reads.filter(
    f => !matchesPatterns(f, projectConfig.inputs, projectConfig.root)
  );
  const undeclaredWrites = results.writes.filter(
    f => !matchesPatterns(f, projectConfig.outputs, projectConfig.root)
  );

  // Print results
  console.log('');
  console.log('='.repeat(60));
  console.log('TRACING RESULTS');
  console.log('='.repeat(60));

  console.log('');
  console.log('FILES READ:');
  if (results.reads.length === 0) {
    console.log('  (none detected in workspace)');
  } else {
    results.reads.forEach(f => {
      const isDeclared = matchesPatterns(f, projectConfig.inputs, projectConfig.root);
      console.log(`  ${isDeclared ? '✓' : '✗'} ${f}`);
    });
  }

  console.log('');
  console.log('FILES WRITTEN:');
  if (results.writes.length === 0) {
    console.log('  (none detected in workspace)');
  } else {
    results.writes.forEach(f => {
      const isDeclared = matchesPatterns(f, projectConfig.outputs, projectConfig.root);
      console.log(`  ${isDeclared ? '✓' : '✗'} ${f}`);
    });
  }

  // Print mismatches
  if (undeclaredReads.length > 0 || undeclaredWrites.length > 0) {
    console.log('');
    console.log('='.repeat(60));
    console.log('⚠️  UNDECLARED I/O DETECTED');
    console.log('='.repeat(60));

    if (undeclaredReads.length > 0) {
      console.log('');
      console.log('Undeclared inputs (files read but not in inputs):');
      undeclaredReads.forEach(f => console.log(`  - ${f}`));
    }

    if (undeclaredWrites.length > 0) {
      console.log('');
      console.log('Undeclared outputs (files written but not in outputs):');
      undeclaredWrites.forEach(f => console.log(`  - ${f}`));
    }
  } else {
    console.log('');
    console.log('✅ All I/O matches declared inputs/outputs');
  }

  // JSON output
  console.log('');
  console.log('JSON OUTPUT:');
  console.log(JSON.stringify({
    project,
    target,
    reads: results.reads,
    writes: results.writes,
    undeclaredReads,
    undeclaredWrites,
    exitCode: results.exitCode,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
