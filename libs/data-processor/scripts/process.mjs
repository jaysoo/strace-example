#!/usr/bin/env node
/**
 * Data processing script that intentionally has undeclared inputs/outputs.
 *
 * DECLARED in project.json:
 *   inputs:  {projectRoot}/data/input.txt
 *   outputs: {projectRoot}/dist/output.txt
 *
 * ACTUAL I/O (intentional mismatches):
 *   reads:   data/input.txt              ✓ declared
 *            undeclared-input.txt        ✗ UNDECLARED
 *   writes:  dist/output.txt             ✓ declared
 *            dist/undeclared-output.txt  ✗ UNDECLARED
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

console.log('=== Data Processor ===');

// Read declared input
const inputPath = join(projectRoot, 'data', 'input.txt');
console.log(`[declared]   Reading: data/input.txt`);
const input = readFileSync(inputPath, 'utf-8');

// Read UNDECLARED input
const undeclaredInputPath = join(projectRoot, 'undeclared-input.txt');
console.log(`[UNDECLARED] Reading: undeclared-input.txt`);
const secret = readFileSync(undeclaredInputPath, 'utf-8');

// Process
const output = `${input.trim()} | secret: ${secret.trim()} | processed: ${new Date().toISOString()}`;

// Write declared output
const outputPath = join(projectRoot, 'dist', 'output.txt');
console.log(`[declared]   Writing: dist/output.txt`);
writeFileSync(outputPath, output);

// Write UNDECLARED output
const distDir = join(projectRoot, 'dist');
mkdirSync(distDir, { recursive: true });
const undeclaredOutputPath = join(distDir, 'undeclared-output.txt');
console.log(`[UNDECLARED] Writing: dist/undeclared-output.txt`);
writeFileSync(undeclaredOutputPath, `Audit: ${output}`);

console.log('=== Done ===');
