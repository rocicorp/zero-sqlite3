// Statement#stepIntoStrings(buffer, capacity, ...bindParameters) and
// Statement#closeCursor(): read up to `capacity` rows per call.
//
// Numbers go into `buffer`, an ArrayBuffer or SharedArrayBuffer of at least
// 16 + 9 * capacity * columnCount bytes, laid out as:
//
//   [0, 16)             int32 rowCount, int32 done (1 or 0), int32 columnCount,
//                       int32 reserved (0)
//   [16, +8*R*C)        one 8-byte slot per value, row-major:
//                         INTEGER -> int64, FLOAT -> double,
//                         TEXT/BLOB -> uint32 index into the returned array
//   [16+8*R*C, +R*C)    one tag byte per value (see BatchTag)
//
// TEXT and BLOB values are created natively and returned as one array per call.
//
// Rows are produced as by raw(true); pluck/expand/raw and safeIntegers do not
// apply, since integers are always written as int64.
//
// When a call does not exhaust the result (done is 0) the statement stays
// locked like an open iterate() iterator, and the next stepIntoStrings(buffer,
// capacity) call, with no bind parameters, continues it. closeCursor()
// abandons it. As with an abandoned iterator, a cursor that is never finished
// or closed keeps the statement locked and counts as an open iterator.

namespace Batch {

	enum BatchTag : uint8_t {
		TAG_NULL = 0,
		TAG_INT = 1,
		TAG_FLOAT = 2,
		TAG_TEXT = 3,
		TAG_BLOB = 4,
	};

	static const size_t HEADER = 16;

	struct Layout {
		// Keeps the memory alive for the whole call: a user-defined function
		// runs JavaScript during sqlite3_step(), which could detach the buffer
		// (e.g. with transfer()) and so free its memory.
		std::shared_ptr<v8::BackingStore> store;
		uint8_t* slots;
		uint8_t* tags;
		int32_t* header;
		int columns;

		// Returns false if `buf` is not a (Shared)ArrayBuffer large enough.
		// Resizable ArrayBuffers are rejected, since a user-defined function
		// could shrink one while rows are being written.
		bool Init(v8::Local<v8::Value> buf, int capacity, int columns_) {
			size_t size;
			if (buf->IsArrayBuffer()) {
				v8::Local<v8::ArrayBuffer> ab = buf.As<v8::ArrayBuffer>();
				store = ab->GetBackingStore();
				if (store->IsResizableByUserJavaScript()) return false;
				size = ab->ByteLength();
			} else if (buf->IsSharedArrayBuffer()) {
				// A growable SharedArrayBuffer only grows, in place.
				v8::Local<v8::SharedArrayBuffer> sab = buf.As<v8::SharedArrayBuffer>();
				store = sab->GetBackingStore();
				size = sab->ByteLength();
			} else {
				return false;
			}
			void* data = store->Data();
			const size_t cells = (size_t)capacity * (size_t)columns_;
			if (data == NULL || size < HEADER + cells * 9) return false;
			uint8_t* base = static_cast<uint8_t*>(data);
			header = reinterpret_cast<int32_t*>(base);
			slots = base + HEADER;
			tags = slots + cells * 8;
			columns = columns_;
			return true;
		}
	};

	static inline bool IsAscii(const uint8_t* p, size_t n) {
		uint64_t acc = 0;
		size_t i = 0;
		for (; i + 8 <= n; i += 8) {
			uint64_t w;
			memcpy(&w, p + i, 8);
			acc |= w;
		}
		for (; i < n; ++i) acc |= p[i];
		return (acc & 0x8080808080808080ULL) == 0;
	}

	// Writes the current row at index `row`. Returns false, with a pending
	// exception, if a value could not be converted.
	static inline bool WriteRow(
		v8::Isolate* isolate,
		sqlite3_stmt* handle,
		Layout& l,
		int row,
		v8::LocalVector<v8::Value>& values
	) {
		const int C = l.columns;
		uint8_t* slot = l.slots + (size_t)row * C * 8;
		uint8_t* tag = l.tags + (size_t)row * C;
		for (int i = 0; i < C; ++i, slot += 8) {
			switch (sqlite3_column_type(handle, i)) {
				case SQLITE_INTEGER: {
					sqlite3_int64 v = sqlite3_column_int64(handle, i);
					memcpy(slot, &v, 8);
					tag[i] = TAG_INT;
					break;
				}
				case SQLITE_FLOAT: {
					double v = sqlite3_column_double(handle, i);
					memcpy(slot, &v, 8);
					tag[i] = TAG_FLOAT;
					break;
				}
				case SQLITE_TEXT: {
					const uint8_t* p = sqlite3_column_text(handle, i);
					int n = sqlite3_column_bytes(handle, i);
					v8::MaybeLocal<v8::String> s = IsAscii(p, (size_t)n)
						? v8::String::NewFromOneByte(isolate, p, v8::NewStringType::kNormal, n)
						: v8::String::NewFromUtf8(isolate, reinterpret_cast<const char*>(p), v8::NewStringType::kNormal, n);
					if (s.IsEmpty()) {
						ThrowRangeError("The string is too long to be returned to JavaScript");
						return false;
					}
					uint32_t index[2] = {(uint32_t)values.size(), 0};
					memcpy(slot, index, 8);
					tag[i] = TAG_TEXT;
					values.emplace_back(s.ToLocalChecked());
					break;
				}
				case SQLITE_BLOB: {
					v8::MaybeLocal<v8::Object> b = node::Buffer::Copy(
						isolate,
						static_cast<const char*>(sqlite3_column_blob(handle, i)),
						sqlite3_column_bytes(handle, i)
					);
					if (b.IsEmpty()) return false;
					uint32_t index[2] = {(uint32_t)values.size(), 0};
					memcpy(slot, index, 8);
					tag[i] = TAG_BLOB;
					values.emplace_back(b.ToLocalChecked());
					break;
				}
				default:
					memset(slot, 0, 8);
					tag[i] = TAG_NULL;
					break;
			}
		}
		return true;
	}

}

