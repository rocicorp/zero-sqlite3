'use strict';
const { execSync } = require('child_process');
const path = require('path');
const Database = require('../.');

const isWindows = process.platform === 'win32';
const extensionSrc = path.join(__dirname, '..', 'deps', 'test_extension.c');
const sqliteInclude = path.join(__dirname, '..', 'deps', 'sqlite3');
const extensionPath = path.join(__dirname, '..', 'temp', 'test_extension');

(isWindows ? describe.skip : describe)('Database#loadExtension()', function () {
	before(function () {
		const ext = process.platform === 'darwin' ? '.dylib' : '.so';
		this.extensionFile = extensionPath + ext;
		execSync(`cc -shared -fPIC -I "${sqliteInclude}" -o "${this.extensionFile}" "${extensionSrc}"`);
	});
	beforeEach(function () {
		this.db = new Database(util.next());
	});
	afterEach(function () {
		this.db.close();
	});

	it('should throw an exception if a string is not provided', function () {
		expect(() => this.db.loadExtension(123)).to.throw(TypeError);
		expect(() => this.db.loadExtension(null)).to.throw(TypeError);
		expect(() => this.db.loadExtension()).to.throw(TypeError);
	});
	it('should throw an exception if the extension is not found', function () {
		expect(() => this.db.loadExtension('/tmp/nonexistent_extension')).to.throw(Database.SqliteError);
	});
	it('should load the extension and make its functions available', function () {
		const r = this.db.loadExtension(extensionPath);
		expect(r).to.equal(this.db);
		const result = this.db.prepare('SELECT testExtensionFunction(1, 2, 3) AS val').get();
		expect(result.val).to.equal(3);
	});
	it('should not allow loading extensions while the database is busy', function () {
		this.db.exec('CREATE TABLE data (x)');
		this.db.exec('INSERT INTO data VALUES (1)');
		const iter = this.db.prepare('SELECT * FROM data').iterate();
		iter.next();
		expect(() => this.db.loadExtension(extensionPath)).to.throw(TypeError);
		iter.return();
	});
	it('should not allow loading extensions after the database is closed', function () {
		this.db.close();
		expect(() => this.db.loadExtension(extensionPath)).to.throw(TypeError);
	});
});
