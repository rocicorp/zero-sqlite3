'use strict';
const Database = require('../.');

describe('BEGIN CONCURRENT', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		// Enable WAL2 mode (required for BEGIN CONCURRENT)
		this.db.pragma('journal_mode = wal2');
		this.db.prepare('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT)').run();
		this.db.prepare('INSERT INTO entries (id, value) VALUES (?, ?), (?, ?), (?, ?)').run(1, 'a', 2, 'b', 3, 'c');
	});
	afterEach(function () {
		this.db.close();
	});

	it('should verify database is in WAL2 mode', function () {
		const journalMode = this.db.pragma('journal_mode', { simple: true });
		expect(journalMode).to.equal('wal2');
	});

	it('should execute BEGIN CONCURRENT without error', function () {
		expect(() => this.db.exec('BEGIN CONCURRENT')).to.not.throw();
		expect(this.db.inTransaction).to.be.true;
		this.db.exec('ROLLBACK');
	});

	it('should allow multiple concurrent transactions to open simultaneously', function () {
		const db2 = new Database(util.current());
		const db3 = new Database(util.current());
		try {
			// Start concurrent transactions on all connections
			this.db.exec('BEGIN CONCURRENT');
			db2.exec('BEGIN CONCURRENT');
			db3.exec('BEGIN CONCURRENT');

			// All should be in transaction simultaneously
			expect(this.db.inTransaction).to.be.true;
			expect(db2.inTransaction).to.be.true;
			expect(db3.inTransaction).to.be.true;

			// Rollback all
			this.db.exec('ROLLBACK');
			db2.exec('ROLLBACK');
			db3.exec('ROLLBACK');
		} finally {
			db2.close();
			db3.close();
		}
	});

	it('should allow concurrent reads from all connections', function () {
		const db2 = new Database(util.current());
		const db3 = new Database(util.current());
		try {
			// Start concurrent transactions
			this.db.exec('BEGIN CONCURRENT');
			db2.exec('BEGIN CONCURRENT');
			db3.exec('BEGIN CONCURRENT');

			// All connections can read existing data
			const val1 = this.db.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(1);
			const val2 = db2.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(2);
			const val3 = db3.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(3);

			expect(val1).to.equal('a');
			expect(val2).to.equal('b');
			expect(val3).to.equal('c');

			// Rollback all
			this.db.exec('ROLLBACK');
			db2.exec('ROLLBACK');
			db3.exec('ROLLBACK');
		} finally {
			db2.close();
			db3.close();
		}
	});

	it('should allow concurrent writes to different rows', function () {
		const db2 = new Database(util.current());
		const db3 = new Database(util.current());
		try {
			// Start concurrent transactions
			this.db.exec('BEGIN CONCURRENT');
			db2.exec('BEGIN CONCURRENT');
			db3.exec('BEGIN CONCURRENT');

			// Each connection writes to different rows
			this.db.prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run(100, 'write1');
			db2.prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run(200, 'write2');
			db3.prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run(300, 'write3');

			// All writes succeed while in transaction
			expect(this.db.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(100)).to.equal('write1');
			expect(db2.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(200)).to.equal('write2');
			expect(db3.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(300)).to.equal('write3');

			// Rollback all (no data should persist)
			this.db.exec('ROLLBACK');
			db2.exec('ROLLBACK');
			db3.exec('ROLLBACK');

			// Verify rollback - new rows should not exist
			expect(this.db.prepare('SELECT value FROM entries WHERE id = ?').get(100)).to.be.undefined;
			expect(this.db.prepare('SELECT value FROM entries WHERE id = ?').get(200)).to.be.undefined;
			expect(this.db.prepare('SELECT value FROM entries WHERE id = ?').get(300)).to.be.undefined;
		} finally {
			db2.close();
			db3.close();
		}
	});

	it('should allow concurrent updates to different rows', function () {
		const db2 = new Database(util.current());
		const db3 = new Database(util.current());
		try {
			// Start concurrent transactions
			this.db.exec('BEGIN CONCURRENT');
			db2.exec('BEGIN CONCURRENT');
			db3.exec('BEGIN CONCURRENT');

			// Each connection updates a different row
			this.db.prepare('UPDATE entries SET value = ? WHERE id = ?').run('updated-a', 1);
			db2.prepare('UPDATE entries SET value = ? WHERE id = ?').run('updated-b', 2);
			db3.prepare('UPDATE entries SET value = ? WHERE id = ?').run('updated-c', 3);

			// Each connection sees its own changes
			expect(this.db.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(1)).to.equal('updated-a');
			expect(db2.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(2)).to.equal('updated-b');
			expect(db3.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(3)).to.equal('updated-c');

			// Rollback all
			this.db.exec('ROLLBACK');
			db2.exec('ROLLBACK');
			db3.exec('ROLLBACK');

			// Verify original data is still intact
			expect(this.db.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(1)).to.equal('a');
			expect(this.db.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(2)).to.equal('b');
			expect(this.db.prepare('SELECT value FROM entries WHERE id = ?').pluck().get(3)).to.equal('c');
		} finally {
			db2.close();
			db3.close();
		}
	});

	it('should work with many concurrent connections', function () {
		const connections = [];
		try {
			// Create 10 concurrent connections
			for (let i = 0; i < 10; i++) {
				connections.push(new Database(util.current()));
			}

			// Start BEGIN CONCURRENT on all connections
			for (const conn of connections) {
				conn.exec('BEGIN CONCURRENT');
				expect(conn.inTransaction).to.be.true;
			}

			// Each connection writes a unique row
			for (let i = 0; i < connections.length; i++) {
				connections[i].prepare('INSERT INTO entries (id, value) VALUES (?, ?)').run(1000 + i, `conn-${i}`);
			}

			// Verify each connection sees its own write
			for (let i = 0; i < connections.length; i++) {
				const value = connections[i].prepare('SELECT value FROM entries WHERE id = ?').pluck().get(1000 + i);
				expect(value).to.equal(`conn-${i}`);
			}

			// Rollback all
			for (const conn of connections) {
				conn.exec('ROLLBACK');
			}
		} finally {
			for (const conn of connections) {
				conn.close();
			}
		}
	});
});
