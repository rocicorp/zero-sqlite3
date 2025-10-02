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
});
