# Nx I/O Tracer

Traces file I/O during Nx task execution and compares against declared `inputs`/`outputs`. Detects undeclared dependencies that can cause cache issues.

## Quick Start

```bash
# macOS (requires sudo)
sudo node tracer-nx.mjs data-processor:process-data

# Linux (native)
node tracer-nx.mjs data-processor:process-data

# Linux (via Docker, from macOS/Windows)
docker compose build && docker compose up -d
docker compose exec ebpf bash -c "pnpm install && rm -rf .nx && node tracer-nx.mjs data-processor:process-data"
```

## How It Works

`tracer-nx.mjs` auto-detects your platform:
- **macOS**: Uses `fs_usage` (requires sudo)
- **Linux**: Uses `strace`

It then:
1. Fetches the Nx project's declared `inputs` and `outputs`
2. Runs the task while tracing all file I/O
3. Compares actual I/O against declared patterns
4. Reports mismatches (✗ = undeclared, ✓ = declared)

## Test Project

The `libs/data-processor` library has intentional I/O mismatches for testing:

| File | Declared? | Type |
|------|-----------|------|
| `data/input.txt` | ✓ Yes | Input |
| `undeclared-input.txt` | ✗ No | Input |
| `data/output.txt` | ✓ Yes | Output |
| `dist/undeclared-output.txt` | ✗ No | Output |

## Example Output

```
FILES READ:
  ✓ libs/data-processor/data/input.txt
  ✗ libs/data-processor/undeclared-input.txt

FILES WRITTEN:
  ✓ libs/data-processor/data/output.txt
  ✗ libs/data-processor/dist/undeclared-output.txt

⚠️  UNDECLARED I/O DETECTED

Undeclared inputs:
  - libs/data-processor/undeclared-input.txt

Undeclared outputs:
  - libs/data-processor/dist/undeclared-output.txt
```

## Files

| File | Description |
|------|-------------|
| `tracer-nx.mjs` | Main tracer (auto-detects macOS/Linux) |
| `libs/data-processor/` | Test project with intentional mismatches |
| `tracer-fsusage.mjs` | Standalone macOS tracer |
| `tracer-strace.mjs` | Standalone Linux tracer |
