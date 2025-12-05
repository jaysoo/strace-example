#!/usr/bin/env node
/**
 * I/O Tracer using fs_usage (macOS built-in tool)
 *
 * Usage: sudo node tracer-fsusage.mjs <command> [args...]
 * Example: sudo node tracer-fsusage.mjs node test-script.mjs
 *
 * This uses fs_usage to monitor file system activity and capture which files
 * are read and written during process execution.
 *
 * Requirements:
 * - macOS
 * - sudo (fs_usage requires root privileges)
 *
 * Note: fs_usage is a real-time monitoring tool, so we:
 * 1. Start fs_usage in the background filtering by our process
 * 2. Run the target command
 * 3. Stop fs_usage and parse the output
 */

import { spawn, spawnSync } from 'child_process';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
  workspaceRoot: resolve(__dirname),
  ignoredDirs: ['node_modules', '.nx', '.git', '.angular', 'proc', 'dev', 'sys', 'private', 'var'],
};

/**
 * Parse fs_usage output to extract file reads and writes
 *
 * fs_usage -w output format for open:
 *   10:51:10.550558  open  F=12  (R___________)  /path/to/file  0.000147  node.725531
 *   10:51:10.550558  open  F=12  (_WC_T______X)  /path/to/file  0.000147  node.725531
 *
 * Flags pattern (12 chars):
 *   Position 0: R = O_RDONLY, W = O_WRONLY, _ = neither (O_RDWR implied if W+R)
 *   Position 1: W = O_RDWR (read+write)
 *   Position 2: C = O_CREAT
 *   Position 3: A = O_APPEND
 *   Position 4: T = O_TRUNC
 *   Position 5-10: other flags
 *   Position 11: X = O_EXCL (exclusive create)
 *
 * Examples:
 *   (R___________) = read only
 *   (_WC_T______X) = write + create + truncate + exclusive
 *   (_W__________) = write only
 */
function parseFsUsageOutput(fsUsageOutput) {
  const reads = new Set();
  const writes = new Set();

  const lines = fsUsageOutput.split('\n');

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Match open syscalls with flags pattern
    // Format: timestamp  open  F=N  (FLAGS)  /path/to/file  duration  process.pid
    const openMatch = line.match(/\bopen\s+F=\d+\s+\(([^)]+)\)\s+(\/[^\s]+)/);
    if (openMatch) {
      const [, flags, filePath] = openMatch;

      // Skip if not in workspace
      if (!isRelevantPath(filePath)) continue;

      const relativePath = relative(CONFIG.workspaceRoot, filePath);
      if (!relativePath || relativePath.startsWith('..')) continue;

      // Parse flags pattern: (R___________)  or  (_WC_T______X)
      // Position 0: R = read-only
      // Position 1: W = write (O_RDWR)
      // Position 2: C = create
      // Position 4: T = truncate
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

function isRelevantPath(filePath) {
  if (!filePath.startsWith(CONFIG.workspaceRoot)) return false;
  if (CONFIG.ignoredDirs.some(dir => filePath.includes(`/${dir}/`))) return false;
  return true;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: sudo node tracer-fsusage.mjs <command> [args...]');
    console.log('Example: sudo node tracer-fsusage.mjs node test-script.mjs');
    process.exit(1);
  }

  // Check if running as root
  if (process.getuid() !== 0) {
    console.error('Error: fs_usage requires root privileges.');
    console.error('Please run with: sudo node tracer-fsusage.mjs <command> [args...]');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('I/O Tracer (fs_usage-based) - File Access Monitor');
  console.log('='.repeat(60));
  console.log(`Workspace: ${CONFIG.workspaceRoot}`);
  console.log(`Command: ${args.join(' ')}`);
  console.log('');

  const [cmd, ...cmdArgs] = args;

  // First, start the target process and get its PID
  const targetProcess = spawn(cmd, cmdArgs, {
    cwd: CONFIG.workspaceRoot,
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: false,
  });

  const pid = targetProcess.pid;
  console.log(`[tracer] Target process PID: ${pid}`);

  // Start fs_usage monitoring this PID
  // -w: wide output (full paths)
  // -f filesys: only filesystem events
  // The PID filter at the end
  const fsUsageProcess = spawn('fs_usage', [
    '-w',           // Wide output
    '-f', 'filesys', // Only filesystem events
    `${pid}`,       // Filter by PID
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  console.log(`[tracer] Started fs_usage with PID: ${fsUsageProcess.pid}`);
  console.log('');

  let fsUsageOutput = '';
  let targetStdout = '';
  let targetStderr = '';

  // Collect fs_usage output
  fsUsageProcess.stdout.on('data', (data) => {
    fsUsageOutput += data.toString();
  });
  fsUsageProcess.stderr.on('data', (data) => {
    fsUsageOutput += data.toString();
  });

  // Pass through target process output
  targetProcess.stdout.on('data', (data) => {
    targetStdout += data.toString();
    process.stdout.write(data);
  });
  targetProcess.stderr.on('data', (data) => {
    targetStderr += data.toString();
    process.stderr.write(data);
  });

  // Wait for target process to complete
  const exitCode = await new Promise((resolve) => {
    targetProcess.on('close', (code) => {
      resolve(code);
    });
  });

  // Give fs_usage a moment to capture final events
  await new Promise(r => setTimeout(r, 500));

  // Stop fs_usage
  fsUsageProcess.kill('SIGINT');

  // Wait for fs_usage to exit
  await new Promise((resolve) => {
    fsUsageProcess.on('close', () => resolve());
    // Timeout in case it doesn't exit cleanly
    setTimeout(resolve, 1000);
  });

  console.log('');
  console.log(`[tracer] Process exited with code ${exitCode}`);

  const results = parseFsUsageOutput(fsUsageOutput);

  // Print summary
  console.log('');
  console.log('='.repeat(60));
  console.log('TRACING RESULTS');
  console.log('='.repeat(60));
  console.log('');
  console.log('FILES READ:');
  if (results.reads.length === 0) {
    console.log('  (none detected in workspace)');
  } else {
    results.reads.forEach(f => console.log(`  - ${f}`));
  }
  console.log('');
  console.log('FILES WRITTEN:');
  if (results.writes.length === 0) {
    console.log('  (none detected in workspace)');
  } else {
    results.writes.forEach(f => console.log(`  - ${f}`));
  }
  console.log('');

  // Output as JSON for programmatic use
  console.log('JSON OUTPUT:');
  console.log(JSON.stringify(results, null, 2));

  // Debug: show raw fs_usage output if no results
  if (results.reads.length === 0 && results.writes.length === 0) {
    console.log('');
    console.log('DEBUG: Raw fs_usage output (first 100 lines):');
    console.log(fsUsageOutput.split('\n').slice(0, 100).join('\n'));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
