# Nx I/O Tracer

Traces file I/O during Nx task execution and compares against declared `inputs`/`outputs`. Detects undeclared dependencies that can cause cache issues.

## Quick Start

```bash
# macOS (requires sudo)
sudo node tracer-nx.mjs data-processor:process-data

# Linux (native)
node tracer-nx.mjs data-processor:process-data

# Linux (via Docker, from macOS/Windows)
docker compose up -d --build
docker compose exec ebpf node tracer-nx.mjs data-processor:process-data
```

## How It Works

`tracer-nx.mjs` auto-detects your platform:
- **macOS**: Uses `fs_usage` (requires sudo)
- **Linux**: Uses `strace`

It then:
1. Fetches declared `inputs`/`outputs` for the task **and its dependencies**
2. Runs the task while tracing all file I/O
3. Compares actual I/O against declared patterns across all tasks
4. Reports mismatches (✗ = undeclared, ✓ = declared with project name)

> **Tip**: Use `--skip-nx-cache` to guarantee the task runs (e.g., `sudo node tracer-nx.mjs data-processor:process-data --skip-nx-cache`). If a task is cached, there's no I/O to trace. All extra arguments are passed through to `nx run`.

## Test Projects

Two test libraries with intentional I/O mismatches. `data-processor:process-data` depends on `data-fetcher:process-data`.

### data-fetcher (dependency)

| File | Declared? | Type |
|------|-----------|------|
| `data/source.txt` | ✓ Yes | Input |
| `secret-config.txt` | ✗ No | Input |
| `dist/fetched.txt` | ✓ Yes | Output |
| `dist/cache.txt` | ✗ No | Output |

### data-processor (main task)

| File | Declared? | Type |
|------|-----------|------|
| `data/input.txt` | ✓ Yes | Input |
| `undeclared-input.txt` | ✗ No | Input |
| `dist/output.txt` | ✓ Yes | Output |
| `dist/undeclared-output.txt` | ✗ No | Output |

## Example Output

```
[tracer] Found 2 task(s) to trace:
[tracer]   - data-processor:process-data (1 inputs, 1 outputs)
[tracer]   - data-fetcher:process-data (1 inputs, 1 outputs)

FILES READ:
  ✓ libs/data-fetcher/data/source.txt (data-fetcher)
  ✗ libs/data-fetcher/secret-config.txt
  ✓ libs/data-processor/data/input.txt (data-processor)
  ✗ libs/data-processor/undeclared-input.txt

FILES WRITTEN:
  ✓ libs/data-fetcher/dist/fetched.txt (data-fetcher)
  ✗ libs/data-fetcher/dist/cache.txt
  ✓ libs/data-processor/dist/output.txt (data-processor)
  ✗ libs/data-processor/dist/undeclared-output.txt

⚠️  UNDECLARED I/O DETECTED

Undeclared inputs:
  - libs/data-fetcher/secret-config.txt
  - libs/data-processor/undeclared-input.txt

Undeclared outputs:
  - libs/data-fetcher/dist/cache.txt
  - libs/data-processor/dist/undeclared-output.txt
```

## Files

| File | Description |
|------|-------------|
| `tracer-nx.mjs` | Main tracer (auto-detects macOS/Linux) |
| `libs/data-processor/` | Test project (depends on data-fetcher) |
| `libs/data-fetcher/` | Test dependency project |
| `tracer-fsusage.mjs` | Standalone macOS tracer |
| `tracer-strace.mjs` | Standalone Linux tracer |
