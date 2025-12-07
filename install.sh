#!/bin/bash
#
# Install io-tracer into an Nx workspace
#
# Usage: ./install.sh /path/to/nx-workspace
#
# This creates a .io-tracer directory in your workspace with:
#   - docker-compose.yml
#   - Dockerfile
#   - tracer-nx.mjs
#
# Then run: cd /path/to/nx-workspace/.io-tracer && docker compose up -d
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_PATH="${1:-.}"

# Resolve to absolute path
WORKSPACE_PATH="$(cd "$WORKSPACE_PATH" && pwd)"

# Validate it's an Nx workspace
if [[ ! -f "$WORKSPACE_PATH/nx.json" ]]; then
  echo "Error: $WORKSPACE_PATH does not appear to be an Nx workspace (no nx.json found)"
  exit 1
fi

echo "Installing io-tracer into: $WORKSPACE_PATH"

# Create .io-tracer directory
TRACER_DIR="$WORKSPACE_PATH/.io-tracer"
mkdir -p "$TRACER_DIR"

# Copy files
cp "$SCRIPT_DIR/Dockerfile" "$TRACER_DIR/"
cp "$SCRIPT_DIR/tracer-nx.mjs" "$TRACER_DIR/"
cp "$SCRIPT_DIR/run-all-traces.mjs" "$TRACER_DIR/"
cp "$SCRIPT_DIR/AI.md" "$TRACER_DIR/"

# Generate docker-compose.yml tailored for this workspace
cat > "$TRACER_DIR/docker-compose.yml" << 'EOF'
# Docker Compose for Nx I/O Tracer
#
# Usage:
#   docker compose up -d
#   docker compose exec tracer node tracer-nx.mjs <project>:<target> --skipNxCache
#   docker compose down
#

services:
  tracer:
    build: .
    privileged: true
    pid: host
    network_mode: host
    volumes:
      # Mount parent directory (the Nx workspace)
      - ..:/workspace
      # Mount tracer scripts
      - .:/tracer
      # ============================================================
      # Isolated volumes (prevents permission issues with host)
      # These directories are created in Docker and not shared with host
      # ============================================================
      # Node dependencies
      - tracer_node_modules:/workspace/node_modules
      - tracer_pnpm_store:/workspace/.pnpm-store
      # Nx cache
      - tracer_nx_cache:/workspace/.nx
      # Build outputs (dist, tmp, build, coverage)
      - tracer_dist:/workspace/dist
      - tracer_tmp:/workspace/tmp
      - tracer_build:/workspace/build
      - tracer_coverage:/workspace/coverage
      # Rust/Cargo (if workspace uses Rust)
      - tracer_cargo_target:/workspace/target
      # Required for eBPF (may not exist on Docker Desktop)
      - /sys/kernel/debug:/sys/kernel/debug:rw
    environment:
      - npm_config_cache=/tmp/.npm
      - PNPM_HOME=/tmp/.pnpm
    working_dir: /workspace
    stdin_open: true
    tty: true
    command: tail -f /dev/null

volumes:
  tracer_node_modules:
  tracer_pnpm_store:
  tracer_nx_cache:
  tracer_dist:
  tracer_tmp:
  tracer_build:
  tracer_coverage:
  tracer_cargo_target:
EOF

# Create a convenience run script
cat > "$TRACER_DIR/trace.sh" << 'EOF'
#!/bin/bash
#
# Trace an Nx task
# Usage: ./trace.sh <project>:<target> [options]
# Example: ./trace.sh myapp:build --skipNxCache
#

set -e

if [[ -z "$1" ]]; then
  echo "Usage: ./trace.sh <project>:<target> [options]"
  echo "Example: ./trace.sh myapp:build --skipNxCache"
  exit 1
fi

# Ensure container is running
if ! docker compose ps --status running | grep -q tracer; then
  echo "Starting tracer container..."
  docker compose up -d
  echo "Installing dependencies (first run may take a few minutes)..."
  docker compose exec tracer bash -c "CI=true pnpm install 2>&1 | tail -5"
fi

# Verify tracer script is mounted (recreate container if not)
if ! docker compose exec tracer test -f /tracer/tracer-nx.mjs 2>/dev/null; then
  echo "Tracer script not mounted, recreating container..."
  docker compose down
  docker compose up -d
  echo "Installing dependencies..."
  docker compose exec tracer bash -c "CI=true pnpm install 2>&1 | tail -5"
fi

# Run the tracer
docker compose exec tracer node /tracer/tracer-nx.mjs "$@"
EOF
chmod +x "$TRACER_DIR/trace.sh"

# Create README with usage instructions
cat > "$TRACER_DIR/README.md" << 'EOF'
# Nx I/O Tracer

Traces file I/O during Nx task execution and compares against declared `inputs`/`outputs`.

## Quick Start

```bash
# 1. Start the container
docker compose up -d

# 2. Install dependencies (first time only, may take a few minutes)
docker compose exec tracer pnpm install

# 3. Trace a task
./trace.sh <project>:<target> --skipNxCache
```

## Examples

```bash
./trace.sh myapp:build --skipNxCache
./trace.sh mylib:test --skipNxCache
```

> Always use `--skipNxCache` to ensure the task runs. Cached tasks have no I/O to trace.

## Managing the Container

```bash
# Stop container
docker compose down

# Stop and remove volumes (clears node_modules, pnpm store, nx cache)
docker compose down -v

# Shell into container
docker compose exec tracer bash
```

## How It Works

1. Fetches resolved inputs using Nx's HashPlanInspector
2. Traces all file I/O during task execution (strace)
3. Compares actual I/O against declared inputs/outputs
4. Reports mismatches (undeclared reads/writes)
EOF

# Start the container and install dependencies
echo ""
echo "Building and starting container..."
cd "$TRACER_DIR"
docker compose up -d --build

echo ""
echo "Installing dependencies (this may take a few minutes on first run)..."
docker compose exec tracer bash -c "CI=true pnpm install 2>&1 | tail -10"

echo ""
echo "============================================================"
echo "Installation complete! Ready to use."
echo "============================================================"
echo ""
echo "Run a trace:"
echo "  cd $TRACER_DIR"
echo "  ./trace.sh <project>:<target> --skipNxCache"
echo ""
echo "Or with isolated task (no dependencies):"
echo "  ./trace.sh <project>:<target> --skipNxCache --excludeTaskDependencies"
echo ""
echo "To stop:"
echo "  cd $TRACER_DIR && docker compose down"
echo ""
echo "To remove volumes (clears node_modules, pnpm store, nx cache):"
echo "  docker compose down -v"
