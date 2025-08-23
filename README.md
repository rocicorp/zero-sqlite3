This is a fork of [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) with changes needed by [Zero](https://zerosync.dev/).

So far the changes are:

* Build the [bedrock](https://sqlite.org/src/timeline?r=bedrock) branch of SQLite to enable [`begin concurrent`](https://www.sqlite.org/src/doc/begin-concurrent/doc/begin_concurrent.md).
* Create a shell too, so we can debug db files created

Other changes will be likely be made over time.

## Environment Variables

### `ZERO_SKIP_SQLITE3_BUILD`

Set `ZERO_SKIP_SQLITE3_BUILD=true` to skip the native module build during installation. This is useful in Docker builds and CI/CD pipelines where:

- The native module is pre-built in a different layer
- Build tools are not available in the runtime environment
- You want to reduce installation time in monorepo setups

Example:
```bash
ZERO_SKIP_SQLITE3_BUILD=true npm install
```

**Warning:** When using this flag, ensure the native module is available through other means (pre-built, copied from another stage, etc.) or the package will not function correctly.
