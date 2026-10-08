'use strict';
const fs = require('fs');
const Database = require('../.');

describe('Database#persistWal()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.wal = `${this.db.name}-wal`;
		this.db.pragma('journal_mode = WAL');
		this.db.exec('CREATE TABLE t (x INTEGER)');
		this.db.prepare('INSERT INTO t VALUES (?)').run(1);
	});
	afterEach(function () {
		if (this.db.open) this.db.close();
	});

	// The checkpoint sequence number and the salts of the WAL header.
	const walHeader = wal => fs.readFileSync(wal).subarray(12, 24).toString('hex');

	it('should return the database object', function () {
		expect(this.db.persistWal()).to.equal(this.db);
		expect(this.db.persistWal(false)).to.equal(this.db);
		expect(this.db.persistWal(true)).to.equal(this.db);
	});
	it('should throw if the argument is not a boolean', function () {
		expect(() => this.db.persistWal(1)).to.throw(TypeError);
		expect(() => this.db.persistWal('true')).to.throw(TypeError);
		expect(() => this.db.persistWal(null)).to.throw(TypeError);
	});
	it('should throw if the database is closed', function () {
		this.db.close();
		expect(() => this.db.persistWal()).to.throw(TypeError);
	});
	it('should be a no-op for in-memory databases', function () {
		const db = new Database(':memory:');
		expect(db.persistWal()).to.equal(db);
		expect(db.persistWal(false)).to.equal(db);
		db.close();
	});
	it('should delete the WAL on the last close by default', function () {
		expect(fs.existsSync(this.wal)).to.be.true;
		this.db.close();
		expect(fs.existsSync(this.wal)).to.be.false;
	});
	it('should keep the WAL on the last close when toggled on', function () {
		this.db.persistWal();
		this.db.close();
		expect(fs.statSync(this.wal).size).to.be.above(32);
		const header = walHeader(this.wal);

		// Reopening and writing appends to the same WAL, rather than restarting it.
		const size = fs.statSync(this.wal).size;
		const db = new Database(this.db.name);
		db.persistWal();
		db.prepare('INSERT INTO t VALUES (?)').run(2);
		expect(fs.statSync(this.wal).size).to.be.above(size);
		expect(walHeader(this.wal)).to.equal(header);
		db.close();
		expect(walHeader(this.wal)).to.equal(header);

		const reader = new Database(this.db.name, { readonly: true });
		expect(reader.prepare('SELECT x FROM t ORDER BY x').pluck().all()).to.deep.equal([1, 2]);
		reader.close();
	});
	it('should delete the WAL on the last close when toggled off', function () {
		this.db.persistWal();
		this.db.persistWal(false);
		this.db.close();
		expect(fs.existsSync(this.wal)).to.be.false;
	});
	it('should keep the WAL when leaving WAL mode while toggled on', function () {
		// This is why persistence must be toggled off before leaving WAL mode.
		this.db.persistWal();
		expect(this.db.pragma('journal_mode = DELETE', { simple: true })).to.equal('delete');
		expect(fs.existsSync(this.wal)).to.be.true;
	});
	it('should leave WAL mode when toggled off first', function () {
		this.db.persistWal();
		this.db.unsafeMode();
		this.db.persistWal(false);
		expect(this.db.pragma('journal_mode = OFF', { simple: true })).to.equal('off');
		expect(fs.existsSync(this.wal)).to.be.false;
		this.db.exec('VACUUM');
		this.db.prepare('INSERT INTO t VALUES (?)').run(2);
		expect(fs.existsSync(this.wal)).to.be.false;
		this.db.unsafeMode(false);
		this.db.persistWal();
		this.db.close();

		const db = new Database(this.db.name);
		expect(db.pragma('journal_mode', { simple: true })).to.equal('delete');
		expect(db.prepare('SELECT x FROM t ORDER BY x').pluck().all()).to.deep.equal([1, 2]);
		expect(db.pragma('integrity_check', { simple: true })).to.equal('ok');
		db.close();
		expect(fs.existsSync(this.wal)).to.be.false;
	});
});
