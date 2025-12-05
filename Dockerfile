# Dockerfile for eBPF I/O tracing PoC
# Uses Ubuntu with bpftrace

FROM ubuntu:22.04

# Install bpftrace, strace, and Node.js
RUN apt-get update && apt-get install -y \
    bpftrace \
    strace \
    curl \
    procps \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["/bin/bash"]
