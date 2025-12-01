LazyRow::LazyRow(LazyColumnIterator* iter) :
	node::ObjectWrap(),
	iterator(iter),
	generation(0) {}

LazyRow::~LazyRow() {}

INIT(LazyRow::Init) {
	v8::Local<v8::FunctionTemplate> t = NewConstructorTemplate(isolate, data, JS_new, "LazyRow");
	SetPrototypeMethod(isolate, data, t, "getColumnByIndex", JS_getColumnByIndex);
	SetPrototypeMethod(isolate, data, t, "getColumnByName", JS_getColumnByName);
	SetPrototypeMethod(isolate, data, t, "_getGeneration", JS_getGeneration);
	SetPrototypeGetter(isolate, data, t, "columnCount", JS_columnCount);
	return t->GetFunction(OnlyContext).ToLocalChecked();
}

NODE_METHOD(LazyRow::JS_new) {
	UseAddon;
	if (!addon->lazy_row_iterator) return ThrowTypeError("Disabled constructor");
	assert(info.IsConstructCall());

	LazyRow* row = new LazyRow(addon->lazy_row_iterator);
	row->Wrap(info.This());
	info.GetReturnValue().Set(info.This());
}

NODE_METHOD(LazyRow::JS_getColumnByIndex) {
	LazyRow* row = Unwrap<LazyRow>(info.This());

	// Check validity
	if (!row->iterator->IsRowValid(row->generation)) {
		return ThrowTypeError("Row is no longer valid (statement has been stepped or closed)");
	}

	REQUIRE_ARGUMENT_INT32(first, int index);

	int column_count = row->iterator->GetColumnCount();
	if (index < 0 || index >= column_count) {
		return ThrowRangeError("Column index out of range");
	}

	UseIsolate;
	v8::Local<v8::Value> value = Data::GetValueJS(
		isolate,
		row->iterator->GetHandle(),
		index,
		row->iterator->GetSafeInts()
	);

	info.GetReturnValue().Set(value);
}

NODE_METHOD(LazyRow::JS_getColumnByName) {
	LazyRow* row = Unwrap<LazyRow>(info.This());

	// Check validity
	if (!row->iterator->IsRowValid(row->generation)) {
		return ThrowTypeError("Row is no longer valid (statement has been stepped or closed)");
	}

	REQUIRE_ARGUMENT_STRING(first, v8::Local<v8::String> name);

	UseIsolate;
	int index = row->iterator->GetColumnIndex(isolate, name);

	if (index < 0) {
		return ThrowRangeError("Column name not found");
	}

	v8::Local<v8::Value> value = Data::GetValueJS(
		isolate,
		row->iterator->GetHandle(),
		index,
		row->iterator->GetSafeInts()
	);

	info.GetReturnValue().Set(value);
}

NODE_GETTER(LazyRow::JS_columnCount) {
	LazyRow* row = Unwrap<LazyRow>(info.This());
	// columnCount is always valid since it's constant for the statement
	info.GetReturnValue().Set(row->iterator->GetColumnCount());
}

NODE_METHOD(LazyRow::JS_getGeneration) {
	LazyRow* row = Unwrap<LazyRow>(info.This());
	info.GetReturnValue().Set(row->generation);
}
