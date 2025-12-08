# Nx I/O Tracer

Traces file I/O during Nx task execution and compares against declared `inputs`/`outputs`. Detects undeclared dependencies that can cause cache issues.

## Installation

```bash
# Clone this repo
git clone https://github.com/jaysoo/io-tracing.git
cd io-tracing

# Install into your Nx workspace
./install.sh /path/to/your/nx-workspace
```

The installer will:
- Create `.nx/io-tracer/` directory in your workspace
- Build and start the Docker container
- Install workspace dependencies
- Reset Nx cache

## Usage

```bash
cd /path/to/your/nx-workspace/.nx/io-tracer

# Trace a single task
./trace.sh <project>:<target> --skipNxCache

# Examples
./trace.sh myapp:build --skipNxCache
./trace.sh mylib:test --skipNxCache
./trace.sh mylib:lint --skipNxCache

# Trace all projects (build targets)
docker compose exec tracer node /tracer/run-all-traces.mjs

# Trace specific target across all projects
docker compose exec tracer node /tracer/run-all-traces.mjs test
docker compose exec tracer node /tracer/run-all-traces.mjs lint
```

> **Tip**: Always use `--skipNxCache` to ensure the task runs. Cached tasks have no I/O to trace.

## What It Detects

### 1. Undeclared Inputs
Files read during task execution but not in declared `inputs`:
```
Undeclared inputs (files read but not in any task inputs):
  - packages/mylib/secret-config.txt
```

### 2. Undeclared Outputs
Files written during task execution but not in declared `outputs`:
```
Undeclared outputs (files written but not in any task outputs):
  - packages/mylib/src/generated.ts
```

### 3. Cross-Project Reads (Missing ^ Dependency Inputs)
Files from OTHER projects that were read but aren't covered by `^` dependency inputs:
```
Cross-project reads (missing ^ dependency inputs):
These files from OTHER projects were read but are not in inputs.
Add "^{projectRoot}/**/*" or similar to include dependency files.
  - packages/utils/src/index.ts (from packages/utils)
```

This is critical for tasks like `lint` where ESLint reads dependency source files for type-aware linting.

## How It Works

1. **Fetches resolved inputs** using Nx's `HashPlanInspector` (same logic Nx uses for caching)
2. **Traces all file I/O** during task execution (`strace` on Linux, `fs_usage` on macOS)
3. **Compares actual I/O** against declared inputs/outputs
4. **Detects cross-project reads** that aren't covered by `^` dependency inputs
5. **Reports mismatches** (✗ = undeclared, ✓ = declared)

## Example Output

```
============================================================
Nx I/O Tracer - File Access Monitor
============================================================
Platform: linux
Workspace: /workspace
Project: app
Target: lint

[tracer] Found 1 task(s) to trace:
[tracer]   - app:lint (2 inputs, 0 outputs) [✓ cacheable]
[tracer] Getting resolved inputs via HashPlanInspector...
[tracer] Found 4 resolved file inputs

============================================================
TRACING RESULTS
============================================================

FILES READ (1 files in project scope):
  ✓ packages/app/src/index.ts

============================================================
⚠️  UNDECLARED I/O DETECTED
============================================================

Cross-project reads (missing ^ dependency inputs):
These files from OTHER projects were read but are not in inputs.
Add "^{projectRoot}/**/*" or similar to include dependency files.
  - packages/utils/src/index.ts (from packages/utils)
```

## Fixing Issues

### Missing ^ Dependency Inputs (for lint, typecheck, etc.)

```json
// In nx.json
"namedInputs": {
  "lintSources": ["{projectRoot}/**/*.ts"]
},
"targetDefaults": {
  "lint": {
    "inputs": ["lintSources", "^lintSources", "{workspaceRoot}/eslint.config.mjs"]
  }
}
```

### Undeclared Outputs (code generators, etc.)

```json
// In project.json
"build": {
  "outputs": [
    "{projectRoot}/dist",
    "{projectRoot}/src/generated-config.ts"
  ]
}
```

### Root-level Config Files

```json
// In nx.json
"namedInputs": {
  "sharedGlobals": [
    "{workspaceRoot}/Cargo.*",
    "{workspaceRoot}/gradle.properties"
  ]
}
```

## Managing the Container

```bash
cd .nx/io-tracer

# Start container
docker compose up -d

# Stop container
docker compose down

# Stop and remove volumes (clears node_modules, pnpm store, nx cache)
docker compose down -v

# Shell into container
docker compose exec tracer bash

# Re-install dependencies after package.json changes
docker compose exec tracer npm install  # or pnpm/yarn
docker compose exec tracer npx nx reset
```

## Files

| File | Description |
|------|-------------|
| `install.sh` | Install tracer into any Nx workspace |
| `tracer-nx.mjs` | Main tracer script |
| `run-all-traces.mjs` | Batch trace all projects |
| `Dockerfile` | Container with strace, Node.js 24, pnpm, Java 17/21, Rust |
| `AI.md` | Instructions for AI assistants |

## Requirements

- Docker (recommended)
- OR Linux with strace
- OR macOS with sudo access (for fs_usage)

## Troubleshooting

### Container won't start
```bash
docker compose down -v  # Remove volumes
docker compose build --no-cache  # Rebuild
docker compose up -d
```

### Dependencies not installed
```bash
docker compose exec tracer npm install  # Detects package manager
docker compose exec tracer npx nx reset
```

### Task runs but no I/O detected
- Ensure you're using `--skipNxCache`
- Check that the task actually reads/writes files
- Some tasks may be pure computation with no file I/O

### Docker out of disk space
```bash
docker system prune -a --volumes
```
