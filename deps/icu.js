'use strict';

// ===
// ICU discovery helper for node-gyp.
//
// Defining SQLITE_ENABLE_ICU compiles SQLite's bundled ICU extension (already
// present in the amalgamation, guarded by #ifdef SQLITE_ENABLE_ICU) and
// auto-registers Unicode-aware LIKE/upper()/lower()/REGEXP on every
// connection. That code calls into ICU.
//
// We STATIC-link ICU where we can, so the prebuilt .node stays self-contained.
// That is only possible where the ICU static archives are position-independent
// (-fPIC) and can be linked into a shared object (the .node) — which in practice
// is ONLY macOS (Homebrew). Both Linux flavors ship NON-PIC static archives:
// Debian/Ubuntu (glibc) AND Alpine (musl) both fail with "recompile with -fPIC".
// So on every Linux we link ICU dynamically against the system .so, and the
// consumer must have ICU installed at runtime (e.g. `apk add icu-libs` in the
// zero-cache Alpine image). See `useStatic` below.
//
// Usage:
//   node icu.js include   -> the ICU include directory (for #include <unicode/...>)
//   node icu.js libs       -> newline-separated linker inputs (static archive
//                             paths or -L/-l flags), then the C++ runtime /
//                             system libraries ICU depends on.
//
// Discovery order: pkg-config (Linux) -> Homebrew icu4c (macOS) -> common system
// locations. Set ICU_ROOT to override (expects ICU_ROOT/lib and ICU_ROOT/include).
//
// ICU is not enabled on Windows (see deps/sqlite3.gyp), so this script only
// ever runs on macOS and Linux.
// ===

const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const isMac = process.platform === 'darwin';

// Static-link ICU only on macOS, the one platform whose static archives are
// -fPIC and so can be linked into the .node shared object. Both Debian/Ubuntu
// (glibc) and Alpine (musl) ship NON-PIC static archives (libicu*.a) that fail
// with "relocation ... can not be used when making a shared object; recompile
// with -fPIC", so on all Linux we link ICU dynamically against the system .so
// and the consumer must have ICU at runtime. ICU_ALLOW_DYNAMIC=1 forces dynamic
// even on macOS, as a local-dev escape hatch.
const useStatic = isMac && process.env.ICU_ALLOW_DYNAMIC !== '1';

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

// Full paths to the ICU static archives, so the linker pulls them in
// statically and the resulting binary stays self-contained.
function staticLibInputs(loc) {
  return ARCHIVE_NAMES.map(name => {
    const full = loc.libDir && path.join(loc.libDir, name + '.a');
    if (full && fs.existsSync(full)) {
      return full;
    }
    // macOS is the only static platform; a missing archive is fatal here (we
    // must not silently fall back to a dynamic build that would change the
    // shipped binary's behavior).
    fail(
      `static ICU archive ${name}.a not found in ${loc.libDir || '(unknown library dir)'}.\n` +
        `  macOS links ICU statically to stay self-contained, so the build is aborting rather\n` +
        `  than linking ICU dynamically. Install icu4c via Homebrew (brew install icu4c), or\n` +
        `  set ICU_ALLOW_DYNAMIC=1 to allow a dynamic fallback for local development.`,
    );
    return null; // unreachable; fail() exits
  });
}

// Ordinary -l flags, resolved against the system ICU shared libraries. Used on
// glibc Linux (Debian/Ubuntu), whose static archives are not -fPIC and so can't
// be linked into a shared object; the consumer must have ICU at runtime.
function dynamicLibInputs(loc) {
  const out = [];
  if (loc.libDir) {
    out.push('-L' + loc.libDir);
  }
  for (const name of ARCHIVE_NAMES) {
    out.push('-l' + name.replace(/^lib/, ''));
  }
  return out;
}

function libsOutput(loc) {
  const out = useStatic ? staticLibInputs(loc) : dynamicLibInputs(loc);
  // C++ runtime + system libraries that ICU depends on.
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
