#!/usr/bin/env node
/**
 * I/O Tracer using dtruss (macOS alternative to strace)
 *
 * Usage: sudo node tracer-dtruss.mjs <command> [args...]
 * Example: sudo node tracer-dtruss.mjs node test-script.mjs
 *
 * This uses dtruss to trace file I/O syscalls and capture which files
 * are read and written during process execution.
 *
 * Requirements:
 * - macOS
 * - sudo (dtruss requires root privileges)
 * - SIP may need to be partially disabled for some operations
 */

import { spawn } from 'child_process';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
  workspaceRoot: resolve(__dirname),
  ignoredDirs: ['node_modules', '.nx', '.git', '.angular', 'proc', 'dev', 'sys', 'private'],
};

/**
 * Parse dtruss output to extract file reads and writes
 *
 * dtruss output format:
 *   open_nocancel("/path/to/file\0", 0x0, 0x1B6)    = 3 0
 *   open("/path/to/file\0", 0x601, 0x1B6)           = 4 0
 *
 * Flags (second argument in hex):
 *   0x0000 = O_RDONLY
 *   0x0001 = O_WRONLY
 *   0x0002 = O_RDWR
 *   0x0200 = O_CREAT
 *   0x0400 = O_TRUNC
 *   0x0008 = O_APPEND
 */
function parseDtrussOutput(dtrussOutput) {
  const reads = new Set();
  const writes = new Set();

  const lines = dtrussOutput.split('\n');

  for (const line of lines) {
    // Match open/open_nocancel syscalls
    // Format: open_nocancel("/path\0", 0xFLAGS, 0xMODE) = FD ERRNO
    //    or:  open("/path\0", 0xFLAGS, 0xMODE) = FD ERRNO
    const openMatch = line.match(/open(?:_nocancel|at)?\("([^"]+)\\0?"?,\s*(0x[0-9a-fA-F]+)/);
    if (openMatch) {
      let [, filePath, flagsHex] = openMatch;

      // Remove trailing \0 if present
      filePath = filePath.replace(/\\0$/, '');

      // Parse flags
      const flags = parseInt(flagsHex, 16);

      // Skip if not in workspace or in ignored dirs
      if (!filePath.startsWith(CONFIG.workspaceRoot)) continue;
      if (CONFIG.ignoredDirs.some(dir => filePath.includes(`/${dir}/`))) continue;

      const relativePath = relative(CONFIG.workspaceRoot, filePath);
      if (!relativePath || relativePath.startsWith('..')) continue;

      // Determine read vs write based on flags
      // O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2
      const accessMode = flags & 0x3;  // Mask for O_RDONLY/O_WRONLY/O_RDWR
      const isCreat = (flags & 0x200) !== 0;  // O_CREAT
      const isTrunc = (flags & 0x400) !== 0;  // O_TRUNC
      const isAppend = (flags & 0x8) !== 0;   // O_APPEND

      if (accessMode === 0) {
        // O_RDONLY
        reads.add(relativePath);
      } else if (accessMode === 1 || isCreat || isTrunc || isAppend) {
        // O_WRONLY or write-related flags
        writes.add(relativePath);
      } else if (accessMode === 2) {
        // O_RDWR
        reads.add(relativePath);
        writes.add(relativePath);
      }
    }
  }

  return {
    reads: Array.from(reads).sort(),
    writes: Array.from(writes).sort(),
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: sudo node tracer-dtruss.mjs <command> [args...]');
    console.log('Example: sudo node tracer-dtruss.mjs node test-script.mjs');
    process.exit(1);
  }

  // Check if running as root
  if (process.getuid() !== 0) {
    console.error('Error: dtruss requires root privileges.');
    console.error('Please run with: sudo node tracer-dtruss.mjs <command> [args...]');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('I/O Tracer (dtruss-based) - File Access Monitor');
  console.log('='.repeat(60));
  console.log(`Workspace: ${CONFIG.workspaceRoot}`);
  console.log(`Command: ${args.join(' ')}`);
  console.log('');

  // Build the dtruss command
  // -f: follow forks (children)
  // -t open: trace open syscalls
  const [cmd, ...cmdArgs] = args;

  let dtrussOutput = '';
  let processOutput = '';

  // dtruss writes its output to stderr
  const dtrussProcess = spawn('dtruss', [
    '-f',                              // Follow child processes
    '-t', 'open',                      // Only trace open syscalls (includes open_nocancel, openat)
    '--', cmd, ...cmdArgs              // Command to trace
  ], {
    cwd: CONFIG.workspaceRoot,
    stdio: ['inherit', 'pipe', 'pipe'],  // pipe stdout and stderr
  });

  console.log(`[tracer] Starting dtruss with PID: ${dtrussProcess.pid}`);
  console.log('');

  // Collect stdout (from the traced process)
  dtrussProcess.stdout.on('data', (data) => {
    processOutput += data.toString();
    process.stdout.write(data);
  });

  // Collect stderr (dtruss output)
  dtrussProcess.stderr.on('data', (data) => {
    dtrussOutput += data.toString();
    // Optionally show dtruss output in real-time for debugging:
    // process.stderr.write(data);
  });

  // Wait for process to complete
  const exitCode = await new Promise((resolve, reject) => {
    dtrussProcess.on('close', (code) => {
      resolve(code);
    });
    dtrussProcess.on('error', (err) => {
      reject(err);
    });
  });

  console.log('');
  console.log(`[tracer] Process exited with code ${exitCode}`);

  const results = parseDtrussOutput(dtrussOutput);

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

  // Debug: show raw dtruss output if no results
  if (results.reads.length === 0 && results.writes.length === 0) {
    console.log('');
    console.log('DEBUG: Raw dtruss output (first 50 lines):');
    console.log(dtrussOutput.split('\n').slice(0, 50).join('\n'));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
