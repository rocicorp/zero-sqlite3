'use strict';
const Database = require('../.');

// Reads a stepIntoStrings() buffer the way docs/api.md describes it.
function views(buffer, columns, capacity) {
	const cells = columns * capacity;
	return {
		header: new Int32Array(buffer, 0, 4),
		f64: new Float64Array(buffer, 16, cells),
		i64: new BigInt64Array(buffer, 16, cells),
		u32: new Uint32Array(buffer, 16, cells * 2),
		tags: new Uint8Array(buffer, 16 + 8 * cells, cells),
	};
}

function decode(v, values, columns) {
	const rows = [];
	for (let r = 0; r < v.header[0]; r++) {
		const row = [];
		for (let c = 0; c < columns; c++) {
			const cell = r * columns + c;
			switch (v.tags[cell]) {
				case 0: row.push(null); break;
				case 1: row.push(v.i64[cell]); break;
				case 2: row.push(v.f64[cell]); break;
				case 3: case 4: row.push(values[v.u32[cell * 2]]); break;
				default: throw new Error(`bad tag ${v.tags[cell]}`);
			}
		}
		rows.push(row);
	}
	return rows;
}

function bufferFor(stmt, capacity, Type = ArrayBuffer) {
	return new Type(16 + 9 * capacity * stmt.columns().length);
}

// Drains a cursor; returns {rows, calls}.
function drain(stmt, capacity, ...params) {
	const columns = stmt.columns().length;
	const buffer = bufferFor(stmt, capacity);
	const v = views(buffer, columns, capacity);
	const rows = [];
	let calls = 1;
	let values = stmt.stepIntoStrings(buffer, capacity, ...params);
	for (;;) {
		expect(v.header[0]).to.be.at.most(capacity);
		expect(v.header[2]).to.equal(columns);
		rows.push(...decode(v, values, columns));
		if (v.header[1] === 1) return {rows, calls};
		expect(v.header[1]).to.equal(0);
		values = stmt.stepIntoStrings(buffer, capacity);
		calls++;
	}
}

