'use strict';
// Copies the zero_sqlite3 shell executable produced by node-gyp into the
// prebuilds/<platform>-<arch>/ directory populated by prebuildify, so the
// shell ships inside the npm package next to the prebuilt .node addons
// (prebuildify itself only ships .node files). The shell is a standalone
// C executable, so unlike the addon it is not Node-ABI-specific.
//
// Usage: node deps/copy-shell.js [--arch <arch>]
// --arch is needed for cross-compiled builds (e.g. win32 ia32/arm64), where
// process.arch reports the host arch, not the target arch.
const fs = require('fs');
const path = require('path');

const archFlagIndex = process.argv.indexOf('--arch');
const arch = archFlagIndex === -1 ? process.arch : process.argv[archFlagIndex + 1];
const binaryName = process.platform === 'win32' ? 'zero_sqlite3.exe' : 'zero_sqlite3';
const src = path.join(__dirname, '..', 'build', 'Release', binaryName);
const destDir = path.join(__dirname, '..', 'prebuilds', `${process.platform}-${arch}`);
const dest = path.join(destDir, binaryName);

if (!fs.existsSync(src)) {
	console.error(`copy-shell: ${src} does not exist (was the shell built?)`);
	process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
fs.chmodSync(dest, 0o755);
console.log(`copy-shell: ${src} -> ${dest}`);
