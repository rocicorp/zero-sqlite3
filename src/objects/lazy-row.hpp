class LazyRow : public node::ObjectWrap {
public:

	~LazyRow();

	static INIT(Init);

	// Called by LazyColumnIterator to update row generation
	inline void SetGeneration(uint32_t gen) { generation = gen; }

private:
	friend class LazyColumnIterator;

	explicit LazyRow(LazyColumnIterator* iter);

	static NODE_METHOD(JS_new);
	static NODE_METHOD(JS_getColumnByIndex);
	static NODE_METHOD(JS_getColumnByName);
	static NODE_GETTER(JS_columnCount);

	LazyColumnIterator* const iterator;
	uint32_t generation;
};
