This is a fork of [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) with changes needed by [Zero](https://zerosync.dev/).

So far the changes are:

* Build the [bedrock](https://sqlite.org/src/timeline?r=bedrock) branch of SQLite to enable [`begin concurrent`](https://www.sqlite.org/src/doc/begin-concurrent/doc/begin_concurrent.md).
* Create a shell too, so we can debug db files created
* Supports both Node.js (20.x, 22.x, 23.x, 24.x) and Bun (>=1.1.0) runtimes

Other changes will be likely be made over time.
