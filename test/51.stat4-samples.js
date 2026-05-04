'use strict';
const Database = require('../.');

describe('SQLITE_STAT4_SAMPLES', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
	});
	afterEach(function () {
		this.db.close();
	});

	it('is compiled with STAT4_SAMPLES=128', function () {
		const options = this.db.pragma('compile_options').map(r => r.compile_options);
		expect(options).to.include('STAT4_SAMPLES=128');
	});

	it('ANALYZE collects more than the default 24 samples per index', function () {
		this.db.prepare('CREATE TABLE t (x INTEGER)').run();
		this.db.prepare('CREATE INDEX t_x ON t (x)').run();

		const rowCount = 5000;
		const insert = this.db.prepare('INSERT INTO t (x) VALUES (?)');
		const insertMany = this.db.transaction(() => {
			for (let i = 0; i < rowCount; i++) insert.run(i);
		});
		insertMany();

		this.db.exec('ANALYZE');

		const samples = this.db
			.prepare("SELECT COUNT(*) AS n FROM sqlite_stat4 WHERE idx = 't_x'")
			.get().n;

		expect(samples).to.be.above(24);
		expect(samples).to.be.at.most(128);
	});
});
