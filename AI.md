# AI Instructions: Nx I/O Tracing

Instructions for checking all projects and tasks for misconfigured inputs/outputs.

## Prerequisites

1. **io-tracer installed** - Check for `.nx/io-tracer/` directory in workspace root
2. **Docker running** - The tracer runs in a Docker container with `strace`

## Setup (if not already installed)

```bash
# Install from io-tracing repo
/path/to/io-tracing/install.sh /path/to/nx-workspace

# Or if .nx/io-tracer already exists, just start the container
cd /path/to/nx-workspace/.nx/io-tracer
docker compose up -d
```

The installer automatically:
- Detects package manager (npm/yarn/pnpm) and installs dependencies
- Runs `nx reset` to clear stale cache

## Running Traces

### Trace a Single Task

```bash
cd .nx/io-tracer
./trace.sh <project>:<target> --skipNxCache

# Examples
./trace.sh myapp:build --skipNxCache
./trace.sh mylib:lint --skipNxCache
./trace.sh mylib:test --skipNxCache
```

### Trace All Projects

```bash
cd .nx/io-tracer

# Trace default targets (build, build-base, build-native)
docker compose exec tracer node /tracer/run-all-traces.mjs

# Trace specific target across all projects
docker compose exec tracer node /tracer/run-all-traces.mjs lint
docker compose exec tracer node /tracer/run-all-traces.mjs test
```

### Trace Isolated Tasks (No Dependencies)

```bash
./trace.sh <project>:<target> --skipNxCache --excludeTaskDependencies
```

Useful when dependencies are already built and you want to isolate the task's own I/O.

## Understanding Results

### 1. Undeclared Inputs
Files read during task execution but not declared in `inputs`:
```
Undeclared inputs (files read but not in any task inputs):
  - packages/mylib/secret-config.txt
```

**Fix**: Add to `inputs` in project.json or nx.json targetDefaults.

### 2. Undeclared Outputs
Files written during task execution but not declared in `outputs`:
```
Undeclared outputs (files written but not in any task outputs):
  - packages/mylib/src/generated.ts
```

**Fix**: Add to `outputs` in project.json.

### 3. Cross-Project Reads (Missing ^ Dependency Inputs)
Files from OTHER projects that were read but aren't covered by `^` dependency inputs:
```
Cross-project reads (missing ^ dependency inputs):
These files from OTHER projects were read but are not in inputs.
Add "^{projectRoot}/**/*" or similar to include dependency files.
  - packages/utils/src/index.ts (from packages/utils)
```

**This is the most common issue for lint/typecheck tasks!**

When ESLint or TypeScript reads dependency source files for type-aware linting, those files need to be in inputs via `^` prefix.

**Fix**: Add `^` dependency inputs in nx.json:
```json
"namedInputs": {
  "lintSources": ["{projectRoot}/**/*.ts"]
},
"targetDefaults": {
  "lint": {
    "inputs": ["lintSources", "^lintSources", "{workspaceRoot}/eslint.config.mjs"]
  }
}
```

## Analyzing Results

### Check RESULTS.md (for batch traces)

```bash
cat .nx/io-tracer/results/RESULTS.md
```

### Check Individual Task Results

```bash
# List all result files
ls .nx/io-tracer/results/*.json

# Check specific task
grep -E '"undeclaredReads"|"undeclaredWrites"|"crossProjectReads"' .nx/io-tracer/results/<project>__<target>.json -A 5
```

### Check Summary

```bash
cat .nx/io-tracer/results/summary.json
```

## Common Fixes

### Missing ^ Dependency Inputs (lint, typecheck)

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

### Undeclared Outputs (code generators)

```json
// In project.json
"build": {
  "outputs": [
    "{projectRoot}/dist",
    "{projectRoot}/src/generated-config.ts"
  ]
}
```

### Root-level Config Files (Cargo.*, gradle.*)

```json
// In nx.json
"namedInputs": {
  "sharedGlobals": [
    "{workspaceRoot}/Cargo.*",
    "{workspaceRoot}/gradle.properties"
  ]
}
```

### Native Build Outputs (.node files)

```json
// In project.json
"build-base": {
  "outputs": [
    "{projectRoot}/src/native/*.node",
    "{projectRoot}/src/native/index.d.ts"
  ]
}
```

## Investigating Issues

### Find where a file is declared

```bash
# Check nx.json for namedInputs
grep -n "filename" nx.json

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
cd .nx/io-tracer && docker compose down

# Remove volumes (clears node_modules, nx cache)
docker compose down -v
```

## Example Workflow

1. **Start tracer**: `cd .nx/io-tracer && docker compose up -d`
2. **Run traces**: `./trace.sh myapp:lint --skipNxCache`
3. **Review output**: Look for "UNDECLARED I/O DETECTED" section
4. **Apply fixes**: Edit nx.json namedInputs or project.json targets
5. **Re-run trace**: Verify fixes
6. **Cleanup**: `docker compose down`
