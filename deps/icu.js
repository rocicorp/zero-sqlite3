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

// An include dir is only useful if the ICU headers are actually under it
// (<dir>/unicode/utypes.h). Validating this lets us reject a misconfigured
// pkg-config .pc and fall through to another discovery method, instead of
// emitting a bogus path that fails later with a confusing missing-header error.
function hasIcuHeaders(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'unicode', 'utypes.h'));
}

function fail(message) {
  process.stderr.write(`deps/icu.js: ${message}\n`);
  process.exit(1);
}

// Locate the ICU lib and include directories. Returns {libDir, includeDir}.
function locate() {
  if (process.env.ICU_ROOT) {
    const root = process.env.ICU_ROOT;
    return {libDir: path.join(root, 'lib'), includeDir: path.join(root, 'include')};
  }

  // pkg-config (Debian's libicu-dev and Alpine's icu-dev ship icu-i18n.pc).
  // Require both the lib dir and the actual ICU headers before trusting it.
  const pcLibDir = run('pkg-config --variable=libdir icu-i18n');
  const pcIncDir = run('pkg-config --variable=includedir icu-i18n');
  if (pcLibDir && fs.existsSync(pcLibDir) && hasIcuHeaders(pcIncDir)) {
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
  const includeDir = ['/usr/include', '/usr/local/include'].find(hasIcuHeaders) || '';
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
    } else if (process.env.ICU_ALLOW_DYNAMIC === '1') {
      // Opt-in dynamic fallback for local dev on machines without the static
      // archives. Never used for shipped prebuilds, which must be self-contained.
      process.stderr.write(
        `deps/icu.js: static archive ${name}.a not found in ${loc.libDir || '(unknown)'}; ` +
          `ICU_ALLOW_DYNAMIC=1 set, falling back to dynamic -l${name.replace(/^lib/, '')}\n`,
      );
      out.push('-l' + name.replace(/^lib/, ''));
    } else {
      // Refuse to silently produce a dynamically-linked binary: zero-cache ships
      // these prebuilds onto runtime images (e.g. Alpine) that have no ICU, where
      // a dynamic ICU dependency would only fail at load time.
      fail(
        `static ICU archive ${name}.a not found in ${loc.libDir || '(unknown library dir)'}.\n` +
          `  Prebuilt binaries must statically link ICU to stay self-contained, so the build is\n` +
          `  aborting rather than linking ICU dynamically. Install the static ICU libraries\n` +
          `  (libicu-dev on Debian, icu-dev + icu-static on Alpine, icu4c via Homebrew on macOS),\n` +
          `  or set ICU_ALLOW_DYNAMIC=1 to allow a dynamic fallback for local development.`,
      );
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
  if (!hasIcuHeaders(loc.includeDir)) {
    fail(
      `could not find the ICU headers (unicode/utypes.h) in ${loc.includeDir || '(unknown include dir)'}.\n` +
        `  Install the ICU development package (libicu-dev on Debian, icu-dev on Alpine,\n` +
        `  icu4c via Homebrew on macOS), or set ICU_ROOT to an ICU install prefix.`,
    );
  }
  process.stdout.write(loc.includeDir);
} else {
  process.stdout.write(libsOutput(loc).join('\n'));
}
