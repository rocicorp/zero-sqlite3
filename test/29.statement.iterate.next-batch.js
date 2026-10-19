'use strict';
const Database = require('../.');

// Drains an iterator with nextBatch(); returns {batches, values}.
function drain(iterator, maxRows, width) {
	const batches = [];
	const values = [];
	for (;;) {
		const batch = iterator.nextBatch(maxRows);
		batches.push(batch.length / width);
		values.push(...batch);
		if (batch.length < maxRows * width) return {batches, values};
	}
}

describe('StatementIterator#nextBatch()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.db.prepare('CREATE TABLE entries (a TEXT, b INTEGER, c REAL, d BLOB, e TEXT)').run();
		this.db.prepare("INSERT INTO entries WITH RECURSIVE temp(a, b, c, d, e) AS (SELECT 'foo', 1, 3.14, x'dddddddd', NULL UNION ALL SELECT a, b + 1, c, d, e FROM temp LIMIT 10) SELECT * FROM temp").run();
	});
	afterEach(function () {
		this.db.close();
	});

	it('should return flat values in raw mode', function () {
		this.db.prepare("INSERT INTO entries VALUES ('héllo ☃', 9223372036854775807, -0.5, x'', 'x')").run();
		const sql = 'SELECT * FROM entries ORDER BY rowid';
		const want = this.db.prepare(sql).raw().safeIntegers().all().flat();
		for (const [maxRows, batches] of [[1, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]], [4, [4, 4, 3]], [11, [11, 0]], [12, [11]], [1000, [11]]]) {
			const stmt = this.db.prepare(sql).raw().safeIntegers();
			const result = drain(stmt.iterate(), maxRows, 5);
			expect(result.values).to.deep.equal(want);
			expect(result.batches).to.deep.equal(batches);
			expect(stmt.busy).to.be.false;
		}
	});
	it('should honor safeIntegers()', function () {
		const stmt = this.db.prepare('SELECT b FROM entries ORDER BY rowid LIMIT 2').raw();
		expect(stmt.safeIntegers(false).iterate().nextBatch(10)).to.deep.equal([1, 2]);
		expect(stmt.safeIntegers(true).iterate().nextBatch(10)).to.deep.equal([1n, 2n]);
	});
	it('should return rows in the other modes', function () {
		const sql = 'SELECT a, b FROM entries ORDER BY rowid LIMIT 3';
		for (const mode of ['', 'pluck', 'expand']) {
			const stmt = this.db.prepare(sql);
			if (mode) stmt[mode]();
			const want = stmt.all();
			const it = stmt.iterate();
			expect([...it.nextBatch(2), ...it.nextBatch(2)]).to.deep.equal(want);
			expect(stmt.busy).to.be.false;
		}
	});
	it('should mix with next() and stop at return()', function () {
		const stmt = this.db.prepare('SELECT b FROM entries ORDER BY rowid').raw();
		const it = stmt.iterate();
		expect(it.next().value).to.deep.equal([1]);
		expect(it.nextBatch(3)).to.deep.equal([2, 3, 4]);
		expect(it.next().value).to.deep.equal([5]);
		expect(stmt.busy).to.be.true;
		expect(it.return()).to.deep.equal({value: undefined, done: true});
		expect(stmt.busy).to.be.false;
		expect(it.nextBatch(3)).to.deep.equal([]);
		expect(it.next()).to.deep.equal({value: undefined, done: true});
		expect(stmt.all().length).to.equal(10);
	});
	it('should keep the statement and database busy until the end', function () {
		const stmt = this.db.prepare('SELECT b FROM entries WHERE b > ? ORDER BY rowid').raw();
		const insert = this.db.prepare("INSERT INTO entries VALUES ('bar', 0, 0, NULL, NULL)");
		const it = stmt.iterate(2);
		expect(it.nextBatch(4)).to.deep.equal([3, 4, 5, 6]);
		expect(() => stmt.all()).to.throw(TypeError);
		expect(() => insert.run()).to.throw(TypeError);
		expect(() => this.db.close()).to.throw(TypeError);
		expect(it.nextBatch(4)).to.deep.equal([7, 8, 9, 10]);
		expect(stmt.busy).to.be.true;
		expect(it.nextBatch(4)).to.deep.equal([]);
		expect(stmt.busy).to.be.false;
		insert.run();
		// The bind parameters were cleared at the end.
		expect(() => stmt.all()).to.throw(RangeError);
	});
	it('should validate maxRows', function () {
		const stmt = this.db.prepare('SELECT b FROM entries');
		const it = stmt.iterate();
		expect(() => it.nextBatch()).to.throw(TypeError);
		expect(() => it.nextBatch(1.5)).to.throw(TypeError);
		expect(() => it.nextBatch('2')).to.throw(TypeError);
		expect(() => it.nextBatch(0)).to.throw(RangeError);
		expect(() => it.nextBatch(-1)).to.throw(RangeError);
		expect(stmt.busy).to.be.true;
		it.return();
	});
	it('should close the iterator when SQLite fails mid-batch', function () {
		const stmt = this.db.prepare('SELECT CASE WHEN b > 5 THEN json(a || b) ELSE b END FROM entries ORDER BY rowid').raw();
		const it = stmt.iterate();
		expect(it.nextBatch(3)).to.deep.equal([1, 2, 3]);
		expect(() => it.nextBatch(3)).to.throw(Database.SqliteError);
		expect(stmt.busy).to.be.false;
		expect(it.nextBatch(3)).to.deep.equal([]);
	});
	it('should propagate an exception thrown by a user-defined function', function () {
		const err = new Error('boom');
		this.db.function('fail', x => { if (x > 4) throw err; return x; });
		const stmt = this.db.prepare('SELECT fail(b) FROM entries ORDER BY rowid').raw();
		const it = stmt.iterate();
		expect(it.nextBatch(3)).to.deep.equal([1, 2, 3]);
		expect(() => it.nextBatch(3)).to.throw(err);
		expect(stmt.busy).to.be.false;
	});
	it('should log the statement once per iterator in verbose mode', function () {
		const logged = [];
		const db = new Database(util.next(), {verbose: sql => logged.push(sql)});
		const stmt = db.prepare('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3').raw();
		logged.length = 0;
		drain(stmt.iterate(), 1, 1);
		const it = stmt.iterate();
		it.next();
		it.nextBatch(5);
		expect(logged).to.deep.equal([stmt.source, stmt.source]);
		db.close();
	});
});
