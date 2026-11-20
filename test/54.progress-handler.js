'use strict';
const Database = require('../.');

describe('Database#progressHandler()', function () {
	const scan = 'SELECT x FROM data WHERE x + 1 < 0';
	beforeEach(function () {
		this.db = new Database(':memory:');
		this.db.exec(`
			CREATE TABLE data(x INTEGER);
			WITH RECURSIVE seq(x) AS (VALUES (1) UNION ALL SELECT x + 1 FROM seq WHERE x < 5000)
			INSERT INTO data SELECT x FROM seq;
		`);
	});
	afterEach(function () {
		this.db.close();
	});

	it('interrupts a scan before its first row and can reuse the statement', function () {
		const stmt = this.db.prepare(scan);
		let calls = 0;
		expect(this.db.progressHandler(100, () => ++calls === 3)).to.equal(this.db);
		expect(() => stmt.get()).to.throw(Database.SqliteError).with.property('code', 'SQLITE_INTERRUPT');
		expect(calls).to.equal(3);
		expect(this.db.progressHandler()).to.equal(this.db);
		expect(stmt.get()).to.equal(undefined);
		expect(calls).to.equal(3);
	});

	it('leaves an explicit read transaction for the caller to end', function () {
		const stmt = this.db.prepare(scan);
		this.db.exec('BEGIN');
		this.db.progressHandler(100, () => true);
		expect(() => stmt.all()).to.throw(Database.SqliteError).with.property('code', 'SQLITE_INTERRUPT');
		this.db.progressHandler();
		expect(this.db.inTransaction).to.equal(true);
		this.db.exec('ROLLBACK');
		expect(stmt.all()).to.deep.equal([]);
	});

	it('continues on false or undefined and replaces the handler per connection', function () {
		let calls = 0;
		this.db.progressHandler(100, () => { ++calls; });
		this.db.prepare(scan).all();
		expect(calls).to.be.greaterThan(1);
		const originalCalls = calls;
		this.db.progressHandler(1, () => false);
		this.db.exec(scan);
		expect(calls).to.equal(originalCalls);
		this.db.progressHandler(1, () => true);
		const other = new Database(':memory:');
		try {
			expect(other.prepare('SELECT 42').pluck().get()).to.equal(42);
		} finally {
			other.close();
		}
		expect(() => this.db.exec(scan)).to.throw(Database.SqliteError).with.property('code', 'SQLITE_INTERRUPT');
	});

	it('propagates the callback exception through a batched iterator and unlocks it', function () {
		const stmt = this.db.prepare(scan);
		const iterator = stmt.iterate();
		const error = new Error('deadline reached');
		this.db.progressHandler(100, () => { throw error; });
		expect(() => iterator.nextBatch(16)).to.throw(error);
		expect(stmt.busy).to.equal(false);
		this.db.progressHandler();
		expect(stmt.all()).to.deep.equal([]);
	});

	it('can abort preparation and leaves the connection usable', function () {
		const sql = Array(200).fill('SELECT 1').join(' UNION ALL ');
		const failure = new Error('cancel prepare');
		this.db.progressHandler(1, () => {
			expect(() => this.db.progressHandler()).to.throw(TypeError, 'busy');
			expect(() => this.db.prepare('SELECT 1')).to.throw(TypeError, 'busy');
			throw failure;
		});
		expect(() => this.db.prepare(sql)).to.throw(failure);
		this.db.progressHandler();
		expect(this.db.prepare('SELECT 1').pluck().get()).to.equal(1);
	});

	it('validates registration without replacing a working handler', function () {
		let calls = 0;
		this.db.progressHandler(100, () => { ++calls; });
		for (const args of [[1], [1, null], [1, true], [0.1, () => false], [2 ** 31, () => false]]) {
			expect(() => this.db.progressHandler(...args)).to.throw(TypeError);
		}
		for (const n of [0, -1]) {
			expect(() => this.db.progressHandler(n, () => false)).to.throw(RangeError);
		}
		this.db.exec(scan);
		expect(calls).to.be.greaterThan(0);
		this.db.close();
		expect(() => this.db.progressHandler()).to.throw(TypeError, 'not open');
	});

	it('rejects asynchronous callbacks when SQLite invokes them', function () {
		const stmt = this.db.prepare(scan);
		this.db.progressHandler(100, async () => false);
		expect(() => stmt.get()).to.throw(TypeError, 'boolean or undefined');
		this.db.progressHandler();
		expect(stmt.get()).to.equal(undefined);
	});
});