describe('Statement#stepIntoStrings()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.db.prepare('CREATE TABLE entries (a TEXT, b INTEGER, c REAL, d BLOB, e TEXT)').run();
		this.db.prepare("INSERT INTO entries WITH RECURSIVE temp(a, b, c, d, e) AS (SELECT 'foo', 1, 3.14, x'dddddddd', NULL UNION ALL SELECT a, b + 1, c, d, e FROM temp LIMIT 10) SELECT * FROM temp").run();
	});
	afterEach(function () {
		this.db.close();
	});

	it('should throw an exception when used on a statement that returns no data', function () {
		const stmt = this.db.prepare("INSERT INTO entries VALUES ('foo', 1, 3.14, x'dddddddd', NULL)");
		expect(() => stmt.stepIntoStrings(new ArrayBuffer(1024), 1)).to.throw(TypeError);
	});
	it('should validate the buffer and capacity without opening a cursor', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		const big = new ArrayBuffer(16 + 9 * 5 * 4);
		expect(() => stmt.stepIntoStrings()).to.throw(TypeError);
		expect(() => stmt.stepIntoStrings(big)).to.throw(TypeError);
		expect(() => stmt.stepIntoStrings(big, 0)).to.throw(TypeError);
		expect(() => stmt.stepIntoStrings(big, -1)).to.throw(TypeError);
		expect(() => stmt.stepIntoStrings(big, 1.5)).to.throw(TypeError);
		expect(() => stmt.stepIntoStrings(big, '4')).to.throw(TypeError);
		expect(() => stmt.stepIntoStrings(new Uint8Array(big), 4)).to.throw(RangeError);
		expect(() => stmt.stepIntoStrings(Buffer.alloc(1024), 4)).to.throw(RangeError);
		expect(() => stmt.stepIntoStrings(new ArrayBuffer(16 + 9 * 5 * 4 - 1), 4)).to.throw(RangeError);
		expect(stmt.busy).to.be.false;
		stmt.stepIntoStrings(big, 4);
		expect(stmt.busy).to.be.true;
		stmt.closeCursor();
	});
	it('should reject a detached buffer', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		const buffer = bufferFor(stmt, 4);
		buffer.transfer();
		expect(() => stmt.stepIntoStrings(buffer, 4)).to.throw(RangeError);
		expect(stmt.busy).to.be.false;
	});
	it('should return the same values as raw all()', function () {
		this.db.prepare("INSERT INTO entries VALUES ('héllo ☃', 9223372036854775807, -0.5, x'', 'ascii')").run();
		this.db.prepare("INSERT INTO entries VALUES (NULL, -9223372036854775808, NULL, NULL, '')").run();
		const sql = 'SELECT * FROM entries ORDER BY rowid';
		const want = this.db.prepare(sql).raw().safeIntegers().all();
		const {rows} = drain(this.db.prepare(sql), 5);
		expect(rows).to.deep.equal(want);
		expect(rows[10]).to.deep.equal(['héllo ☃', 9223372036854775807n, -0.5, Buffer.alloc(0), 'ascii']);
		expect(rows[11]).to.deep.equal([null, -9223372036854775808n, null, null, '']);
		expect(Buffer.isBuffer(rows[0][3])).to.be.true;
	});
	it('should ignore pluck(), expand(), raw() and safeIntegers()', function () {
		const sql = 'SELECT * FROM entries ORDER BY rowid';
		const want = drain(this.db.prepare(sql), 4).rows;
		expect(drain(this.db.prepare(sql).pluck(), 4).rows).to.deep.equal(want);
		expect(drain(this.db.prepare(sql).expand(), 4).rows).to.deep.equal(want);
		expect(drain(this.db.prepare(sql).safeIntegers(false), 4).rows).to.deep.equal(want);
	});
	it('should continue a cursor across calls for any capacity', function () {
		const stmt = this.db.prepare('SELECT b FROM entries ORDER BY rowid');
		const want = [...Array(10)].map((_, i) => [BigInt(i + 1)]);
		for (const [capacity, calls] of [[1, 11], [3, 4], [9, 2], [10, 2], [11, 1], [1000, 1]]) {
			const result = drain(stmt, capacity);
			expect(result.rows).to.deep.equal(want);
			expect(result.calls).to.equal(calls);
			expect(stmt.busy).to.be.false;
		}
	});
	it('should index the returned array in row order', function () {
		const stmt = this.db.prepare("SELECT a || b, d, e FROM entries ORDER BY rowid");
		const buffer = bufferFor(stmt, 4);
		const v = views(buffer, 3, 4);
		const values = stmt.stepIntoStrings(buffer, 4);
		expect(values).to.deep.equal(['foo1', Buffer.from('dddddddd', 'hex'), 'foo2', Buffer.from('dddddddd', 'hex'), 'foo3', Buffer.from('dddddddd', 'hex'), 'foo4', Buffer.from('dddddddd', 'hex')]);
		expect([...v.tags.subarray(0, 3)]).to.deep.equal([3, 4, 0]);
		expect([...v.u32.subarray(0, 6)]).to.deep.equal([0, 0, 1, 0, 0, 0]);
		stmt.closeCursor();
	});
	it('should accept a SharedArrayBuffer', function () {
		const stmt = this.db.prepare('SELECT a, b, c FROM entries ORDER BY rowid');
		const buffer = bufferFor(stmt, 16, SharedArrayBuffer);
		const v = views(buffer, 3, 16);
		const values = stmt.stepIntoStrings(buffer, 16);
		expect(v.header[0]).to.equal(10);
		expect(v.header[1]).to.equal(1);
		expect(decode(v, values, 3)[9]).to.deep.equal(['foo', 10n, 3.14]);
	});
	it('should keep the statement busy while a cursor is open', function () {
		const stmt = this.db.prepare('SELECT * FROM entries ORDER BY rowid');
		const buffer = bufferFor(stmt, 4);
		expect(stmt.busy).to.be.false;
		stmt.stepIntoStrings(buffer, 4);
		expect(stmt.busy).to.be.true;
		expect(() => stmt.get()).to.throw(TypeError);
		expect(() => stmt.all()).to.throw(TypeError);
		expect(() => stmt.iterate()).to.throw(TypeError);
		expect(() => stmt.raw()).to.throw(TypeError);
		expect(() => stmt.stepIntoStrings(buffer, 4, 'extra')).to.throw(TypeError);
		expect(stmt.busy).to.be.true;
		stmt.stepIntoStrings(buffer, 4);
		stmt.stepIntoStrings(buffer, 4);
		expect(stmt.busy).to.be.false;
		expect(stmt.all().length).to.equal(10);
	});
	it('should block writes while a cursor is open, like iterate()', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		const insert = this.db.prepare("INSERT INTO entries VALUES ('bar', 0, 0, NULL, NULL)");
		stmt.stepIntoStrings(bufferFor(stmt, 2), 2);
		expect(() => insert.run()).to.throw(TypeError);
		expect(() => this.db.exec('DELETE FROM entries')).to.throw(TypeError);
		expect(() => this.db.close()).to.throw(TypeError);
		this.db.unsafeMode(true);
		insert.run();
		this.db.unsafeMode(false);
		stmt.closeCursor();
		insert.run();
		expect(this.db.prepare('SELECT count(*) FROM entries').pluck().get()).to.equal(12);
	});
	it('should leave an abandoned cursor open, like an abandoned iterate()', function () {
		const reader = this.db.prepare('SELECT * FROM entries');
		const insert = this.db.prepare("INSERT INTO entries VALUES ('bar', 0, 0, NULL, NULL)");
		const iterator = reader.iterate();
		iterator.next();
		expect(() => insert.run()).to.throw(TypeError);
		iterator.return();

		const db2 = new Database(util.next());
		db2.exec('CREATE TABLE t (x)');
		const s = db2.prepare('SELECT 1 UNION ALL SELECT 2');
		s.stepIntoStrings(bufferFor(s, 1), 1);
		expect(() => db2.exec('INSERT INTO t VALUES (1)')).to.throw(TypeError);
		expect(s.busy).to.be.true;
		s.closeCursor();
		db2.exec('INSERT INTO t VALUES (1)');
		db2.close();
	});
	it('should close a cursor with closeCursor()', function () {
		const stmt = this.db.prepare('SELECT b FROM entries WHERE b > ? ORDER BY rowid');
		const buffer = bufferFor(stmt, 2);
		const v = views(buffer, 1, 2);
		expect(stmt.closeCursor()).to.equal(stmt);
		stmt.stepIntoStrings(buffer, 2, 3);
		expect(decode(v, [], 1)).to.deep.equal([[4n], [5n]]);
		expect(stmt.closeCursor()).to.equal(stmt);
		expect(stmt.busy).to.be.false;
		expect(stmt.closeCursor()).to.equal(stmt);
		stmt.stepIntoStrings(buffer, 2, 7);
		expect(decode(v, [], 1)).to.deep.equal([[8n], [9n]]);
		stmt.closeCursor();
		expect(() => stmt.stepIntoStrings(buffer, 2)).to.throw(RangeError);
		expect(stmt.busy).to.be.false;
	});
	it('should accept bind parameters like iterate()', function () {
		const sql = 'SELECT b FROM entries WHERE a = ? AND b > @min ORDER BY rowid';
		const want = [[9n], [10n]];
		expect(drain(this.db.prepare(sql), 4, 'foo', {min: 8}).rows).to.deep.equal(want);
		expect(drain(this.db.prepare(sql), 4, ['foo'], {min: 8}).rows).to.deep.equal(want);
		const bound = this.db.prepare(sql).bind('foo', {min: 8});
		expect(drain(bound, 4).rows).to.deep.equal(want);
		expect(drain(bound, 1).rows).to.deep.equal(want);
		expect(() => bound.stepIntoStrings(bufferFor(bound, 4), 4, 'foo', {min: 8})).to.throw(TypeError);
	});
	it('should throw on bad bind parameters without opening a cursor', function () {
		const stmt = this.db.prepare('SELECT * FROM entries WHERE a = ? AND b = ?');
		const buffer = bufferFor(stmt, 4);
		expect(() => stmt.stepIntoStrings(buffer, 4, 'foo')).to.throw(RangeError);
		expect(() => stmt.stepIntoStrings(buffer, 4, 'foo', 1, 2)).to.throw(RangeError);
		expect(() => stmt.stepIntoStrings(buffer, 4, 'foo', {})).to.throw(RangeError);
		expect(() => stmt.stepIntoStrings(buffer, 4, 'foo', Symbol())).to.throw(TypeError);
		expect(stmt.busy).to.be.false;
		expect(drain(stmt, 4, 'foo', 2).rows.length).to.equal(1);
	});
	it('should close the cursor when SQLite fails mid-batch', function () {
		const stmt = this.db.prepare('SELECT CASE WHEN b > ? THEN json(a || b) ELSE b END FROM entries ORDER BY rowid');
		const buffer = bufferFor(stmt, 3);
		const v = views(buffer, 1, 3);
		stmt.stepIntoStrings(buffer, 3, 5);
		expect(decode(v, [], 1)).to.deep.equal([[1n], [2n], [3n]]);
		expect(() => stmt.stepIntoStrings(buffer, 3)).to.throw(Database.SqliteError).with.property('code', 'SQLITE_ERROR');
		expect(stmt.busy).to.be.false;
		// An error on the first row, in the call that opens the cursor.
		expect(() => stmt.stepIntoStrings(buffer, 3, 0)).to.throw(Database.SqliteError);
		expect(stmt.busy).to.be.false;
		expect(drain(stmt, 3, 100).rows.length).to.equal(10);
		this.db.exec('DELETE FROM entries WHERE b = 1');
	});
	it('should propagate an exception thrown by a user-defined function', function () {
		const err = new Error('boom');
		this.db.function('fail', x => { if (x > 4n) throw err; return x; });
		const stmt = this.db.prepare('SELECT fail(b) FROM entries ORDER BY rowid').safeIntegers();
		const buffer = bufferFor(stmt, 3);
		stmt.stepIntoStrings(buffer, 3);
		expect(() => stmt.stepIntoStrings(buffer, 3)).to.throw(err);
		expect(stmt.busy).to.be.false;
		this.db.exec('DELETE FROM entries WHERE b = 1');
		expect(drain(this.db.prepare('SELECT b FROM entries'), 3).rows.length).to.equal(9);
	});
	it('should not allow the database to be used from a user-defined function', function () {
		const reader = this.db.prepare('SELECT b FROM entries');
		this.db.function('reenter', () => { reader.get(); return 1; });
		const stmt = this.db.prepare('SELECT reenter() FROM entries');
		expect(() => stmt.stepIntoStrings(bufferFor(stmt, 3), 3)).to.throw(TypeError);
		expect(stmt.busy).to.be.false;
	});
	it('should log the statement once per cursor in verbose mode', function () {
		const logged = [];
		const db = new Database(util.next(), {verbose: sql => logged.push(sql)});
		const stmt = db.prepare('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3');
		logged.length = 0;
		drain(stmt, 1);
		drain(stmt, 2);
		expect(logged).to.deep.equal([stmt.source, stmt.source]);
		db.close();
	});
	it('should not run after the database is closed', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		const buffer = bufferFor(stmt, 4);
		const db = this.db;
		this.db = new Database(util.next());
		db.close();
		expect(() => stmt.stepIntoStrings(buffer, 4)).to.throw(TypeError);
		expect(stmt.closeCursor()).to.equal(stmt);
		expect(stmt.busy).to.be.false;
	});
});
