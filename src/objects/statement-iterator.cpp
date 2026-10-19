StatementIterator::StatementIterator(Statement* stmt, bool bound) :
	node::ObjectWrap(),
	stmt(stmt),
	handle(stmt->handle),
	db_state(stmt->db->GetState()),
	bound(bound),
	safe_ints(stmt->safe_ints),
	mode(stmt->mode),
	alive(true),
	logged(!db_state->has_logger) {
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
StatementIterator::~StatementIterator() {}

void StatementIterator::Next(NODE_ARGUMENTS info) {
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
		info.GetReturnValue().Set(
			NewRecord(isolate, ctx, stmt->GetRowJS(isolate, ctx, safe_ints, mode), db_state->addon, false)
		);
	} else {
		if (status == SQLITE_DONE) Return(info);
		else Throw();
	}
}

// Steps up to max_rows rows in one call. In raw mode the result is one flat
// array of rowCount * columnCount values; in other modes, an array of rows.
// A batch with fewer than max_rows rows is the last one.
void StatementIterator::NextBatch(NODE_ARGUMENTS info, int max_rows) {
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
	UseIsolate;
	UseContext;
	v8::LocalVector<v8::Value> values(isolate);
	const int columns = mode == Data::RAW ? sqlite3_column_count(handle) : 0;
	int rows = 0;
	int status = SQLITE_ROW;
	while (rows < max_rows && (status = sqlite3_step(handle)) == SQLITE_ROW) {
		if (mode == Data::RAW) {
			for (int i = 0; i < columns; ++i) values.emplace_back(Data::GetValueJS(isolate, handle, i, safe_ints));
		} else {
			values.emplace_back(Data::GetRowJS(isolate, ctx, handle, safe_ints, mode));
		}
		++rows;
	}
	db_state->busy = false;
	v8::Local<v8::Array> batch = v8::Array::New(isolate, values.data(), values.size());
	if (status == SQLITE_ROW) info.GetReturnValue().Set(batch);
	else if (status == SQLITE_DONE) { Cleanup(); STATEMENT_RETURN_LOGIC(batch); }
	else Throw();
}

void StatementIterator::Return(NODE_ARGUMENTS info) {
	Cleanup();
	STATEMENT_RETURN_LOGIC(DoneRecord(OnlyIsolate, db_state->addon));
}

void StatementIterator::Throw() {
	Cleanup();
	Database* db = stmt->db;
	STATEMENT_THROW_LOGIC();
}

void StatementIterator::Cleanup() {
	assert(alive == true);
	alive = false;
	stmt->locked = false;
	db_state->iterators -= 1;
	sqlite3_reset(handle);
}

INIT(StatementIterator::Init) {
	v8::Local<v8::FunctionTemplate> t = NewConstructorTemplate(isolate, data, JS_new, "StatementIterator");
	SetPrototypeMethod(isolate, data, t, "next", JS_next);
	SetPrototypeMethod(isolate, data, t, "nextBatch", JS_nextBatch);
	SetPrototypeMethod(isolate, data, t, "restart", JS_restart);
	SetPrototypeMethod(isolate, data, t, "return", JS_return);
	SetPrototypeSymbolMethod(isolate, data, t, v8::Symbol::GetIterator(isolate), JS_symbolIterator);
	return t->GetFunction(OnlyContext).ToLocalChecked();
}

NODE_METHOD(StatementIterator::JS_new) {
	UseAddon;
	if (!addon->privileged_info) return ThrowTypeError("Disabled constructor");
	assert(info.IsConstructCall());

	StatementIterator* iter;
	{
		NODE_ARGUMENTS info = *addon->privileged_info;
		STATEMENT_START_LOGIC(REQUIRE_STATEMENT_RETURNS_DATA, DOES_ADD_ITERATOR);
		iter = new StatementIterator(stmt, bound);
	}
	UseIsolate;
	UseContext;
	iter->Wrap(info.This());
	SetFrozen(isolate, ctx, info.This(), addon->cs.statement, addon->privileged_info->This());

	info.GetReturnValue().Set(info.This());
}

NODE_METHOD(StatementIterator::JS_next) {
	StatementIterator* iter = Unwrap<StatementIterator>(info.This());
	REQUIRE_DATABASE_NOT_BUSY(iter->db_state);
	if (iter->alive) iter->Next(info);
	else info.GetReturnValue().Set(DoneRecord(OnlyIsolate, iter->db_state->addon));
}

NODE_METHOD(StatementIterator::JS_nextBatch) {
	StatementIterator* iter = Unwrap<StatementIterator>(info.This());
	REQUIRE_DATABASE_NOT_BUSY(iter->db_state);
	REQUIRE_ARGUMENT_INT32(first, int max_rows);
	if (max_rows < 1) return ThrowRangeError("Expected first argument to be a positive integer");
	if (iter->alive) iter->NextBatch(info, max_rows);
	else info.GetReturnValue().Set(v8::Array::New(OnlyIsolate, 0));
}

// Runs the statement again, with new bind parameters, reusing this finished
// iterator instead of creating a new one with iterate().
NODE_METHOD(StatementIterator::JS_restart) {
	StatementIterator* iter = Unwrap<StatementIterator>(info.This());
	if (iter->alive) return ThrowTypeError("The iterator must be finished before it is restarted");
	Statement* stmt = iter->stmt;
	sqlite3_stmt* handle = stmt->handle;
	Database* db = stmt->db;
	REQUIRE_DATABASE_OPEN(db->GetState());
	REQUIRE_DATABASE_NOT_BUSY(db->GetState());
	DOES_ADD_ITERATOR();
	if (!stmt->bound) {
		STATEMENT_BIND(handle);
	} else if (info.Length() > 0) {
		return ThrowTypeError("This statement already has bound parameters");
	}
	iter->bound = stmt->bound;
	iter->safe_ints = stmt->safe_ints;
	iter->mode = stmt->mode;
	iter->alive = true;
	iter->logged = !iter->db_state->has_logger;
	stmt->locked = true;
	iter->db_state->iterators += 1;
	info.GetReturnValue().Set(info.This());
}

NODE_METHOD(StatementIterator::JS_return) {
	StatementIterator* iter = Unwrap<StatementIterator>(info.This());
	REQUIRE_DATABASE_NOT_BUSY(iter->db_state);
	if (iter->alive) iter->Return(info);
	else info.GetReturnValue().Set(DoneRecord(OnlyIsolate, iter->db_state->addon));
}

NODE_METHOD(StatementIterator::JS_symbolIterator) {
	info.GetReturnValue().Set(info.This());
}
