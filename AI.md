# AI Instructions: Nx I/O Tracing

Instructions for checking all projects and tasks for misconfigured inputs/outputs.

## Prerequisites

1. **io-tracer installed** - Check for `.io-tracer/` directory in workspace root
2. **Docker running** - The tracer runs in a Docker container with `strace`

## Setup (if not already installed)

```bash
# Install from io-tracing repo
/Users/jack/projects/io-tracing/install.sh /path/to/nx-workspace

# Or if .io-tracer already exists, just start the container
cd /path/to/nx-workspace/.io-tracer
docker compose up -d
docker compose exec tracer pnpm install
```

## Running the Full Trace

### Option 1: Use run-all-traces.mjs (Recommended)

```bash
cd .io-tracer
docker compose exec tracer node /tracer/run-all-traces.mjs 2>&1
```

This script:
- Gets all projects from `nx show projects`
- Filters out e2e, examples, native binaries, docs
- Traces `build`, `build-base`, and `build-native` targets
- Outputs results to `/tracer/results/` (inside container)
- Updates `RESULTS.md` incrementally

### Option 2: Trace Individual Tasks

```bash
docker compose exec tracer node /tracer/tracer-nx.mjs <project>:<target> --skipNxCache
```

Always use `--skipNxCache` to ensure the task actually runs.

### Option 3: Trace Isolated Tasks (No Dependencies)

To trace a single task without running its dependencies, use `--excludeTaskDependencies`:

```bash
docker compose exec tracer node /tracer/tracer-nx.mjs <project>:<target> --skipNxCache --excludeTaskDependencies
```

This is useful when:
- You want to see I/O for just one task, not its entire dependency chain
- Dependencies have already been built and you want to isolate the task's own I/O
- Debugging specific tasks without noise from upstream builds

**Note**: The task may fail if dependencies haven't been built. Run a normal build first, then use `--excludeTaskDependencies` for isolated tracing.

## Analyzing Results

### Check RESULTS.md

```bash
cat .io-tracer/results/RESULTS.md
```

### Check Individual Task Results

```bash
# List all result files
ls .io-tracer/results/*.json

# Check specific task (use grep for large files)
grep -E '"undeclaredReads"|"undeclaredWrites"' .io-tracer/results/<project>__<target>.json -A 5
```

### Check Summary

```bash
cat .io-tracer/results/summary.json
```

## Understanding Results

### Undeclared Reads
Files read during task execution but not declared in `inputs`:
- Check `nx.json` namedInputs
- Check `project.json` target inputs
- Check `targetDefaults` in `nx.json`

### Undeclared Writes
Files written during task execution but not declared in `outputs`:
- Check `project.json` target outputs
- Check `targetDefaults` in `nx.json`

## Common Patterns

### Root-level config files (e.g., Cargo.*, gradle.*)
Add to `namedInputs` in `nx.json`:
```json
"namedInputs": {
  "sharedGlobals": [
    "{workspaceRoot}/Cargo.*",
    "{workspaceRoot}/gradle.properties"
  ]
}
```

### Native build outputs (e.g., .node files)
Add to target outputs in `project.json`:
```json
"build-base": {
  "outputs": [
    "{projectRoot}/src/native/*.node",
    "{projectRoot}/src/native/index.d.ts"
  ]
}
```

### TypeScript build info files
Add to target inputs:
```json
"build": {
  "inputs": [
    "production",
    "{projectRoot}/dist/tsconfig.lib.tsbuildinfo"
  ]
}
```

## Retry Failed Tasks

If tasks fail with JSON parse errors or "No JSON output", retry them individually:

```bash
docker compose exec tracer node /tracer/tracer-nx.mjs <project>:<target> --skipNxCache 2>&1 | tail -50
```

Failures are usually transient (output buffer issues).

## Investigating Undeclared I/O

### Find where a file is declared

```bash
# Check nx.json for namedInputs
grep -n "Cargo" nx.json

# Check target defaults
grep -A 10 "targetDefaults" nx.json

# Check specific project
cat packages/<project>/project.json | grep -A 5 "inputs\|outputs"
```

### Understand task dependencies

```bash
# Check what targets depend on
grep -A 5 "dependsOn" nx.json | head -30

# See full task graph
npx nx graph --target=build --focus=<project>
```

## Cleanup

```bash
# Stop container
cd .io-tracer && docker compose down

# Remove volumes (clears node_modules, nx cache)
docker compose down -v
```

## Example Workflow

1. **Start tracer**: `cd .io-tracer && docker compose up -d`
2. **Install deps**: `docker compose exec tracer pnpm install`
3. **Run full trace**: `docker compose exec tracer node /tracer/run-all-traces.mjs`
4. **Review results**: `cat results/RESULTS.md`
5. **Investigate issues**: Check nx.json and project.json for missing declarations
6. **Apply fixes**: Edit nx.json namedInputs or project.json targets
7. **Re-run specific tasks**: Verify fixes with individual traces
8. **Cleanup**: `docker compose down`
