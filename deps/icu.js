'use strict';

// ===
// ICU discovery helper for node-gyp — STATIC linking.
//
// Defining SQLITE_ENABLE_ICU compiles SQLite's bundled ICU extension (already
// present in the amalgamation, guarded by #ifdef SQLITE_ENABLE_ICU) and
// auto-registers Unicode-aware LIKE/upper()/lower()/REGEXP on every
// connection. That code calls into ICU.
//
// We link ICU *statically* so the prebuilt .node binaries stay self-contained:
// zero-cache ships them via prebuild-install onto runtime images (e.g. Alpine)
// that do not have ICU installed, and a dynamic NEEDED libicu*.so.<ver> would
// fail to load there (and couples the binary to one ICU soname). Static
// linking embeds ICU into the binary instead.
//
// Usage:
//   node icu.js include   -> the ICU include directory (for #include <unicode/...>)
//   node icu.js libs       -> newline-separated linker inputs: full paths to the
//                             ICU static archives, then the C++ runtime / system
//                             libraries those archives require.
//
// Discovery order: pkg-config (Linux/Alpine) -> Homebrew icu4c (macOS) ->
// common system locations. Set ICU_ROOT to override (expects ICU_ROOT/lib and
// ICU_ROOT/include).
//
// ICU is not enabled on Windows (see deps/sqlite3.gyp), so this script only
// ever runs on macOS and Linux.
// ===

const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const isMac = process.platform === 'darwin';

function run(cmd) {
  try {
    return execSync(cmd, {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
  } catch {
    return '';
  }
}

function firstDir(candidates) {
  return candidates.find(p => p && fs.existsSync(p)) || '';
}

// Locate the ICU lib and include directories. Returns {libDir, includeDir}.
function locate() {
  if (process.env.ICU_ROOT) {
    const root = process.env.ICU_ROOT;
    return {libDir: path.join(root, 'lib'), includeDir: path.join(root, 'include')};
  }

  // pkg-config (Debian's libicu-dev and Alpine's icu-dev ship icu-i18n.pc).
  const pcLibDir = run('pkg-config --variable=libdir icu-i18n');
  const pcIncDir = run('pkg-config --variable=includedir icu-i18n');
  if (pcLibDir && fs.existsSync(pcLibDir)) {
    return {libDir: pcLibDir, includeDir: pcIncDir};
  }

  // Homebrew icu4c (macOS, keg-only so not on default search paths).
  if (isMac) {
    let prefix = run('brew --prefix icu4c');
    if (!prefix || !fs.existsSync(prefix)) {
      prefix = firstDir(['/opt/homebrew/opt/icu4c', '/usr/local/opt/icu4c']);
    }
    if (prefix) {
      return {libDir: path.join(prefix, 'lib'), includeDir: path.join(prefix, 'include')};
    }
  }

  // Common system locations (Debian multiarch, Alpine, manual installs).
  const libDir = firstDir([
    '/usr/lib/x86_64-linux-gnu',
    '/usr/lib/aarch64-linux-gnu',
    '/usr/lib/arm-linux-gnueabihf',
    '/usr/lib',
    '/usr/local/lib',
  ]);
  const includeDir = firstDir(['/usr/include', '/usr/local/include']);
  return {libDir, includeDir};
}

// ICU static archives, in dependency order (i18n -> uc -> data).
const ARCHIVE_NAMES = ['libicui18n', 'libicuuc', 'libicudata'];

function libsOutput(loc) {
  const out = [];
  for (const name of ARCHIVE_NAMES) {
    const full = loc.libDir && path.join(loc.libDir, name + '.a');
    if (full && fs.existsSync(full)) {
      out.push(full);
    } else {
      // Fall back to a normal library reference so local dev without the
      // static archives still builds (dynamically). Prebuild CI installs the
      // static libs, so this path is not taken for shipped binaries.
      process.stderr.write(
        `deps/icu.js: static archive ${name}.a not found in ${loc.libDir || '(unknown)'}; ` +
          `falling back to dynamic linking for ${name}\n`,
      );
      out.push('-l' + name.replace(/^lib/, ''));
    }
  }
  // C++ runtime + system libraries required by ICU's (C++) static archives.
  if (isMac) {
    out.push('-lc++');
  } else {
    out.push('-lstdc++', '-lm', '-lpthread', '-ldl');
  }
  return out;
}

const mode = process.argv[2];
const loc = locate();

if (mode === 'include') {
  process.stdout.write(loc.includeDir || '');
} else {
  process.stdout.write(libsOutput(loc).join('\n'));
}
