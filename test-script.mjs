#!/usr/bin/env node
/**
 * Simple test script that reads one file and writes one file.
 * Used to verify eBPF tracing captures file I/O.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Ensure output directory exists
const outputDir = join(__dirname, 'output');
mkdirSync(outputDir, { recursive: true });

// Input and output paths
const inputPath = join(__dirname, 'input.txt');
const inputPath2 = join(__dirname, 'input2.txt');
const outputPath = join(outputDir, 'output.txt');
const outputPath2 = join(outputDir, 'output2.txt');

console.log(`PID: ${process.pid}`);
console.log(`Reading from: ${inputPath}`);
console.log(`Writing to: ${outputPath}`);

// Wait a moment so tracer can attach
await new Promise((resolve) => setTimeout(resolve, 500));

// Read input file
const content = readFileSync(inputPath, 'utf-8');
console.log(`Read content: "${content.trim()}"`);
readFileSync(inputPath2, 'utf-8');

// Transform and write output
const transformed =
  content.toUpperCase() + `\nProcessed at: ${new Date().toISOString()}`;
writeFileSync(outputPath, transformed);
writeFileSync(outputPath2, Date.now() + '\n');
console.log(`Wrote transformed content to output`);

// Wait a moment so tracer captures the write
await new Promise((resolve) => setTimeout(resolve, 500));

console.log('Done!');
