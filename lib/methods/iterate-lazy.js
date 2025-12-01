'use strict';

// Creates a row prototype with getters for each column
function createRowPrototype(columns) {
	const proto = {};

	// Add getColumnByIndex - delegates to the underlying lazyRow
	proto.getColumnByIndex = function(index) {
		return this._lazyRow.getColumnByIndex(index);
	};

	// Add columnCount getter
	Object.defineProperty(proto, 'columnCount', {
		get() {
			return this._lazyRow.columnCount;
		},
		enumerable: true,
		configurable: false,
	});

	// Add property getters for each column
	for (let i = 0; i < columns.length; i++) {
		const columnName = columns[i].name;
		const columnIndex = i;

		Object.defineProperty(proto, columnName, {
			get() {
				// 'this' is the PropertyRow instance
				const cache = this._cache;
				const currentGen = this._lazyRow._getGeneration();

				// Check if cached value is valid
				if (cache.generation === currentGen && columnIndex in cache.values) {
					return cache.values[columnIndex];
				}

				// Clear cache if generation changed
				if (cache.generation !== currentGen) {
					cache.values = {};
					cache.generation = currentGen;
				}

				// Fetch value and cache it
				const value = this._lazyRow.getColumnByIndex(columnIndex);
				cache.values[columnIndex] = value;
				return value;
			},
			enumerable: true,
			configurable: false,
		});
	}

	return proto;
}

// Wrapper iterator that yields PropertyRow objects
function createLazyIterator(stmt, params) {
	const nativeIterator = stmt._nativeIterateWithLazyColumns(...params);
	const columns = stmt.columns();

	let rowPrototype = null;
	let propertyRow = null;

	return {
		next() {
			const result = nativeIterator.next();
			if (result.done) {
				// Invalidate the cache so property access throws after iteration completes
				if (propertyRow !== null) {
					propertyRow._cache.generation = -1;
				}
				return result;
			}

			const lazyRow = result.value;

			// Create prototype on first row (lazy)
			if (rowPrototype === null) {
				rowPrototype = createRowPrototype(columns);
			}

			// Reuse single PropertyRow object (zero allocation after first)
			if (propertyRow === null) {
				propertyRow = Object.create(rowPrototype);
				propertyRow._lazyRow = lazyRow;
				propertyRow._cache = { generation: 0, values: {} };
			}

			// Clear cache for new row
			const currentGen = lazyRow._getGeneration();
			if (propertyRow._cache.generation !== currentGen) {
				propertyRow._cache.values = {};
				propertyRow._cache.generation = currentGen;
			}

			return { value: propertyRow, done: false };
		},

		return() {
			// Invalidate the cache so property access throws after iterator closes
			if (propertyRow !== null) {
				propertyRow._cache.generation = -1;
			}
			return nativeIterator.return();
		},

		[Symbol.iterator]() {
			return this;
		}
	};
}

module.exports = function iterateWithLazyColumns(...params) {
	return createLazyIterator(this, params);
};
