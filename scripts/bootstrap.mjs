#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeMajor = Number(process.versions.node.split('.')[0]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
  fail(`OpenAgenticOS needs Node.js 22+. Current Node: ${process.version}`);
}

for (const dir of ['data', 'logs']) fs.mkdirSync(path.join(ROOT, dir), { recursive: true });

const envPath = path.join(ROOT, '.env');
const examplePath = path.join(ROOT, '.env.example');
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(examplePath, envPath);
  console.log('Created .env from .env.example');
} else {
  console.log('.env already exists; left it unchanged');
}

const seed = spawnSync(process.execPath, [
  '--experimental-sqlite',
  '--disable-warning=ExperimentalWarning',
  path.join(ROOT, 'scripts', 'seed-demo.mjs'),
], { cwd: ROOT, stdio: 'inherit' });

if (seed.status !== 0) process.exit(seed.status || 1);

console.log('');
console.log('OpenAgenticOS is ready.');
console.log('Run: npm start');
console.log('Open: http://127.0.0.1:4100/#/agent-os');
