'use strict';
const Database = require('../.');

// The driver registers Unicode-aware lower()/upper() on every connection
// (src/util/unicode_case.cpp), replacing SQLite's ASCII-only built-ins with no
// ICU dependency. The case table is generated from Node's toLowerCase/
// toUpperCase (deps/gen-unicode-case.mjs), so these match JavaScript. Works on
// every platform, including Windows.
describe('Unicode lower()/upper()', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
	});
	afterEach(function () {
		this.db.close();
	});

	const lower = function (db, s) {
		return db.prepare('SELECT lower(?) AS v').pluck().get(s);
	};
	const upper = function (db, s) {
		return db.prepare('SELECT upper(?) AS v').pluck().get(s);
	};

	it('lowercases non-ASCII characters', function () {
		expect(lower(this.db, 'MÜLLER')).to.equal('müller');
		expect(lower(this.db, 'ПРИВЕТ')).to.equal('привет');
		expect(lower(this.db, 'CAFÉ')).to.equal('café');
	});

	it('uppercases non-ASCII characters, including 1:many mappings', function () {
		expect(upper(this.db, 'müller')).to.equal('MÜLLER');
		expect(upper(this.db, 'café')).to.equal('CAFÉ');
		expect(upper(this.db, 'ß')).to.equal('SS'); // 1 -> 2 code points
	});

	// The whole point of generating the table from Node is that the SQL functions
	// match JavaScript's (context-free) case conversion, which the IVM relies on.
	it('matches JavaScript toLowerCase/toUpperCase', function () {
		const samples = [
			'MÜLLER',
			'café',
			'ПРИВЕТ',
			'ΑΒΓ', // Greek (no word-final sigma; see note below)
			'İ', // dotted capital I -> 'i̇' (1 -> 2)
			'ǅ', // titlecase digraph
			'Ⅻ', // roman numeral
			'ẞ', // capital sharp s -> 'ß'
			'straße',
			'a1!ä',
		];
		for (const s of samples) {
			expect(lower(this.db, s), `lower(${s})`).to.equal(s.toLowerCase());
			expect(upper(this.db, s), `upper(${s})`).to.equal(s.toUpperCase());
		}
	});

	it('drives Unicode-insensitive ILIKE via lower()', function () {
		// This is how zqlite compiles ILIKE.
		const ilike = (a, b) =>
			this.db.prepare('SELECT (lower(?) LIKE lower(?)) AS v').pluck().get(a, b);
		expect(ilike('MÜLLER', 'müller')).to.equal(1);
		expect(ilike('Ä', 'ä')).to.equal(1);
		expect(ilike('Ä', 'å')).to.equal(0);
	});

	it('passes NULL through and coerces non-text', function () {
		expect(lower(this.db, null)).to.equal(null);
		expect(this.db.prepare('SELECT lower(123) AS v').pluck().get()).to.equal('123');
	});
});

// Note: case *folding* (ß <-> ss) and context rules (Greek word-final sigma) are
// intentionally not implemented — only context-free case mapping, matching JS
// toLowerCase/toUpperCase. The cross-backend parity test in the zero repo guards
// the behavior Zero actually depends on.
