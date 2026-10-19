// The column names of a statement, cached across calls so that building object
// rows doesn't re-internalize them for every row. Names only change when SQLite
// re-prepares the statement (e.g. after a schema change behind `SELECT *`), so
// the cache is refreshed when the re-prepare count or the column count changes.
//
// When it can, it also caches a v8::DictionaryTemplate for the names. Objects
// made from it have fast properties and share a hidden class, while
// v8::Object::New() makes dictionary-mode objects, which are slower to create
// and to read. Creating the template costs about as much as building 10-20
// rows with v8::Object::New(), so it is only created once the statement has
// built kRowsBeforeTemplate object rows.
class ColumnKeys {
public:

	static constexpr int kRowsBeforeTemplate = 16;

	explicit ColumnKeys() : reprepares(-1) {}

	// Must be called after sqlite3_step(), which is where re-preparing happens.
	void Get(v8::Isolate* isolate, sqlite3_stmt* handle, v8::LocalVector<v8::Name>& out) {
		const int count = sqlite3_column_count(handle);
		const int current = sqlite3_stmt_status(handle, SQLITE_STMTSTATUS_REPREPARE, 0);
		if (current != reprepares || static_cast<int>(keys.size()) != count) {
			Refresh(isolate, handle, count);
			reprepares = current;
		}
		out.clear();
		out.reserve(count);
		for (const v8::Global<v8::Name>& key : keys) {
			out.emplace_back(key.Get(isolate));
		}
	}

	// Called for each object row built with the names last returned by Get().
	// Returns the template for those names, creating it once enough rows have
	// been built. Returns an empty handle before then, or if the names can't
	// be used for a template.
	v8::Local<v8::DictionaryTemplate> TemplateForRow(v8::Isolate* isolate) {
		if (dictionary_template.IsEmpty() && !names.empty() && ++rows >= kRowsBeforeTemplate) {
			std::vector<std::string_view> views(names.begin(), names.end());
			dictionary_template.Reset(isolate, v8::DictionaryTemplate::New(isolate,
				v8::MemorySpan<const std::string_view>(views.data(), views.size())
			));
			names.clear();
		}
		return dictionary_template.Get(isolate);
	}

private:

	void Refresh(v8::Isolate* isolate, sqlite3_stmt* handle, int count) {
		keys.clear();
		keys.reserve(count);
		names.clear();
		names.reserve(count);
		for (int i = 0; i < count; ++i) {
			const char* name = sqlite3_column_name(handle, i);
			keys.emplace_back(isolate, InternalizedFromUtf8(isolate, name, -1).As<v8::Name>());
			names.emplace_back(name);
		}
		dictionary_template.Reset();
		rows = 0;
		if (!CanUseTemplate(names)) names.clear();
	}

	// v8::DictionaryTemplate reads names as Latin-1, so non-ASCII UTF-8 names
	// would be garbled, and it crashes on duplicate names and on names that are
	// array indices. Rows with such names are built with v8::Object::New().
	static bool CanUseTemplate(const std::vector<std::string>& names) {
		std::set<std::string_view> seen;
		for (const std::string& name : names) {
			for (const char c : name) {
				if (static_cast<unsigned char>(c) >= 0x80) return false;
			}
			if (IsArrayIndex(name) || !seen.insert(name).second) return false;
		}
		return true;
	}

	// Whether `name` is the canonical string of an integer in [0, 2^32 - 2].
	static bool IsArrayIndex(const std::string& name) {
		if (name.empty() || name.size() > 10) return false;
		if (name.size() > 1 && name[0] == '0') return false;
		uint64_t value = 0;
		for (const char c : name) {
			if (c < '0' || c > '9') return false;
			value = value * 10 + static_cast<uint64_t>(c - '0');
		}
		return value <= 4294967294u;
	}

	std::vector<v8::Global<v8::Name>> keys;
	// The names to create the template from; empty once it is created, or if
	// they can't be used for one.
	std::vector<std::string> names;
	v8::Global<v8::DictionaryTemplate> dictionary_template;
	int rows = 0;
	int reprepares;
};
