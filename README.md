# Nx I/O Tracer

Traces file I/O during Nx task execution and compares against declared `inputs`/`outputs`. Detects undeclared dependencies that can cause cache issues.

## Installation

### Option 1: Install into your Nx workspace (recommended)

```bash
# Clone this repo
git clone https://github.com/jaysoo/io-tracing.git
cd io-tracing

# Install into your Nx workspace
./install.sh /path/to/your/nx-workspace

# Navigate to the tracer directory
cd /path/to/your/nx-workspace/.io-tracer

# Start the container and install dependencies (first time only)
docker compose up -d
docker compose exec tracer pnpm install

# Trace a task
./trace.sh myproject:build --skip-nx-cache
```

### Option 2: Run directly from this repo

```bash
# For external workspaces
WORKSPACE_PATH=/path/to/nx-workspace docker compose up -d
docker compose exec ebpf bash -c "pnpm install"
docker compose exec ebpf node /tracer/tracer-nx.mjs project:target --skip-nx-cache

# For the test projects in this repo
docker compose up -d
docker compose exec ebpf node tracer-nx.mjs data-processor:process-data --skip-nx-cache
```

### Option 3: Run natively (Linux only, or macOS with sudo)

```bash
# macOS (requires sudo for fs_usage)
sudo node tracer-nx.mjs project:target --skip-nx-cache

# Linux
node tracer-nx.mjs project:target --skip-nx-cache
```

## Usage

```bash
# Basic usage
./trace.sh <project>:<target> [options]

# Examples
./trace.sh myapp:build --skip-nx-cache
./trace.sh mylib:test --skip-nx-cache
./trace.sh nx:build --skip-nx-cache
```

> **Tip**: Always use `--skip-nx-cache` to ensure the task runs. Cached tasks have no I/O to trace.

## How It Works

1. **Fetches resolved inputs** using Nx's `HashPlanInspector` (same logic Nx uses for caching)
2. **Traces all file I/O** during task execution (`strace` on Linux, `fs_usage` on macOS)
3. **Compares actual I/O** against declared inputs/outputs
4. **Reports mismatches** (✗ = undeclared, ✓ = declared)

## Example Output

```
============================================================
Nx I/O Tracer - File Access Monitor
============================================================
Platform: linux
Workspace: /workspace
Project: nx
Target: build

[tracer] Fetching Nx project configurations...
[tracer] Found 1 task(s) to trace:
[tracer]   - nx:build (7 inputs, 4 outputs)
[tracer] Getting resolved inputs via HashPlanInspector...
[tracer] Found 1123 resolved file inputs

[tracer] Process exited with code 0

============================================================
TRACING RESULTS
============================================================

FILES READ (190 files in project scope):
  ✓ packages/nx/src/index.ts
  ✓ packages/nx/src/config/configuration.ts
  ✗ Cargo.lock
  ✗ Cargo.toml
  ...

⚠️  UNDECLARED I/O DETECTED
============================================================

Undeclared inputs (files read but not in any task inputs):
  - Cargo.lock
  - Cargo.toml

Undeclared outputs (files written but not in any task outputs):
  - packages/nx/src/native/index.d.ts
  - packages/nx/src/native/native-bindings.js
  - packages/nx/src/native/nx.linux-arm64-gnu.node
```

## Managing the Container

```bash
# Start container
docker compose up -d

# Stop container
docker compose down

# Stop and remove volumes (clears node_modules, pnpm store, nx cache)
docker compose down -v

# View logs
docker compose logs -f

# Shell into container
docker compose exec tracer bash
```

## Test Projects

This repo includes two test libraries with intentional I/O mismatches:

### data-fetcher (dependency)

| File | Declared? | Type |
|------|-----------|------|
| `data/source.txt` | ✓ Yes | Input |
| `secret-config.txt` | ✗ No | Input |
| `dist/fetched.txt` | ✓ Yes | Output |
| `dist/cache.txt` | ✗ No | Output |

### data-processor (depends on data-fetcher)

| File | Declared? | Type |
|------|-----------|------|
| `data/input.txt` | ✓ Yes | Input |
| `undeclared-input.txt` | ✗ No | Input |
| `dist/output.txt` | ✓ Yes | Output |
| `dist/undeclared-output.txt` | ✗ No | Output |

## Files

| File | Description |
|------|-------------|
| `install.sh` | Install tracer into any Nx workspace |
| `tracer-nx.mjs` | Main tracer script |
| `Dockerfile` | Container with strace, Node.js, pnpm, Java, Rust |
| `docker-compose.yml` | Container orchestration |
| `libs/data-*/` | Test projects with intentional I/O mismatches |

## Requirements

- Docker (for cross-platform support)
- OR Linux with strace
- OR macOS with sudo access (for fs_usage)

## Troubleshooting

### Container won't start
```bash
docker compose down -v  # Remove volumes
docker compose build --no-cache  # Rebuild
docker compose up -d
```

### "pnpm install" fails
The container uses isolated node_modules. If your workspace has native modules:
```bash
docker compose exec tracer bash
rm -rf node_modules
pnpm install
```

### Task runs but no I/O detected
- Ensure you're using `--skip-nx-cache`
- Check that the task actually reads/writes files
- Some tasks may be pure computation with no file I/O
