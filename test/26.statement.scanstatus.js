'use strict';
const Database = require('../.');

describe('Statement#scanStatusV2()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
		this.db.prepare('CREATE TABLE entries (id INTEGER PRIMARY KEY, name TEXT, value INTEGER)').run();
		this.db.prepare('INSERT INTO entries (name, value) VALUES (?, ?)').run('foo', 1);
		this.db.prepare('INSERT INTO entries (name, value) VALUES (?, ?)').run('bar', 2);
		this.db.prepare('INSERT INTO entries (name, value) VALUES (?, ?)').run('baz', 3);
	});
	afterEach(function () {
		this.db.close();
	});

	it('should return scan status information for a query', function () {
		const stmt = this.db.prepare('SELECT * FROM entries WHERE value > ?');

		// Execute the statement to populate scan status
		const rows = stmt.all(1);
		expect(rows).to.have.lengthOf(2);

		// Get scan status for the first loop (idx=0)
		const explain = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_EXPLAIN, 0);
		expect(explain).to.be.a('string');

		const nLoop = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_NLOOP, 0);
		expect(nLoop).to.be.a('number');

		const nVisit = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_NVISIT, 0);
		expect(nVisit).to.be.a('number');
	});

	it('should return undefined for invalid index', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		stmt.all();

		// Try to get scan status for a non-existent loop
		const result = stmt.scanStatusV2(999, Database.SQLITE_SCANSTAT_EXPLAIN, 0);
		expect(result).to.be.undefined;
	});

	it('should work with SQLITE_SCANSTAT_COMPLEX flag', function () {
		const stmt = this.db.prepare('SELECT * FROM entries WHERE value > ?');
		stmt.all(1);

		// Use COMPLEX flag to get more detailed information
		const explain = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_EXPLAIN, Database.SQLITE_SCANSTAT_COMPLEX);
		expect(explain).to.be.a('string');

		const selectId = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_SELECTID, Database.SQLITE_SCANSTAT_COMPLEX);
		expect(selectId).to.be.a('number');
	});

	it('should respect safeIntegers setting', function () {
		const stmt = this.db.prepare('SELECT * FROM entries').safeIntegers(true);
		stmt.all();

		const nLoop = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_NLOOP, 0);
		expect(nLoop).to.be.a('bigint');
	});

	it('should return EST as a double', function () {
		const stmt = this.db.prepare('SELECT * FROM entries WHERE value > ?');
		stmt.all(1);

		const est = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_EST, 0);
		expect(est).to.be.a('number');
		expect(est).to.be.greaterThan(0);
	});

	it('should return NAME for table/index name', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		stmt.all();

		const name = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_NAME, 0);
		// Name could be null for some query plans or a string for table/index name
		expect(name === null || typeof name === 'string').to.be.true;
	});

	it('should throw when database is closed', function () {
		const stmt = this.db.prepare('SELECT * FROM entries');
		this.db.close();

		expect(() => stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_EXPLAIN, 0))
			.to.throw(TypeError);
	});

	it('should verify constants are exported', function () {
		expect(Database.SQLITE_SCANSTAT_NLOOP).to.equal(0);
		expect(Database.SQLITE_SCANSTAT_NVISIT).to.equal(1);
		expect(Database.SQLITE_SCANSTAT_EST).to.equal(2);
		expect(Database.SQLITE_SCANSTAT_NAME).to.equal(3);
		expect(Database.SQLITE_SCANSTAT_EXPLAIN).to.equal(4);
		expect(Database.SQLITE_SCANSTAT_SELECTID).to.equal(5);
		expect(Database.SQLITE_SCANSTAT_PARENTID).to.equal(6);
		expect(Database.SQLITE_SCANSTAT_NCYCLE).to.equal(7);
		expect(Database.SQLITE_SCANSTAT_COMPLEX).to.equal(0x0001);
	});

	it('should return reasonable SELECTID and PARENTID values', function () {
		const stmt = this.db.prepare('SELECT * FROM entries WHERE value > ?');
		stmt.all(1);

		// Get SELECTID and PARENTID for the first loop (using flag 1 for COMPLEX)
		const selectId = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_SELECTID, 1);
		const parentId = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_PARENTID, 1);

		// Verify selectId is a number (not undefined)
		expect(selectId).to.be.a('number');

		// SELECTID should be a small positive integer (usually 1-10 for simple queries)
		// It corresponds to the ID shown in EXPLAIN QUERY PLAN
		expect(selectId).to.be.at.least(0);
		expect(selectId).to.be.at.most(1000); // Reasonable upper bound
		expect(Number.isInteger(selectId)).to.be.true;

		// PARENTID can be 0 (no parent) or a positive integer
		if (parentId !== null && parentId !== undefined) {
			expect(parentId).to.be.a('number');
			expect(parentId).to.be.at.least(0);
			expect(parentId).to.be.at.most(1000); // Reasonable upper bound
			expect(Number.isInteger(parentId)).to.be.true;
		}
	});

	it('should verify SELECTID and PARENTID match EXPLAIN QUERY PLAN', function () {
		const stmt = this.db.prepare('SELECT * FROM entries WHERE value > ?');
		stmt.all(1);

		// Get SELECTID using flag 1 for COMPLEX
		const selectId = stmt.scanStatusV2(0, Database.SQLITE_SCANSTAT_SELECTID, 1);

		// Get EXPLAIN QUERY PLAN for the same query
		const explainStmt = this.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM entries WHERE value > ?');
		const explainRows = explainStmt.all(1);

		// The selectId should correspond to one of the IDs in the EXPLAIN QUERY PLAN output
		const explainIds = explainRows.map(row => row.id);

		// selectId should be in the range of IDs from EXPLAIN QUERY PLAN
		if (explainIds.length > 0) {
			const minId = Math.min(...explainIds);
			const maxId = Math.max(...explainIds);
			expect(selectId).to.be.at.least(minId);
			expect(selectId).to.be.at.most(maxId);
		}
	});

	it('should handle complex queries with joins', function () {
		// Create a more complex schema
		this.db.prepare('CREATE TABLE orders (id INTEGER PRIMARY KEY, entry_id INTEGER, amount INTEGER)').run();
		this.db.prepare('INSERT INTO orders (entry_id, amount) VALUES (1, 100), (2, 200), (3, 300)').run();

		const stmt = this.db.prepare('SELECT e.name, o.amount FROM entries e JOIN orders o ON e.id = o.entry_id WHERE o.amount > ?');
		stmt.all(150);

		// Check that we can get scan status for multiple loops
		let loopCount = 0;
		for (let i = 0; i < 10; i++) {
			const selectId = stmt.scanStatusV2(i, Database.SQLITE_SCANSTAT_SELECTID, 1);
			if (selectId === undefined) break;

			loopCount++;
			expect(selectId).to.be.a('number');
			expect(selectId).to.be.at.least(0);
			expect(selectId).to.be.at.most(1000);
			expect(Number.isInteger(selectId)).to.be.true;

			const parentId = stmt.scanStatusV2(i, Database.SQLITE_SCANSTAT_PARENTID, 1);
			if (parentId !== null && parentId !== undefined) {
				expect(parentId).to.be.a('number');
				expect(parentId).to.be.at.least(0);
				expect(parentId).to.be.at.most(1000);
				expect(Number.isInteger(parentId)).to.be.true;
			}
		}

		// For a join query, we should have at least 2 loops
		expect(loopCount).to.be.at.least(2);
	});

	it('should verify parent/child loop relationship with ORDER BY', function () {
		// ORDER BY on non-indexed field creates a parent/child loop relationship
		const stmt = this.db.prepare('SELECT * FROM entries ORDER BY name');
		stmt.all();

		// Collect all loops
		const loops = [];
		for (let i = 0; i < 10; i++) {
			const selectId = stmt.scanStatusV2(i, Database.SQLITE_SCANSTAT_SELECTID, 1);
			if (selectId === undefined) break;

			const parentId = stmt.scanStatusV2(i, Database.SQLITE_SCANSTAT_PARENTID, 1);
			loops.push({ index: i, selectId, parentId });

			// Verify values are reasonable
			expect(selectId).to.be.a('number');
			expect(selectId).to.be.at.least(0);
			expect(selectId).to.be.at.most(1000);
			expect(Number.isInteger(selectId)).to.be.true;

			if (parentId !== null && parentId !== undefined) {
				expect(parentId).to.be.a('number');
				expect(parentId).to.be.at.least(0);
				expect(parentId).to.be.at.most(1000);
				expect(Number.isInteger(parentId)).to.be.true;
			}
		}

		// Should have at least 2 loops for ORDER BY
		expect(loops.length).to.be.at.least(2);

		// Verify parent/child relationship: find a loop that references another as parent
		const childLoop = loops.find(l => l.parentId > 0);
		if (childLoop) {
			const parentLoop = loops.find(l => l.selectId === childLoop.parentId);
			expect(parentLoop).to.not.be.undefined;
			// Parent loop should have been processed before child loop
			expect(parentLoop.index).to.be.lessThan(childLoop.index);
		}
	});
});
