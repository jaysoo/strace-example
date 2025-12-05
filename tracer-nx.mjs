#!/usr/bin/env node
/**
 * Nx-aware I/O Tracer - Traces file I/O and compares against declared inputs/outputs
 *
 * Usage: [sudo] node tracer-nx.mjs <project>:<target> [nx-options]
 * Example: sudo node tracer-nx.mjs data-processor:process-data --skip-nx-cache
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
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, createWriteStream } from 'fs';
import { platform } from 'os';

process.env.NX_DAEMON ='false';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Detect workspace root: use cwd (not script location) for cross-directory invocation
// This allows: `node /tracer/tracer-nx.mjs project:target` from /workspace
const workspaceRoot = process.cwd();

// Configuration
const CONFIG = {
  workspaceRoot,
  ignoredDirs: ['node_modules', '.nx', '.git', '.angular', '.pnpm-store', 'proc', 'dev', 'sys', 'private', 'var', 'tmp'],
  // Files that Nx reads during task execution (infrastructure, not task-specific)
  nxInfraFiles: [
    'nx.json',
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'tsconfig.base.json',
    'tsconfig.json',
    '.gitignore',
    '.nxignore',
    '.claude',
  ],
  // Patterns for Nx infrastructure reads (project configs, etc.)
  nxInfraPatterns: [
    /\/project\.json$/,
    /\/package\.json$/,
    /^project\.json$/,
    /^\.nx/,
    // TypeScript configs
    /tsconfig\..*\.json$/,
    /tsconfig\.json$/,
    // Jest configs
    /jest\.config\.(ts|js|cts|mts|cjs|mjs)$/,
    // ESLint configs
    /eslint\.config\.(ts|js|cts|mts|cjs|mjs)$/,
    /\.eslintrc/,
    // Other workspace config files
    /pnpm-workspace\.yaml$/,
    /rust-toolchain\.toml$/,
    /\.swcrc$/,
    // Nx plugin files
    /executors\.json$/,
    /generators\.json$/,
    /schema\.json$/,
    // Git files (Nx scans for project detection)
    /\.gitignore$/,
    /\.gitattributes$/,
    // Environment files
    /\.env/,
    /\.local\.env$/,
    // Rspack/webpack configs (Nx plugin detection)
    /rspack\.config\.(ts|js|mjs|cjs)$/,
    /webpack\.config\.(ts|js|mjs|cjs)$/,
    // Husky
    /\.husky\//,
  ],
  straceOutputFile: '/tmp/nx-tracer-strace.txt',
  fsUsageOutputFile: '/tmp/nx-tracer-fsusage.txt',
};

/**
 * Check if a path is Nx infrastructure (not task-specific I/O)
 */
