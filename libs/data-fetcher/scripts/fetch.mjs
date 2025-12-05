#!/usr/bin/env node
/**
 * Data Fetcher - Simulates fetching data with intentional I/O mismatches
 *
 * Declared input: data/source.txt
 * Undeclared input: secret-config.txt (NOT in inputs!)
 *
 * Declared output: data/fetched.txt
 * Undeclared output: dist/cache.txt (NOT in outputs!)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Read declared input
const sourceData = readFileSync(join(projectRoot, 'data/source.txt'), 'utf-8');
console.log('[data-fetcher] Read declared input: data/source.txt');

// Read UNDECLARED input (secret config)
const secretConfig = readFileSync(join(projectRoot, 'secret-config.txt'), 'utf-8');
console.log('[data-fetcher] Read UNDECLARED input: secret-config.txt');

// Write declared output
const fetchedContent = `FETCHED: ${sourceData.trim()}\nTimestamp: ${new Date().toISOString()}`;
writeFileSync(join(projectRoot, 'data/fetched.txt'), fetchedContent);
console.log('[data-fetcher] Wrote declared output: data/fetched.txt');

// Write UNDECLARED output (cache file)
mkdirSync(join(projectRoot, 'dist'), { recursive: true });
writeFileSync(join(projectRoot, 'dist/cache.txt'), `Cached at: ${Date.now()}`);
console.log('[data-fetcher] Wrote UNDECLARED output: dist/cache.txt');

console.log('[data-fetcher] Done!');