// Ends an open cursor: resets the statement and releases its lock. Safe to call
// after the database is closed (the handle is then already finalized).
void Statement::CloseCursor() {
	if (!cursor_open) return;
	cursor_open = false;
	locked = false;
	db->GetState()->iterators -= 1;
	if (alive) {
		sqlite3_reset(handle);
		if (!bound) sqlite3_clear_bindings(handle);
	}
}

NODE_METHOD(Statement::JS_stepIntoStrings) {
	Statement* stmt = Unwrap<Statement>(info.This());
	REQUIRE_STATEMENT_RETURNS_DATA();
	sqlite3_stmt* handle = stmt->handle;
	Database* db = stmt->db;
	REQUIRE_DATABASE_OPEN(db->GetState());
	REQUIRE_DATABASE_NOT_BUSY(db->GetState());
	if (info.Length() < 2 || !info[1]->IsInt32() || info[1].As<v8::Int32>()->Value() < 1) {
		return ThrowTypeError("Expected second argument to be a positive 32-bit integer");
	}
	const int capacity = info[1].As<v8::Int32>()->Value();
	Batch::Layout l;
	if (!l.Init(info[0], capacity, sqlite3_column_count(handle))) {
		return ThrowRangeError("Expected first argument to be an ArrayBuffer or SharedArrayBuffer of at least 16 + 9 * capacity * columnCount bytes");
	}
	UseIsolate;

	if (!stmt->cursor_open) {
		REQUIRE_STATEMENT_NOT_LOCKED(stmt);
		if (db->GetState()->iterators == USHRT_MAX) return ThrowRangeError("Too many active database iterators");
		if (!stmt->bound) {
			Binder binder(handle);
			if (!binder.BindFrom(info, 2, stmt)) {
				sqlite3_clear_bindings(handle);
				return;
			}
		} else if (info.Length() > 2) {
			return ThrowTypeError("This statement already has bound parameters");
		}
		if (db->Log(isolate, handle)) {
			if (!stmt->bound) sqlite3_clear_bindings(handle);
			return db->ThrowDatabaseError();
		}
		stmt->cursor_open = true;
		stmt->locked = true;
		db->GetState()->iterators += 1;
	} else if (info.Length() > 2) {
		return ThrowTypeError("Bind parameters can only be given to the stepIntoStrings() call that starts a cursor");
	}

	v8::LocalVector<v8::Value> values(isolate);
	values.reserve((size_t)std::min(capacity, 64) * (size_t)l.columns);
	int rows = 0;
	int status = SQLITE_ROW;
	bool converted = true;
	db->GetState()->busy = true;
	while (rows < capacity && (status = sqlite3_step(handle)) == SQLITE_ROW) {
		if (!(converted = Batch::WriteRow(isolate, handle, l, rows, values))) break;
		++rows;
	}
	db->GetState()->busy = false;

	if (!converted) {
		stmt->CloseCursor();
		return;
	}
	if (status != SQLITE_ROW && status != SQLITE_DONE) {
		stmt->CloseCursor();
		return db->ThrowDatabaseError();
	}
	const bool done = status == SQLITE_DONE;
	if (done) stmt->CloseCursor();
	l.header[0] = rows;
	l.header[1] = done ? 1 : 0;
	l.header[2] = l.columns;
	l.header[3] = 0;
	info.GetReturnValue().Set(v8::Array::New(isolate, values.data(), values.size()));
}

NODE_METHOD(Statement::JS_closeCursor) {
	Statement* stmt = Unwrap<Statement>(info.This());
	REQUIRE_DATABASE_NOT_BUSY(stmt->db->GetState());
	stmt->CloseCursor();
	info.GetReturnValue().Set(info.This());
}