function isNxInfrastructure(filePath) {
  // Check exact matches
  if (CONFIG.nxInfraFiles.includes(filePath)) {
    return true;
  }
  // Check patterns
  for (const pattern of CONFIG.nxInfraPatterns) {
    if (pattern.test(filePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Warm up Nx caches to avoid tracing project graph generation
 */
function warmUpNxCache() {
  console.log('[tracer] Warming up Nx cache...');
  try {
    execSync('npx nx report', {
      cwd: CONFIG.workspaceRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NX_DAEMON: 'false' },
    });
  } catch (err) {
    // Ignore errors - cache warmup is best-effort
  }
}

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
      project,
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
 * Get all tasks that will run (including dependencies) using nx graph
 */
function getTaskGraph(project, target) {
  try {
    const output = execSync(`npx nx graph --targets=${target} --focus=${project} --file=stdout`, {
      cwd: CONFIG.workspaceRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NX_DAEMON: 'false' },
    });
    const graph = JSON.parse(output);

    // Extract all project:target pairs that will run
    const tasks = [];
    const visited = new Set();

    function collectDeps(projName) {
      if (visited.has(projName)) return;
      visited.add(projName);

      const deps = graph.graph?.dependencies?.[projName] || [];
      for (const dep of deps) {
        collectDeps(dep.target);
      }
      tasks.push(projName);
    }

    collectDeps(project);
    return tasks;
  } catch (err) {
    // Fallback: just return the main project
    console.log(`[tracer] Could not get task graph, checking main task only`);
    return [project];
  }
}

/**
 * Get config for the specified task only (not dependencies)
 * Since we use --excludeTaskDependencies, we only need to check the main task
 */
function getTaskConfig(project, target) {
  return [getNxProjectConfig(project, target)];
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

  // Create write stream for fs_usage output (avoid memory issues with large repos)
  const outputStream = createWriteStream(CONFIG.fsUsageOutputFile);

  // Start fs_usage FIRST (without PID filter - we'll filter by path instead)
  // This captures all filesystem activity, which we filter to workspace only
  const fsUsageProcess = spawn('fs_usage', ['-w', '-f', 'filesys'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  fsUsageProcess.stdout.pipe(outputStream);
  fsUsageProcess.stderr.pipe(outputStream);

  // Give fs_usage a moment to start
  await new Promise(r => setTimeout(r, 500));

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
  await new Promise(r => setTimeout(r, 1000));

  // Unpipe before killing to prevent write-after-end errors
  fsUsageProcess.stdout.unpipe(outputStream);
  fsUsageProcess.stderr.unpipe(outputStream);

  fsUsageProcess.kill('SIGINT');

  // Wait for fs_usage to fully exit
  await new Promise((resolve) => {
    fsUsageProcess.on('close', () => resolve());
    setTimeout(resolve, 2000); // Longer timeout to ensure clean exit
  });

  // Close the output stream after fs_usage has exited
  outputStream.end();
  await new Promise(r => outputStream.on('close', r));

  // Read and parse the output file
  let fsUsageOutput = '';
  try {
    fsUsageOutput = readFileSync(CONFIG.fsUsageOutputFile, 'utf-8');
    unlinkSync(CONFIG.fsUsageOutputFile);
  } catch (err) {
    console.error(`[tracer] Failed to read fs_usage output: ${err.message}`);
  }

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

/**
 * Check if a path is a directory (not a file)
 */
function isDirectory(filePath) {
  const absolutePath = filePath.startsWith('/')
    ? filePath
    : join(CONFIG.workspaceRoot, filePath);
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

// ============================================================================
// Main
// ============================================================================

/**
 * Check if a file matches any task's declared inputs
 */
function findMatchingInputTask(filePath, taskConfigs) {
  for (const config of taskConfigs) {
    if (matchesPatterns(filePath, config.inputs, config.root)) {
      return config.project;
    }
  }
  return null;
}

/**
 * Check if a file matches any task's declared outputs
 */
function findMatchingOutputTask(filePath, taskConfigs) {
  for (const config of taskConfigs) {
    if (matchesPatterns(filePath, config.outputs, config.root)) {
      return config.project;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || !args[0].includes(':')) {
    console.log('Usage: [sudo] node tracer-nx.mjs <project>:<target> [nx-options]');
    console.log('Example: sudo node tracer-nx.mjs data-processor:process-data --skip-nx-cache');
    process.exit(1);
  }

  const [project, target] = args[0].split(':');
  const extraArgs = args.slice(1); // Pass through any additional args to nx
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

  // Get Nx project configurations for all tasks in the dependency chain
  console.log('[tracer] Fetching Nx project configurations...');
  const taskConfigs = getTaskConfig(project, target);
  console.log(`[tracer] Found ${taskConfigs.length} task(s) to trace:`);
  for (const config of taskConfigs) {
    console.log(`[tracer]   - ${config.project}:${target} (${config.inputs.length} inputs, ${config.outputs.length} outputs)`);
  }
  console.log('');

  // Warm up Nx cache to avoid tracing project graph generation
  warmUpNxCache();

  // Run the Nx command with tracing
  // Use --excludeTaskDependencies to only trace the specified task, not its dependencies
  const command = 'npx';
  const commandArgs = ['nx', 'run', `${project}:${target}`, '--excludeTaskDependencies', ...extraArgs];

  let results;
  if (currentPlatform === 'macos') {
    results = await traceMacOS(command, commandArgs);
  } else {
    results = await traceLinux(command, commandArgs);
  }

  console.log('');
  console.log(`[tracer] Process exited with code ${results.exitCode}`);

  // Filter out Nx infrastructure files (project.json, tsconfig.json, etc.)
  const taskReads = results.reads.filter(f => !isNxInfrastructure(f));
  const taskWrites = results.writes.filter(f => !isNxInfrastructure(f));

  // Get project root for filtering
  const projectRoot = taskConfigs[0]?.root || '';

  // Helper to check if a file is relevant to this project
  // (in project root, or in a shared location like libs/)
  const isRelevantToProject = (filePath) => {
    // Files in the project root are always relevant
    if (filePath.startsWith(projectRoot + '/') || filePath === projectRoot) {
      return true;
    }
    // Root-level files might be relevant (e.g., shared configs)
    if (!filePath.includes('/')) {
      return true;
    }
    // Files in other projects/directories are likely Nx scanning, not task I/O
    return false;
  };

  // Compare against declared inputs/outputs across ALL tasks
  // Filter out directories and files outside the project
  const undeclaredReads = taskReads.filter(
    f => !isDirectory(f) && isRelevantToProject(f) && !findMatchingInputTask(f, taskConfigs)
  );
  const undeclaredWrites = taskWrites.filter(
    f => !isDirectory(f) && isRelevantToProject(f) && !findMatchingOutputTask(f, taskConfigs)
  );

  // Print results
  console.log('');
  console.log('='.repeat(60));
  console.log('TRACING RESULTS');
  console.log('='.repeat(60));

  // Filter to only show files relevant to the project
  const relevantReads = taskReads.filter(f => isRelevantToProject(f) && !isDirectory(f));
  const relevantWrites = taskWrites.filter(f => isRelevantToProject(f) && !isDirectory(f));

  console.log('');
  console.log(`FILES READ (${relevantReads.length} files in project scope):`);
  if (relevantReads.length === 0) {
    console.log('  (none detected in project scope)');
  } else {
    relevantReads.forEach(f => {
      const matchingTask = findMatchingInputTask(f, taskConfigs);
      if (matchingTask) {
        console.log(`  ✓ ${f}`);
      } else {
        console.log(`  ✗ ${f}`);
      }
    });
  }

  console.log('');
  console.log(`FILES WRITTEN (${relevantWrites.length} files in project scope):`);
  if (relevantWrites.length === 0) {
    console.log('  (none detected in project scope)');
  } else {
    relevantWrites.forEach(f => {
      const matchingTask = findMatchingOutputTask(f, taskConfigs);
      if (matchingTask) {
        console.log(`  ✓ ${f}`);
      } else {
        console.log(`  ✗ ${f}`);
      }
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
      console.log('Undeclared inputs (files read but not in any task inputs):');
      undeclaredReads.forEach(f => console.log(`  - ${f}`));
    }

    if (undeclaredWrites.length > 0) {
      console.log('');
      console.log('Undeclared outputs (files written but not in any task outputs):');
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
    tasks: taskConfigs.map(c => `${c.project}:${target}`),
    reads: taskReads,
    writes: taskWrites,
    undeclaredReads,
    undeclaredWrites,
    exitCode: results.exitCode,
  }, null, 2));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
