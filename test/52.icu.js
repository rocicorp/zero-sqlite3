'use strict';
const os = require('os');
const Database = require('../.');

// ICU is statically linked on macOS and Linux (see deps/icu.js and binding.gyp),
// which makes LIKE/lower()/upper() Unicode-aware. It is intentionally NOT linked
// on Windows (static ICU there is impractical to build in CI), so those builds
// keep SQLite's ASCII-only behavior.
const isWindows = os.platform().startsWith('win');
const itWindows = isWindows ? it : it.skip;

describe('ICU Unicode support', function () {
	beforeEach(function () {
		this.db = new Database(util.next());
	});
	afterEach(function () {
		this.db.close();
	});

	const evalScalar = function (db, expr) {
		return db.prepare(`SELECT ${expr} AS v`).pluck().get();
	};

	util.itUnix('case-folds non-ASCII characters when ICU is enabled', function () {
		expect(evalScalar(this.db, "lower('Ä')")).to.equal('ä');
		expect(evalScalar(this.db, "upper('ß')")).to.equal('SS');
		// SQLite's LIKE is provided by ICU here, so it folds case across Unicode.
		expect(evalScalar(this.db, "'Ä' LIKE 'ä'")).to.equal(1);
		expect(evalScalar(this.db, "'ПРИВЕТ' LIKE 'привет'")).to.equal(1);
		// Distinct characters still do not match.
		expect(evalScalar(this.db, "'Ä' LIKE 'å'")).to.equal(0);
	});

	itWindows('leaves non-ASCII characters unchanged when ICU is disabled', function () {
		expect(evalScalar(this.db, "lower('Ä')")).to.equal('Ä');
		expect(evalScalar(this.db, "'Ä' LIKE 'ä'")).to.equal(0);
		// ASCII case-insensitivity still works without ICU.
		expect(evalScalar(this.db, "'ABC' LIKE 'abc'")).to.equal(1);
	});
});
