class RowBuilder {
public:

	explicit RowBuilder(
		v8::Isolate* isolate,
		v8::Local<v8::Context> ctx,
		sqlite3_stmt* handle,
		bool safe_ints,
		ColumnKeys* column_keys
	) :
		isolate(isolate),
		ctx(ctx),
		handle(handle),
		column_count(-1),
		safe_ints(safe_ints),
		column_keys(column_keys),
		keys(isolate) {}

	v8::Local<v8::Value> GetRowJS() {
		if (column_count < 0) {
			column_keys->Get(isolate, handle, keys);
			column_count = static_cast<int>(keys.size());
		}
		if (dictionary_template.IsEmpty()) {
			dictionary_template = column_keys->TemplateForRow(isolate);
		}

		if (!dictionary_template.IsEmpty()) {
			template_values.resize(column_count);
			for (int i = 0; i < column_count; ++i) {
				template_values[i] = Data::GetValueJS(isolate, handle, i, safe_ints);
			}
			return dictionary_template->NewInstance(ctx,
				v8::MemorySpan<v8::MaybeLocal<v8::Value>>(template_values.data(), template_values.size())
			);
		}

		v8::LocalVector<v8::Value> values(isolate);
		values.reserve(column_count);
		for (int i = 0; i < column_count; ++i) {
			values.emplace_back(
				Data::GetValueJS(isolate, handle, i, safe_ints)
			);
		}

		return v8::Object::New(isolate,
			GET_PROTOTYPE(v8::Object::New(isolate)),
			keys.data(),
			values.data(),
			column_count
		);
	}

private:
	v8::Isolate* isolate;
	v8::Local<v8::Context> ctx;
	sqlite3_stmt* handle;
	int column_count;
	const bool safe_ints;
	ColumnKeys* const column_keys;
	v8::LocalVector<v8::Name> keys;
	v8::Local<v8::DictionaryTemplate> dictionary_template;
	// Reused across rows. NewInstance() takes MaybeLocal values, for which
	// there is no LocalVector.
	std::vector<v8::MaybeLocal<v8::Value>> template_values;
};
