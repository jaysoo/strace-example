#!/usr/bin/env node
/**
 * I/O Tracer - Spawns bpftrace and a target process, captures file I/O.
 *
 * Usage: node tracer.mjs <command> [args...]
 * Example: node tracer.mjs node test-script.mjs
 *
 * NOTE: Must run with sudo or in privileged Docker container.
 */

import { spawn, execSync } from 'child_process';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const CONFIG = {
  workspaceRoot: resolve(__dirname),
  ignoredDirs: ['node_modules', '.nx', '.git', '.angular'],
  pollIntervalMs: 100,
  bpfScriptPath: join(__dirname, 'trace.bt'),
};

class IoTracer {
  constructor(config) {
    this.config = config;
    this.bpfProcess = null;
    this.trackedPids = new Set();
    this.fileReads = new Set();
    this.fileWrites = new Set();
    this.pollInterval = null;
    this.isRunning = false;
  }

  static isAvailable() {
    try {
      execSync('which bpftrace', { encoding: 'utf-8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  async start(rootPid) {
    this.trackedPids.add(rootPid);
    console.log(`[tracer] Tracking root PID: ${rootPid}`);

    return new Promise((resolve, reject) => {
      // Spawn bpftrace with the script
      this.bpfProcess = spawn('sudo', ['-E', 'bpftrace', this.config.bpfScriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.bpfProcess.stdout.on('data', (data) => {
        this.processOutput(data.toString());
      });

      this.bpfProcess.stderr.on('data', (data) => {
        const stderr = data.toString();
        console.log(`[bpftrace] ${stderr.trim()}`);

        // bpftrace prints "Attaching X probes..." when ready
        if (stderr.includes('Attaching')) {
          this.isRunning = true;
          this.startPidPolling();
          resolve();
        }
      });

      this.bpfProcess.on('error', (err) => {
        console.error(`[tracer] bpftrace error:`, err);
        reject(err);
      });

      this.bpfProcess.on('close', (code) => {
        console.log(`[tracer] bpftrace exited with code ${code}`);
      });

      // Timeout if bpftrace doesn't start
      setTimeout(() => {
        if (!this.isRunning) {
          this.cleanup();
          reject(new Error('bpftrace startup timeout (5s)'));
        }
      }, 5000);
    });
  }

  processOutput(output) {
    const lines = output.trim().split('\n');

    for (const line of lines) {
      // Parse format: R|W <pid> <filepath>
      const match = line.match(/^([RW]) (\d+) (.+)$/);
      if (!match) continue;

      const [, operation, pidStr, filePath] = match;
      const pid = parseInt(pidStr, 10);

      // Only track I/O from our tracked PIDs
      if (!this.trackedPids.has(pid)) continue;

      // Filter by workspace root
      if (!filePath.startsWith(this.config.workspaceRoot)) continue;

      // Filter out ignored directories
      const isIgnored = this.config.ignoredDirs.some(
        dir => filePath.includes(`/${dir}/`)
      );
      if (isIgnored) continue;

      // Record the event
      const relativePath = relative(this.config.workspaceRoot, filePath);

      if (operation === 'R') {
        if (!this.fileReads.has(relativePath)) {
          console.log(`[tracer] READ: ${relativePath}`);
          this.fileReads.add(relativePath);
        }
      } else {
        if (!this.fileWrites.has(relativePath)) {
          console.log(`[tracer] WRITE: ${relativePath}`);
          this.fileWrites.add(relativePath);
        }
      }
    }
  }

  startPidPolling() {
    this.pollInterval = setInterval(() => {
      this.updateTrackedPids();
    }, this.config.pollIntervalMs);
  }

  updateTrackedPids() {
    const newPids = [];

    for (const pid of this.trackedPids) {
      try {
        const children = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8', stdio: 'pipe' })
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number);

        for (const childPid of children) {
          if (!this.trackedPids.has(childPid)) {
            newPids.push(childPid);
          }
        }
      } catch {
        // No children or process exited - that's fine
      }
    }

    for (const pid of newPids) {
      console.log(`[tracer] Tracking child PID: ${pid}`);
      this.trackedPids.add(pid);
    }
  }

  async stop() {
    this.cleanup();

    return {
      reads: Array.from(this.fileReads).sort(),
      writes: Array.from(this.fileWrites).sort(),
      trackedPids: Array.from(this.trackedPids),
    };
  }

  cleanup() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.bpfProcess && !this.bpfProcess.killed) {
      // Send SIGINT to bpftrace to gracefully stop
      this.bpfProcess.kill('SIGINT');
      this.bpfProcess = null;
    }

    this.isRunning = false;
  }
}

// Main
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node tracer.mjs <command> [args...]');
    console.log('Example: node tracer.mjs node test-script.mjs');
    process.exit(1);
  }

  // Check if bpftrace is available
  if (!IoTracer.isAvailable()) {
    console.error('ERROR: bpftrace not found.');
    console.error('On macOS, run this in a Docker container with --privileged flag.');
    console.error('');
    console.error('Try: docker run --rm -it --privileged --pid=host \\');
    console.error('       -v $(pwd):/workspace -w /workspace \\');
    console.error('       ghcr.io/hemslo/docker-bpf:latest');
    process.exit(1);
  }

  const tracer = new IoTracer(CONFIG);

  console.log('='.repeat(60));
  console.log('I/O Tracer - eBPF File Access Monitor');
  console.log('='.repeat(60));
  console.log(`Workspace: ${CONFIG.workspaceRoot}`);
  console.log(`Command: ${args.join(' ')}`);
  console.log('');

  // Spawn the target process
  const [cmd, ...cmdArgs] = args;
  const targetProcess = spawn(cmd, cmdArgs, {
    cwd: CONFIG.workspaceRoot,
    stdio: 'inherit',
  });

  console.log(`[tracer] Target process started with PID: ${targetProcess.pid}`);

  try {
    // Start the tracer
    await tracer.start(targetProcess.pid);
    console.log('[tracer] bpftrace attached, monitoring I/O...');
    console.log('');

    // Wait for target process to complete
    await new Promise((resolve, reject) => {
      targetProcess.on('close', (code) => {
        console.log('');
        console.log(`[tracer] Target process exited with code ${code}`);
        resolve(code);
      });
      targetProcess.on('error', reject);
    });

    // Give a moment for final I/O events to be captured
    await new Promise(resolve => setTimeout(resolve, 200));

    // Stop tracer and get results
    const results = await tracer.stop();

    // Print summary
    console.log('');
    console.log('='.repeat(60));
    console.log('TRACING RESULTS');
    console.log('='.repeat(60));
    console.log(`PIDs tracked: ${results.trackedPids.join(', ')}`);
    console.log('');
    console.log('FILES READ:');
    if (results.reads.length === 0) {
      console.log('  (none detected)');
    } else {
      results.reads.forEach(f => console.log(`  - ${f}`));
    }
    console.log('');
    console.log('FILES WRITTEN:');
    if (results.writes.length === 0) {
      console.log('  (none detected)');
    } else {
      results.writes.forEach(f => console.log(`  - ${f}`));
    }
    console.log('');

  } catch (err) {
    console.error('[tracer] Error:', err.message);
    tracer.cleanup();
    targetProcess.kill();
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
