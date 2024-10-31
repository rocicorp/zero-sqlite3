# ===
# This configuration defines the differences between Release and Debug builds.
# Some miscellaneous Windows settings are also defined here.
# ===

{
  'variables': {
    'sqlite3%': '',
    'lib_prefix': '',
    'lib_suffix': '',
  },
  'target_defaults': {
    'default_configuration': 'Release',
    'msvs_settings': {
      'VCCLCompilerTool': {
        'ExceptionHandling': 1,
      },
    },
    'conditions': [
      ['OS == "win"', {
        'defines': ['WIN32'],
      }, {
        'libraries': [
          '-licui18n',
          '-licuuc',
          '-licudata',
        ],
      }],
      ['OS == "mac"', {
        'include_dirs': [
          '/usr/local/opt/icu4c/include',
          '/opt/homebrew/opt/icu4c/include'
        ],
        'library_dirs': [
          '/usr/local/opt/icu4c/lib',
          '/opt/homebrew/opt/icu4c/lib'
        ],
      }]
    ],
    'configurations': {
      'Debug': {
        'defines!': [
          'NDEBUG',
        ],
        'defines': [
          'DEBUG',
          '_DEBUG',
          'SQLITE_DEBUG',
          'SQLITE_MEMDEBUG',
          'SQLITE_ENABLE_API_ARMOR',
          'SQLITE_WIN32_MALLOC_VALIDATE',
        ],
        'cflags': [
          '-O0',
        ],
        'xcode_settings': {
          'MACOSX_DEPLOYMENT_TARGET': '10.7',
          'GCC_OPTIMIZATION_LEVEL': '0',
          'GCC_GENERATE_DEBUGGING_SYMBOLS': 'YES',
        },
        'msvs_settings': {
          'VCLinkerTool': {
            'GenerateDebugInformation': 'true',
            'AdditionalDependencies': [
              'icuin.lib',
              'icuuc.lib',
              'icudt.lib',
            ],
            'AdditionalLibraryDirectories': [
              '$(VCPKG_ROOT)/installed/x64-windows/lib',
            ],
          },
          'VCCLCompilerTool': {
            'AdditionalIncludeDirectories': [
              '$(VCPKG_ROOT)/installed/x64-windows/include',
            ],
          },
        },
      },
      'Release': {
        'defines!': [
          'DEBUG',
          '_DEBUG',
        ],
        'defines': [
          'NDEBUG',
        ],
        'cflags': [
          '-O3',
        ],
        'xcode_settings': {
          'MACOSX_DEPLOYMENT_TARGET': '10.7',
          'GCC_OPTIMIZATION_LEVEL': '3',
          'GCC_GENERATE_DEBUGGING_SYMBOLS': 'NO',
          'DEAD_CODE_STRIPPING': 'YES',
          'GCC_INLINES_ARE_PRIVATE_EXTERN': 'YES',
        },
        'msvs_settings': {
          'VCLinkerTool': {
            'AdditionalDependencies': [
              'icuin.lib',
              'icuuc.lib',
              'icudt.lib',
            ],
            'AdditionalLibraryDirectories': [
              '$(VCPKG_ROOT)/installed/x64-windows/lib',
            ],
          },
          'VCCLCompilerTool': {
            'AdditionalIncludeDirectories': [
              '$(VCPKG_ROOT)/installed/x64-windows/include',
            ],
          },
        },
      },
    },
  },
}
