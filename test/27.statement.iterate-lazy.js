'use strict';
const Database = require('../.');

describe('Statement#iterateWithLazyColumns()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.db.prepare("CREATE TABLE entries (a TEXT, b INTEGER, c REAL, d BLOB, e TEXT)").run();
		this.db.prepare("INSERT INTO entries WITH RECURSIVE temp(a, b, c, d, e) AS (SELECT 'foo', 1, 3.14, x'dddddddd', NULL UNION ALL SELECT a, b + 1, c, d, e FROM temp LIMIT 10) SELECT * FROM temp").run();
	});
	afterEach(function () {
		this.db.close();
	});

	it('should throw an exception when used on a statement that returns no data', function () {
		let stmt = this.db.prepare("INSERT INTO entries VALUES ('foo', 1, 3.14, x'dddddddd', NULL)");
		expect(stmt.reader).to.be.false;
		expect(() => stmt.iterateWithLazyColumns()).to.throw(TypeError);

		stmt = this.db.prepare("CREATE TABLE IF NOT EXISTS entries (a TEXT, b INTEGER, c REAL, d BLOB, e TEXT)");
		expect(stmt.reader).to.be.false;
		expect(() => stmt.iterateWithLazyColumns()).to.throw(TypeError);

		stmt = this.db.prepare("BEGIN TRANSACTION");
		expect(stmt.reader).to.be.false;
		expect(() => stmt.iterateWithLazyColumns()).to.throw(TypeError);
	});

	it('should return an iterator over each matching row', function () {
		let count = 0;
		let stmt = this.db.prepare("SELECT * FROM entries ORDER BY rowid");
		expect(stmt.reader).to.be.true;
		expect(stmt.busy).to.be.false;

		const iterator = stmt.iterateWithLazyColumns();
		expect(iterator).to.not.be.null;
		expect(typeof iterator).to.equal('object');
		expect(iterator.next).to.be.a('function');
		expect(iterator.return).to.be.a('function');
		expect(iterator[Symbol.iterator]).to.be.a('function');
		expect(iterator[Symbol.iterator]()).to.equal(iterator);
		expect(stmt.busy).to.be.true;

		for (const row of iterator) {
			count++;
			expect(row.getColumnByIndex(1)).to.equal(count);
			expect(row.getColumnByName('a')).to.equal('foo');
			expect(stmt.busy).to.be.true;
		}
		expect(count).to.equal(10);
		expect(stmt.busy).to.be.false;
	});

	it('should return a LazyRow with correct columnCount', function () {
		const stmt = this.db.prepare("SELECT * FROM entries ORDER BY rowid");
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(row.columnCount).to.equal(5);
			break;
		}
	});

	it('should support getColumnByIndex for all SQLite types', function () {
		const stmt = this.db.prepare("SELECT * FROM entries WHERE b = 1");
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(row.getColumnByIndex(0)).to.equal('foo');           // TEXT
			expect(row.getColumnByIndex(1)).to.equal(1);               // INTEGER
			expect(row.getColumnByIndex(2)).to.equal(3.14);            // REAL
			expect(row.getColumnByIndex(3)).to.deep.equal(Buffer.alloc(4).fill(0xdd)); // BLOB
			expect(row.getColumnByIndex(4)).to.be.null;                // NULL
		}
	});

	it('should support getColumnByName for all columns', function () {
		const stmt = this.db.prepare("SELECT * FROM entries WHERE b = 1");
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(row.getColumnByName('a')).to.equal('foo');
			expect(row.getColumnByName('b')).to.equal(1);
			expect(row.getColumnByName('c')).to.equal(3.14);
			expect(row.getColumnByName('d')).to.deep.equal(Buffer.alloc(4).fill(0xdd));
			expect(row.getColumnByName('e')).to.be.null;
		}
	});

	it('should reuse the same row object across iterations (zero allocation)', function () {
		const stmt = this.db.prepare("SELECT * FROM entries ORDER BY rowid");
		let firstRow = null;
		let sameObject = true;
		for (const row of stmt.iterateWithLazyColumns()) {
			if (firstRow === null) {
				firstRow = row;
			} else if (row !== firstRow) {
				sameObject = false;
			}
		}
		expect(sameObject).to.be.true;
	});

	it('should update the row data when the iterator advances (same object)', function () {
		const stmt = this.db.prepare("SELECT * FROM entries ORDER BY rowid");
		let expectedB = 0;
		for (const row of stmt.iterateWithLazyColumns()) {
			expectedB++;
			// The same row object should now have updated data
			expect(row.getColumnByIndex(1)).to.equal(expectedB);
			expect(row.getColumnByName('b')).to.equal(expectedB);
		}
		expect(expectedB).to.equal(10);
	});

	it('should invalidate the row when the iterator completes', function () {
		const stmt = this.db.prepare("SELECT * FROM entries WHERE b = 1");
		let savedRow = null;
		for (const row of stmt.iterateWithLazyColumns()) {
			savedRow = row;
			expect(row.getColumnByIndex(0)).to.equal('foo');
		}
		// Row should be invalid after iteration completes
		expect(() => savedRow.getColumnByIndex(0)).to.throw(TypeError);
		expect(() => savedRow.getColumnByName('a')).to.throw(TypeError);
	});

	it('should invalidate the row when using break', function () {
		const stmt = this.db.prepare("SELECT * FROM entries ORDER BY rowid");
		let savedRow = null;
		for (const row of stmt.iterateWithLazyColumns()) {
			savedRow = row;
			break;
		}
		// Row should be invalid after break (iterator.return() called)
		expect(() => savedRow.getColumnByIndex(0)).to.throw(TypeError);
	});

	it('should keep columnCount available even on invalid row', function () {
		const stmt = this.db.prepare("SELECT * FROM entries WHERE b = 1");
		let savedRow = null;
		for (const row of stmt.iterateWithLazyColumns()) {
			savedRow = row;
		}
		// columnCount should still work on invalid row
		expect(savedRow.columnCount).to.equal(5);
	});

	it('should throw RangeError for invalid column index', function () {
		const stmt = this.db.prepare("SELECT * FROM entries WHERE b = 1");
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(() => row.getColumnByIndex(-1)).to.throw(RangeError);
			expect(() => row.getColumnByIndex(5)).to.throw(RangeError);
			expect(() => row.getColumnByIndex(100)).to.throw(RangeError);
			break;
		}
	});

	it('should throw RangeError for invalid column name', function () {
		const stmt = this.db.prepare("SELECT * FROM entries WHERE b = 1");
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(() => row.getColumnByName('nonexistent')).to.throw(RangeError);
			expect(() => row.getColumnByName('')).to.throw(RangeError);
			expect(() => row.getColumnByName('A')).to.throw(RangeError); // case sensitive
			break;
		}
	});

	it('should close the iterator when throwing in a for-of loop', function () {
		const err = new Error('foobar');
		const stmt = this.db.prepare("SELECT * FROM entries ORDER BY rowid");
		const iterator = stmt.iterateWithLazyColumns();
		let count = 0;
		expect(() => {
			for (const row of iterator) { ++count; throw err; }
		}).to.throw(err);
		expect(count).to.equal(1);
		expect(iterator.next()).to.deep.equal({ value: undefined, done: true });
		for (const row of iterator) ++count;
		expect(count).to.equal(1);
		for (const row of stmt.iterateWithLazyColumns()) ++count;
		expect(count).to.equal(11);
	});

	it('should close the iterator when using break in a for-of loop', function () {
		const stmt = this.db.prepare("SELECT * FROM entries ORDER BY rowid");
		const iterator = stmt.iterateWithLazyColumns();
		let count = 0;
		for (const row of iterator) { ++count; break; }
		expect(count).to.equal(1);
		expect(iterator.next()).to.deep.equal({ value: undefined, done: true });
		for (const row of iterator) ++count;
		expect(count).to.equal(1);
		for (const row of stmt.iterateWithLazyColumns()) ++count;
		expect(count).to.equal(11);
	});

	it('should return an empty iterator when no rows were found', function () {
		const stmt = this.db.prepare("SELECT * FROM entries WHERE b == 999");
		expect(stmt.iterateWithLazyColumns().next()).to.deep.equal({ value: undefined, done: true });
		for (const row of stmt.iterateWithLazyColumns()) {
			throw new Error('This callback should not have been invoked');
		}
	});

	it('should accept bind parameters', function () {
		const SQL1 = 'SELECT * FROM entries WHERE a=? AND b=? AND c=? AND d=? AND e IS ?';
		const SQL2 = 'SELECT * FROM entries WHERE a=@a AND b=@b AND c=@c AND d=@d AND e IS @e';

		// Test with positional parameters
		let count = 0;
		for (const row of this.db.prepare(SQL1).iterateWithLazyColumns('foo', 1, 3.14, Buffer.alloc(4).fill(0xdd), null)) {
			expect(row.getColumnByName('a')).to.equal('foo');
			expect(row.getColumnByName('b')).to.equal(1);
			count++;
		}
		expect(count).to.equal(1);

		// Test with named parameters
		count = 0;
		for (const row of this.db.prepare(SQL2).iterateWithLazyColumns({ a: 'foo', b: 1, c: 3.14, d: Buffer.alloc(4).fill(0xdd), e: undefined })) {
			expect(row.getColumnByName('a')).to.equal('foo');
			count++;
		}
		expect(count).to.equal(1);

		// Test with no matching rows
		for (const row of this.db.prepare(SQL2).iterateWithLazyColumns({ a: 'foo', b: 1, c: 3.14, d: Buffer.alloc(4).fill(0xaa), e: undefined })) {
			throw new Error('This callback should not have been invoked');
		}

		// Test error cases
		expect(() =>
			this.db.prepare(SQL1).iterateWithLazyColumns()
		).to.throw(RangeError);

		expect(() =>
			this.db.prepare(SQL2).iterateWithLazyColumns()
		).to.throw(TypeError);
	});

	it('should work with RETURNING clause', function () {
		let stmt = this.db.prepare("INSERT INTO entries (a, b) VALUES ('bar', 888), ('baz', 999) RETURNING *");
		expect(stmt.reader).to.be.true;

		const results = [];
		for (const row of stmt.iterateWithLazyColumns()) {
			results.push({
				a: row.getColumnByName('a'),
				b: row.getColumnByName('b'),
			});
		}
		expect(results).to.deep.equal([
			{ a: 'bar', b: 888 },
			{ a: 'baz', b: 999 },
		]);
	});

	it('should work with column aliases', function () {
		const stmt = this.db.prepare("SELECT a AS name, b AS id FROM entries WHERE b = 1");
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(row.columnCount).to.equal(2);
			expect(row.getColumnByIndex(0)).to.equal('foo');
			expect(row.getColumnByIndex(1)).to.equal(1);
			expect(row.getColumnByName('name')).to.equal('foo');
			expect(row.getColumnByName('id')).to.equal(1);
			// Original names should not work
			expect(() => row.getColumnByName('a')).to.throw(RangeError);
			expect(() => row.getColumnByName('b')).to.throw(RangeError);
		}
	});

	it('should work with expressions', function () {
		const stmt = this.db.prepare("SELECT b + 100 AS computed, a || '_suffix' AS concat FROM entries WHERE b = 1");
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(row.getColumnByName('computed')).to.equal(101);
			expect(row.getColumnByName('concat')).to.equal('foo_suffix');
		}
	});

	it('should respect safeIntegers setting', function () {
		this.db.prepare("INSERT INTO entries VALUES ('big', 9007199254740993, 0, NULL, NULL)").run();
		const stmt = this.db.prepare("SELECT b FROM entries WHERE a = 'big'");

		// Without safeIntegers - loses precision
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(typeof row.getColumnByIndex(0)).to.equal('number');
		}

		// With safeIntegers - returns BigInt
		stmt.safeIntegers(true);
		for (const row of stmt.iterateWithLazyColumns()) {
			expect(typeof row.getColumnByIndex(0)).to.equal('bigint');
			expect(row.getColumnByIndex(0)).to.equal(9007199254740993n);
		}
	});
});
