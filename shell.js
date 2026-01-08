#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const binaryName = process.platform === 'win32' ? 'zero_sqlite3.exe' : 'zero_sqlite3';
const binary = path.join(__dirname, 'build', 'Release', binaryName);

if (!fs.existsSync(binary)) {
  console.error(`Error: Binary not found at ${binary}`);
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
