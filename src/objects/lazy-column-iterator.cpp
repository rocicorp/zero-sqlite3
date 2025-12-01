LazyColumnIterator::LazyColumnIterator(Statement* stmt, bool bound) :
	node::ObjectWrap(),
	stmt(stmt),
	handle(stmt->handle),
	db_state(stmt->db->GetState()),
	row(nullptr),
	bound(bound),
	safe_ints(stmt->safe_ints),
	column_count(sqlite3_column_count(stmt->handle)),
	alive(true),
	logged(!db_state->has_logger),
	generation(0),
	has_column_map(false) {
	assert(stmt != NULL);
	assert(handle != NULL);
	assert(stmt->bound == bound);
	assert(stmt->alive == true);
	assert(stmt->locked == false);
	assert(db_state->iterators < USHRT_MAX);
	stmt->locked = true;
	db_state->iterators += 1;
}

// The ~Statement destructor currently covers any state this object creates.
// Additionally, we actually DON'T want to revert stmt->locked or db_state
// ->iterators in this destructor, to ensure deterministic database access.
LazyColumnIterator::~LazyColumnIterator() {}

void LazyColumnIterator::BuildColumnMap(v8::Isolate* isolate) {
	if (has_column_map) return;

	for (int i = 0; i < column_count; ++i) {
		const char* name = sqlite3_column_name(handle, i);
		if (name != NULL) {
			column_map[std::string(name)] = i;
		}
	}
	has_column_map = true;
}

int LazyColumnIterator::GetColumnIndex(v8::Isolate* isolate, v8::Local<v8::String> name) {
	BuildColumnMap(isolate);

	v8::String::Utf8Value utf8(isolate, name);
	auto it = column_map.find(std::string(*utf8));
	if (it != column_map.end()) {
		return it->second;
	}
	return -1;
}

void LazyColumnIterator::Next(NODE_ARGUMENTS info) {
	assert(alive == true);
	db_state->busy = true;
	if (!logged) {
		logged = true;
		if (stmt->db->Log(OnlyIsolate, handle)) {
			db_state->busy = false;
			Throw();
			return;
		}
	}
	int status = sqlite3_step(handle);
	db_state->busy = false;
	if (status == SQLITE_ROW) {
		UseIsolate;
		UseContext;

		// Increment generation - invalidates any previous row access
		generation++;

		// Update row's generation so it's valid for this iteration
		row->SetGeneration(generation);

		// Return the same row JS object
		info.GetReturnValue().Set(
			NewRecord(isolate, ctx, row_js.Get(isolate), db_state->addon, false)
		);
	} else {
		if (status == SQLITE_DONE) Return(info);
		else Throw();
	}
}

void LazyColumnIterator::Return(NODE_ARGUMENTS info) {
	Cleanup();
	STATEMENT_RETURN_LOGIC(DoneRecord(OnlyIsolate, db_state->addon));
}

void LazyColumnIterator::Throw() {
	Cleanup();
	Database* db = stmt->db;
	STATEMENT_THROW_LOGIC();
}

void LazyColumnIterator::Cleanup() {
	assert(alive == true);
	alive = false;
	stmt->locked = false;
	db_state->iterators -= 1;
	sqlite3_reset(handle);
}

INIT(LazyColumnIterator::Init) {
	v8::Local<v8::FunctionTemplate> t = NewConstructorTemplate(isolate, data, JS_new, "LazyColumnIterator");
	SetPrototypeMethod(isolate, data, t, "next", JS_next);
	SetPrototypeMethod(isolate, data, t, "return", JS_return);
	SetPrototypeSymbolMethod(isolate, data, t, v8::Symbol::GetIterator(isolate), JS_symbolIterator);
	return t->GetFunction(OnlyContext).ToLocalChecked();
}

NODE_METHOD(LazyColumnIterator::JS_new) {
	UseAddon;
	if (!addon->privileged_info) return ThrowTypeError("Disabled constructor");
	assert(info.IsConstructCall());

	LazyColumnIterator* iter;
	{
		NODE_ARGUMENTS info = *addon->privileged_info;
		STATEMENT_START_LOGIC(REQUIRE_STATEMENT_RETURNS_DATA, DOES_ADD_ITERATOR);
		iter = new LazyColumnIterator(stmt, bound);
	}
	UseIsolate;
	UseContext;
	iter->Wrap(info.This());
	SetFrozen(isolate, ctx, info.This(), addon->cs.statement, addon->privileged_info->This());

	// Create the single reusable LazyRow instance
	v8::Local<v8::Function> rowConstructor = addon->LazyRow.Get(isolate);

	// Set up for LazyRow constructor
	addon->lazy_row_iterator = iter;
	v8::MaybeLocal<v8::Object> maybeRow = rowConstructor->NewInstance(ctx, 0, NULL);
	addon->lazy_row_iterator = nullptr;

	if (maybeRow.IsEmpty()) {
		// Cleanup on failure
		iter->Cleanup();
		return;
	}

	v8::Local<v8::Object> rowObj = maybeRow.ToLocalChecked();
	iter->row = Unwrap<LazyRow>(rowObj);
	iter->row_js.Reset(isolate, rowObj);

	info.GetReturnValue().Set(info.This());
}

NODE_METHOD(LazyColumnIterator::JS_next) {
	LazyColumnIterator* iter = Unwrap<LazyColumnIterator>(info.This());
	REQUIRE_DATABASE_NOT_BUSY(iter->db_state);
	if (iter->alive) iter->Next(info);
	else info.GetReturnValue().Set(DoneRecord(OnlyIsolate, iter->db_state->addon));
}

NODE_METHOD(LazyColumnIterator::JS_return) {
	LazyColumnIterator* iter = Unwrap<LazyColumnIterator>(info.This());
	REQUIRE_DATABASE_NOT_BUSY(iter->db_state);
	if (iter->alive) iter->Return(info);
	else info.GetReturnValue().Set(DoneRecord(OnlyIsolate, iter->db_state->addon));
}

NODE_METHOD(LazyColumnIterator::JS_symbolIterator) {
	info.GetReturnValue().Set(info.This());
}
