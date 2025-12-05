# eBPF I/O Tracing PoC

Proof of concept for tracing file reads/writes during process execution using strace (portable) or bpftrace (Linux native).

## Prerequisites

- Docker Desktop (macOS/Windows) or Linux with Docker

## Quick Start (Recommended)

Use docker-compose with the **strace-based tracer** (works on Docker Desktop):

```bash
# Build and start container
docker compose build
docker compose up -d

# Run the strace-based tracer (recommended - works on Docker Desktop)
docker compose exec ebpf node tracer-strace.mjs node test-script.mjs

# Cleanup when done
docker compose down
```

### Expected Output

```
============================================================
I/O Tracer (strace-based) - File Access Monitor
============================================================
Workspace: /workspace
Command: node test-script.mjs

[tracer] Starting strace with PID: 12345

PID: 12346
Reading from: /workspace/input.txt
Writing to: /workspace/output/output.txt
Read content: "hello world from input file
this is test data for ebpf tracing"
Wrote transformed content to output
Done!

[tracer] Process exited with code 0

============================================================
TRACING RESULTS
============================================================

FILES READ:
  - input.txt
  - test-script.mjs

FILES WRITTEN:
  - output/output.txt

JSON OUTPUT:
{
  "reads": [
    "input.txt",
    "test-script.mjs"
  ],
  "writes": [
    "output/output.txt"
  ]
}
```

## Alternative: bpftrace (Linux Native Only)

The bpftrace-based tracer requires kernel headers and only works on Linux (not Docker Desktop):

```bash
# On Linux with bpftrace installed
sudo node tracer.mjs node test-script.mjs
```

## Files

| File | Description |
|------|-------------|
| `tracer-strace.mjs` | **Recommended** - strace-based tracer (works on Docker Desktop) |
| `tracer.mjs` | bpftrace-based tracer (Linux native only) |
| `trace.bt` | bpftrace script for syscall tracing |
| `test-script.mjs` | Test script that reads `input.txt` and writes `output/output.txt` |
| `input.txt` | Test input file |
| `Dockerfile` | Ubuntu 22.04 with bpftrace, strace, and Node.js |
| `docker-compose.yml` | Privileged container setup |

## How It Works

### strace-based (tracer-strace.mjs)

1. Spawns `strace -f -e trace=openat` to trace file open syscalls
2. Runs the target command and captures all `openat()` calls
3. Analyzes flags to determine if file was opened for read or write:
   - `O_RDONLY` → read
   - `O_WRONLY`, `O_CREAT`, `O_TRUNC` → write
4. Filters results to workspace directory, ignoring `node_modules`, `.nx`, `.git`

### bpftrace-based (tracer.mjs)

1. Attaches to kernel tracepoints via eBPF:
   - `sys_enter_openat` / `sys_exit_openat` - Maps fd → filename
   - `sys_enter_read` / `sys_enter_write` - Tracks actual I/O
2. Polls for child processes every 100ms (`pgrep -P`)
3. Filters output to workspace directory

## Troubleshooting

### Container files not mounted
If `/workspace` is empty, restart the container from the correct directory:
```bash
docker compose down
docker compose up -d
```

### "strace: ENOENT" or command not found
Rebuild the container to install strace:
```bash
docker compose build --no-cache
docker compose up -d
```

### Docker socket errors on macOS
Docker Desktop uses a different socket path. Use docker-compose (Option 1) instead of `docker run`.

## Implementation Decision

| Environment | Tool | Notes |
|-------------|------|-------|
| Docker Desktop (macOS/Windows) | `strace` | Works reliably, slightly higher overhead |
| Linux (Nx Agents) | `bpftrace` | Lower overhead, requires CAP_BPF |
| macOS native | Not supported | Must use Docker |

## Next Steps

Once this PoC works, the pattern can be integrated into:
1. Nx CLI task runner (capture I/O during `nx build`)
2. Compare against declared inputs/outputs in task configuration
3. Report mismatches to Nx Cloud

See the task plan at `~/.ai/2025-12-05/tasks/hackday-io-tracing-plan.md` for full implementation details.
