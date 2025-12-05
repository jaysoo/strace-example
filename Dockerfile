# Dockerfile for eBPF I/O tracing PoC
# Uses Ubuntu with bpftrace, strace, and full nx repo dependencies

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    bpftrace \
    strace \
    curl \
    procps \
    git \
    build-essential \
    # Java 21 (for Gradle/Nx Gradle plugin)
    openjdk-21-jdk \
    # Maven
    maven \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set JAVA_HOME (auto-detect architecture)
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-arm64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm

# Install Rust (needed for native nx modules)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /workspace

CMD ["/bin/bash"]
