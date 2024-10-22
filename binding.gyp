# ===
# This is the main GYP file, which builds better-sqlite3 with SQLite itself.
# ===

{
  'includes': ['deps/common.gypi'],
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
      'target_name': 'shell',
      'type': 'executable',
      'dependencies': ['deps/sqlite3.gyp:locate_sqlite3'],
      'sources': ['<(SHARED_INTERMEDIATE_DIR)/sqlite3/sqlite3.c', '<(SHARED_INTERMEDIATE_DIR)/sqlite3/shell.c'],
      'include_dirs': ['<(SHARED_INTERMEDIATE_DIR)/sqlite3/'],
      'direct_dependent_settings': {
        'include_dirs': ['<(SHARED_INTERMEDIATE_DIR)/sqlite3/'],
      },
      'cflags': ['-std=c99', '-w'],
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
        }]
      ],
      'configurations': {
        'Debug': {
          'msvs_settings': { 'VCCLCompilerTool': { 'RuntimeLibrary': 1 } }, # static debug
        },
        'Release': {
          'msvs_settings': { 'VCCLCompilerTool': { 'RuntimeLibrary': 0 } }, # static release
        },
      },
    },
    {
      'target_name': 'test_extension',
      'dependencies': ['deps/sqlite3.gyp:sqlite3'],
      'conditions': [['sqlite3 == ""', { 'sources': ['deps/test_extension.c'] }]],
    },
  ],
}
