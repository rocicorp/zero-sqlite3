// The column names of a statement as internalized strings, cached across calls
// so that building object rows doesn't re-internalize them for every row.
// Names only change when SQLite re-prepares the statement (e.g. after a schema
// change behind `SELECT *`), so the cache is refreshed when the re-prepare
// count or the column count changes.
class ColumnKeys {
public:

	explicit ColumnKeys() : reprepares(-1) {}

	// Must be called after sqlite3_step(), which is where re-preparing happens.
	void Get(v8::Isolate* isolate, sqlite3_stmt* handle, v8::LocalVector<v8::Name>& out) {
		const int count = sqlite3_column_count(handle);
		const int current = sqlite3_stmt_status(handle, SQLITE_STMTSTATUS_REPREPARE, 0);
		if (current != reprepares || static_cast<int>(keys.size()) != count) {
			keys.clear();
			keys.reserve(count);
			for (int i = 0; i < count; ++i) {
				keys.emplace_back(isolate,
					InternalizedFromUtf8(isolate, sqlite3_column_name(handle, i), -1).As<v8::Name>()
				);
			}
			reprepares = current;
		}
		out.clear();
		out.reserve(count);
		for (const v8::Global<v8::Name>& key : keys) {
			out.emplace_back(key.Get(isolate));
		}
	}

private:
	std::vector<v8::Global<v8::Name>> keys;
	int reprepares;
};
