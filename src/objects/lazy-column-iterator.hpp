class LazyRow;

class LazyColumnIterator : public node::ObjectWrap {
public:

	~LazyColumnIterator();

	static INIT(Init);

	// Called by LazyRow to validate and access data
	inline bool IsRowValid(uint32_t gen) const { return alive && gen == generation; }
	inline sqlite3_stmt* GetHandle() const { return handle; }
	inline bool GetSafeInts() const { return safe_ints; }
	inline int GetColumnCount() const { return column_count; }
	int GetColumnIndex(v8::Isolate* isolate, v8::Local<v8::String> name);

private:
	friend class LazyRow;

	explicit LazyColumnIterator(Statement* stmt, bool bound);

	void Next(NODE_ARGUMENTS info);
	void Return(NODE_ARGUMENTS info);
	void Throw();
	void Cleanup();
	void BuildColumnMap(v8::Isolate* isolate);

	static inline v8::Local<v8::Object> NewRecord(
		v8::Isolate* isolate,
		v8::Local<v8::Context> ctx,
		v8::Local<v8::Value> value,
		Addon* addon,
		bool done
	) {
		v8::Local<v8::Object> record = v8::Object::New(isolate);
		record->Set(ctx, addon->cs.value.Get(isolate), value).FromJust();
		record->Set(ctx, addon->cs.done.Get(isolate), v8::Boolean::New(isolate, done)).FromJust();
		return record;
	}

	static inline v8::Local<v8::Object> DoneRecord(v8::Isolate* isolate, Addon* addon) {
		return NewRecord(isolate, OnlyContext, v8::Undefined(isolate), addon, true);
	}

	static NODE_METHOD(JS_new);
	static NODE_METHOD(JS_next);
	static NODE_METHOD(JS_return);
	static NODE_METHOD(JS_symbolIterator);

	Statement* const stmt;
	sqlite3_stmt* const handle;
	Database::State* const db_state;
	LazyRow* row;
	v8::Global<v8::Object> row_js;

	const bool bound;
	const bool safe_ints;
	const int column_count;
	bool alive;
	bool logged;
	uint32_t generation;
	bool has_column_map;
	std::unordered_map<std::string, int> column_map;
};
