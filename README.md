# I/O Tracing PoC

Proof of concept for tracing file reads/writes during process execution.

## Platform Support

| Platform | Tool | Requires |
|----------|------|----------|
| **macOS** | `fs_usage` | `sudo` |
| **Linux** | `strace` | None (or Docker) |
| **Linux (native)** | `bpftrace` | Kernel headers, `CAP_BPF` |
| **Windows** | TBD | - |

## Quick Start

### macOS (Native)

```bash
# Uses fs_usage to trace file I/O (requires sudo)
sudo node tracer-fsusage.mjs node test-script.mjs
```

### Linux (Native or Docker)

```bash
# Option 1: Native Linux with strace
node tracer-strace.mjs node test-script.mjs

# Option 2: Docker (works on macOS/Windows too)
docker compose build
docker compose up -d
docker compose exec ebpf node tracer-strace.mjs node test-script.mjs
docker compose down
```

### Expected Output

```
============================================================
I/O Tracer - File Access Monitor
============================================================
Workspace: /path/to/io-tracing
Command: node test-script.mjs

[tracer] Target process PID: 12345

PID: 12345
Reading from: /path/to/io-tracing/input.txt
Writing to: /path/to/io-tracing/output/output.txt
Read content: "hello world from input file"
Wrote transformed content to output
Done!

[tracer] Process exited with code 0

============================================================
TRACING RESULTS
============================================================

FILES READ:
  - input.txt
  - input2.txt
  - test-script.mjs

FILES WRITTEN:
  - output/output.txt
  - output/output2.txt

JSON OUTPUT:
{
  "reads": ["input.txt", "input2.txt", "test-script.mjs"],
  "writes": ["output/output.txt", "output/output2.txt"]
}
```

## Files

| File | Platform | Description |
|------|----------|-------------|
| `tracer-fsusage.mjs` | macOS | Uses `fs_usage` to trace file opens |
| `tracer-strace.mjs` | Linux | Uses `strace` to trace syscalls |
| `tracer.mjs` | Linux | Uses `bpftrace` (requires kernel headers) |
| `tracer-dtruss.mjs` | macOS | Uses `dtruss` (may have SIP issues) |
| `test-script.mjs` | Any | Test script that reads/writes files |
| `input.txt`, `input2.txt` | Any | Test input files |

## How It Works

### macOS: fs_usage (tracer-fsusage.mjs)

1. Spawns target process and captures its PID
2. Runs `fs_usage -w -f filesys <pid>` to monitor filesystem events
3. Parses `open` syscalls with flag patterns:
   - `(R___________)` → read
   - `(_WC_T______X)` → write (create/truncate)
4. Filters to workspace directory only

### Linux: strace (tracer-strace.mjs)

1. Spawns `strace -f -e trace=openat` to trace file open syscalls
2. Runs the target command and captures all `openat()` calls
3. Analyzes flags to determine read vs write:
   - `O_RDONLY` → read
   - `O_WRONLY`, `O_CREAT`, `O_TRUNC` → write
4. Filters to workspace directory, ignoring `node_modules`, `.nx`, `.git`

### Linux: bpftrace (tracer.mjs)

1. Attaches to kernel tracepoints via eBPF:
   - `sys_enter_openat` / `sys_exit_openat` - Maps fd → filename
   - `sys_enter_read` / `sys_enter_write` - Tracks actual I/O
2. Polls for child processes every 100ms
3. Filters output to workspace directory

## Troubleshooting

### macOS: "fs_usage requires root privileges"
```bash
sudo node tracer-fsusage.mjs node test-script.mjs
```

### macOS: dtruss doesn't work (SIP)
Use `tracer-fsusage.mjs` instead. dtruss may be blocked by System Integrity Protection.

### Linux/Docker: Container files not mounted
```bash
docker compose down
docker compose up -d
```

### Linux/Docker: "strace: ENOENT"
```bash
docker compose build --no-cache
docker compose up -d
```

## Next Steps

Integration into Nx CLI:
1. Capture I/O during `nx build` task execution
2. Compare against declared inputs/outputs in task configuration
3. Report mismatches to Nx Cloud
