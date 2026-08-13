# ===
# This is the main GYP file, which builds better-sqlite3 with SQLite itself.
# ===

{
  'includes': ['deps/common.gypi'],
  'variables': {
    # Emit "true"/"false" rather than 1/0: gyp converts command output that
    # looks like an integer into a real int, so a later `is_alpine == "1"`
    # string comparison would silently never match.
    'is_alpine%': '<!(test -f /etc/alpine-release && echo true || echo false)',
  },
  'targets': [
    {
      'target_name': 'better_sqlite3',
      'dependencies': ['deps/sqlite3.gyp:sqlite3'],
      'sources': ['src/better_sqlite3.cpp'],
      'cflags_cc': ['-std=c++20'],
      'xcode_settings': {
        'OTHER_CPLUSPLUSFLAGS': ['-std=c++20', '-stdlib=libc++'],
      },
      'msvs_settings': {
        'VCCLCompilerTool': {
          'AdditionalOptions': [
            '/std:c++20',
          ],
        },
      },
      'conditions': [
        ['OS=="linux"', {
          'ldflags': [
            '-Wl,-Bsymbolic',
            '-Wl,--exclude-libs,ALL',
          ],
        }],
      ],
    },
    {
      'target_name': 'zero_sqlite3',
      'conditions': [
        ['is_alpine == "true"', {
          'type': 'none',
          'dependencies': [],
          'sources': [],
        }, {
          'type': 'executable',
          'dependencies': ['deps/sqlite3.gyp:locate_sqlite3'],
          'sources': ['<(SHARED_INTERMEDIATE_DIR)/sqlite3/sqlite3.c', '<(SHARED_INTERMEDIATE_DIR)/sqlite3/shell.c'],
          'include_dirs': ['<(SHARED_INTERMEDIATE_DIR)/sqlite3/'],
          'direct_dependent_settings': {
            'include_dirs': ['<(SHARED_INTERMEDIATE_DIR)/sqlite3/'],
          },
          # gnu99, not "c99 + _POSIX_SOURCE": shell.c needs PATH_MAX and
          # realpath(), which neither glibc nor musl declares under that pair
          # (musl also stops defaulting to _XOPEN_SOURCE 700 once __STRICT_ANSI__
          # or _POSIX_SOURCE is set). gcc <= 13 only warns about the resulting
          # implicit realpath() declaration -- and -w hides that -- so the shell
          # links with a truncated 32-bit return value; gcc >= 14 makes it a hard
          # error that -w does not suppress.
          'cflags': ['-std=gnu99', '-w'],
          'xcode_settings': {
            'OTHER_CFLAGS': ['-std=c99'],
            'WARNING_CFLAGS': ['-w'],
          },
          'conditions': [
            ['sqlite3 == ""', {
              'includes': ['deps/defines.gypi'],
            }, {
              'defines': [
                # This is currently required by better-sqlite3.
                'SQLITE_ENABLE_COLUMN_METADATA',
              ],
            }],
            ['OS=="linux"', {
              'defines':   ['HAVE_READLINE=1'],
              'libraries': ['-lreadline', '-lncurses', '-ldl'],
            }],
            ['OS=="mac"',  {
              'defines':   ['HAVE_EDITLINE=1'],
              'libraries': ['-ledit', '-lncurses'],
            }],
          ],
          'configurations': {
            'Debug': {
              'msvs_settings': { 'VCCLCompilerTool': { 'RuntimeLibrary': 1 } }, # static debug
            },
            'Release': {
              'msvs_settings': { 'VCCLCompilerTool': { 'RuntimeLibrary': 0 } }, # static release
            },
          },
        }]
      ],
    },
  ],
}
