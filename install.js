#!/usr/bin/env node

/**
 * Install script for @rocicorp/zero-sqlite3
 * 
 * Supports skipping the build process via ZERO_SKIP_SQLITE3_BUILD environment variable.
 * This is useful in Docker builds and CI/CD pipelines where the native module
 * might be pre-built or not needed.
 */

const { execSync } = require('child_process');

if (process.env.ZERO_SKIP_SQLITE3_BUILD === 'true') {
  console.log('[zero-sqlite3] Skipping native build (ZERO_SKIP_SQLITE3_BUILD=true)');
  console.log('[zero-sqlite3] Warning: Native module will not be available unless pre-built');
  process.exit(0);
}

console.log('[zero-sqlite3] Building native module...');

try {
  // Try to download pre-built binaries first
  execSync('prebuild-install', { stdio: 'inherit' });
  console.log('[zero-sqlite3] Successfully installed pre-built binaries');
} catch (error) {
  // Fall back to building from source
  console.log('[zero-sqlite3] Pre-built binaries not available, building from source...');
  try {
    execSync('node-gyp rebuild --release', { stdio: 'inherit' });
    console.log('[zero-sqlite3] Successfully built from source');
  } catch (buildError) {
    console.error('[zero-sqlite3] Failed to build native module');
    process.exit(1);
  }
}