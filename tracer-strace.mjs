#!/usr/bin/env node
/**
 * I/O Tracer using strace (portable alternative to bpftrace)
 *
 * Usage: node tracer-strace.mjs <command> [args...]
 * Example: node tracer-strace.mjs node test-script.mjs
 *
 * This uses strace to trace file I/O syscalls and capture which files
 * are read and written during process execution.
 */

import { spawn } from 'child_process';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, unlinkSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
  workspaceRoot: resolve(__dirname),
  ignoredDirs: ['node_modules', '.nx', '.git', '.angular', 'proc', 'dev', 'sys'],
  straceOutputFile: '/tmp/strace-output.txt',
};

/**
 * Parse strace output to extract file reads and writes
 */
function parseStraceOutput(straceOutput) {
  const reads = new Set();
  const writes = new Set();

  const lines = straceOutput.split('\n');

  for (const line of lines) {
    // Match openat syscalls: openat(AT_FDCWD, "/path/to/file", O_RDONLY|...) = 3
    const openatMatch = line.match(/openat\(AT_FDCWD,\s*"([^"]+)",\s*([^)]+)\)\s*=\s*(\d+)/);
    if (openatMatch) {
      const [, filePath, flags, fd] = openatMatch;

      // Skip if not in workspace or in ignored dirs
      if (!filePath.startsWith(CONFIG.workspaceRoot)) continue;
      if (CONFIG.ignoredDirs.some(dir => filePath.includes(`/${dir}/`))) continue;

      const relativePath = relative(CONFIG.workspaceRoot, filePath);
      if (!relativePath || relativePath.startsWith('..')) continue;

      // Determine if read or write based on flags
      if (flags.includes('O_WRONLY') || flags.includes('O_RDWR') || flags.includes('O_CREAT') || flags.includes('O_TRUNC')) {
        writes.add(relativePath);
      }
      if (flags.includes('O_RDONLY') || flags.includes('O_RDWR') || (!flags.includes('O_WRONLY'))) {
        reads.add(relativePath);
      }
    }

    // Also match read() and write() syscalls for more detail
    // read(3, "content", 4096) = 100
    // write(4, "content", 100) = 100
  }

  return {
    reads: Array.from(reads).sort(),
    writes: Array.from(writes).sort(),
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node tracer-strace.mjs <command> [args...]');
    console.log('Example: node tracer-strace.mjs node test-script.mjs');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('I/O Tracer (strace-based) - File Access Monitor');
  console.log('='.repeat(60));
  console.log(`Workspace: ${CONFIG.workspaceRoot}`);
  console.log(`Command: ${args.join(' ')}`);
  console.log('');

  // Build the strace command
  // -f: follow forks
  // -e trace=openat: only trace openat syscalls (file opens)
  // -o: output to file
  const [cmd, ...cmdArgs] = args;

  const straceProcess = spawn('strace', [
    '-f',                          // Follow child processes
    '-e', 'trace=openat',          // Only trace file open syscalls
    '-o', CONFIG.straceOutputFile, // Output to file
    '-s', '0',                     // Don't print string arguments (faster)
    '--', cmd, ...cmdArgs          // Command to trace
  ], {
    cwd: CONFIG.workspaceRoot,
    stdio: 'inherit',  // Pass through stdin/stdout/stderr
  });

  console.log(`[tracer] Starting strace with PID: ${straceProcess.pid}`);
  console.log('');

  // Wait for process to complete
  const exitCode = await new Promise((resolve, reject) => {
    straceProcess.on('close', (code) => {
      resolve(code);
    });
    straceProcess.on('error', (err) => {
      reject(err);
    });
  });

  console.log('');
  console.log(`[tracer] Process exited with code ${exitCode}`);

  // Parse the strace output
  let straceOutput = '';
  try {
    straceOutput = readFileSync(CONFIG.straceOutputFile, 'utf-8');
  } catch (err) {
    console.error(`[tracer] Failed to read strace output: ${err.message}`);
    process.exit(1);
  }

  const results = parseStraceOutput(straceOutput);

  // Cleanup temp file
  try {
    unlinkSync(CONFIG.straceOutputFile);
  } catch {}

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
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
