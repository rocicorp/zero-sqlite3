#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const binaryName = process.platform === 'win32' ? 'zero_sqlite3.exe' : 'zero_sqlite3';

// Prefer a locally built shell, then fall back to the prebuilt one shipped in
// the npm package (prebuilds/<platform>-<arch>/). No prebuilt shell exists for
// musl (Alpine) because the zero_sqlite3 target is not built there.
const isMusl = process.platform === 'linux' && fs.existsSync('/etc/alpine-release');
const candidates = [path.join(__dirname, 'build', 'Release', binaryName)];
if (!isMusl) {
  candidates.push(path.join(__dirname, 'prebuilds', `${process.platform}-${process.arch}`, binaryName));
}

const binary = candidates.find(fs.existsSync);

if (!binary) {
  console.error(`Error: Binary not found at ${candidates.join(' or ')}`);
  console.error('Please run: npm run build-release');
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });

if (result.error) {
  console.error(`Error executing binary: ${result.error.message}`);
  if (result.error.code === 'ENOEXEC') {
    console.error('The binary may be built for a different platform. Please rebuild with: npm run build-release');
  }
  process.exit(1);
}

process.exit(result.status ?? 1);
