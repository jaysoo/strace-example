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
    # Java 17 and 21 (for Gradle/Nx Gradle plugin - projects may require different versions)
    openjdk-17-jdk \
    openjdk-21-jdk \
    # Maven
    maven \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set JAVA_HOME to Java 17 by default (more widely compatible)
# Architecture-agnostic: find the actual path
RUN ln -s /usr/lib/jvm/java-17-openjdk-* /usr/lib/jvm/java-17-openjdk
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# Install Node.js 24
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm

# Install Rust (needed for native nx modules)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /workspace

CMD ["/bin/bash"]
