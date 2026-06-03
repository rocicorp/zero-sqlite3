// Unicode-aware lower()/upper() SQL functions backed by a generated case table
// (unicode_case_data.h), so the driver gets Unicode case conversion without an
// ICU dependency. The table is generated from Node's toLowerCase/toUpperCase
// (see deps/gen-unicode-case.mjs), so these match the client-side IVM matcher's
// case conversion. Registered as an auto-extension, overriding SQLite's
// ASCII-only built-in lower()/upper() on every connection.
//
// Scope: context-free case mapping (the common case). It does not implement
// context-sensitive rules such as Greek final sigma; JavaScript's toLowerCase
// applies those, so a word-final Σ can differ. The zqlite ILIKE parity test
// guards the cases Zero relies on.

#include "unicode_case_data.h"

namespace UnicodeCase {

// Decodes one UTF-8 code point from s[*i, n). Advances *i past it. Returns
// U+FFFD for malformed input (consuming a single byte) so we never loop.
static unsigned int Utf8Decode(const unsigned char* s, int n, int* i) {
	unsigned int c = s[*i];
	if (c < 0x80) { *i += 1; return c; }
	if ((c >> 5) == 0x6 && *i + 1 < n) {
		unsigned int r = ((c & 0x1Fu) << 6) | (s[*i + 1] & 0x3Fu);
		*i += 2; return r;
	}
	if ((c >> 4) == 0xE && *i + 2 < n) {
		unsigned int r = ((c & 0x0Fu) << 12) | ((s[*i + 1] & 0x3Fu) << 6) | (s[*i + 2] & 0x3Fu);
		*i += 3; return r;
	}
	if ((c >> 3) == 0x1E && *i + 3 < n) {
		unsigned int r = ((c & 0x07u) << 18) | ((s[*i + 1] & 0x3Fu) << 12) |
			((s[*i + 2] & 0x3Fu) << 6) | (s[*i + 3] & 0x3Fu);
		*i += 4; return r;
	}
	*i += 1; return 0xFFFDu;
}

// Encodes `cp` as UTF-8 into `out` (>= 4 bytes). Returns bytes written.
static int Utf8Encode(unsigned int cp, char* out) {
	if (cp < 0x80) {
		out[0] = (char)cp; return 1;
	}
	if (cp < 0x800) {
		out[0] = (char)(0xC0 | (cp >> 6));
		out[1] = (char)(0x80 | (cp & 0x3F));
		return 2;
	}
	if (cp < 0x10000) {
		out[0] = (char)(0xE0 | (cp >> 12));
		out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
		out[2] = (char)(0x80 | (cp & 0x3F));
		return 3;
	}
	out[0] = (char)(0xF0 | (cp >> 18));
	out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
	out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
	out[3] = (char)(0x80 | (cp & 0x3F));
	return 4;
}

// Binary searches `map` (sorted by .from) for `cp`. Returns NULL if absent.
static const ZeroCaseMap* Lookup(const ZeroCaseMap* map, int len, unsigned int cp) {
	int lo = 0, hi = len - 1;
	while (lo <= hi) {
		int mid = (lo + hi) >> 1;
		unsigned int f = map[mid].from;
		if (cp < f) hi = mid - 1;
		else if (cp > f) lo = mid + 1;
		else return &map[mid];
	}
	return NULL;
}

static void Apply(sqlite3_context* ctx, sqlite3_value* arg, const ZeroCaseMap* map, int len) {
	if (sqlite3_value_type(arg) == SQLITE_NULL) {
		sqlite3_result_null(ctx);
		return;
	}
	// Request UTF-8 text first, then its byte length (SQLite requires this order).
	const unsigned char* in = sqlite3_value_text(arg);
	if (in == NULL) {
		sqlite3_result_null(ctx);
		return;
	}
	int n = sqlite3_value_bytes(arg);

	int cap = n + 16;
	char* out = (char*)sqlite3_malloc(cap);
	if (!out) {
		sqlite3_result_error_nomem(ctx);
		return;
	}
	int outn = 0;
	int i = 0;
	while (i < n) {
		unsigned int cp = Utf8Decode(in, n, &i);
		// Reserve room for up to 3 mapped code points (4 bytes each).
		if (outn + 12 > cap) {
			cap = cap * 2 + 16;
			char* grown = (char*)sqlite3_realloc(out, cap);
			if (!grown) {
				sqlite3_free(out);
				sqlite3_result_error_nomem(ctx);
				return;
			}
			out = grown;
		}
		const ZeroCaseMap* m = Lookup(map, len, cp);
		if (m) {
			for (int k = 0; k < m->n; k++) outn += Utf8Encode(m->to[k], out + outn);
		} else {
			outn += Utf8Encode(cp, out + outn);
		}
	}
	sqlite3_result_text(ctx, out, outn, sqlite3_free);
}

static void LowerFunc(sqlite3_context* ctx, int argc, sqlite3_value** argv) {
	(void)argc;
	Apply(ctx, argv[0], kZeroLowerMap, kZeroLowerMapLen);
}

static void UpperFunc(sqlite3_context* ctx, int argc, sqlite3_value** argv) {
	(void)argc;
	Apply(ctx, argv[0], kZeroUpperMap, kZeroUpperMapLen);
}

} // namespace UnicodeCase

// Auto-extension entry point: invoked by SQLite for every new connection.
// Overrides the built-in ASCII-only lower()/upper() with Unicode-aware ones.
extern "C" int zeroRegisterUnicodeCase(
	sqlite3* db,
	char** pzErrMsg,
	const sqlite3_api_routines* pApi
) {
	(void)pzErrMsg;
	(void)pApi;
	int flags = SQLITE_UTF8 | SQLITE_DETERMINISTIC;
	int rc = sqlite3_create_function(db, "lower", 1, flags, NULL, UnicodeCase::LowerFunc, NULL, NULL);
	if (rc != SQLITE_OK) return rc;
	return sqlite3_create_function(db, "upper", 1, flags, NULL, UnicodeCase::UpperFunc, NULL, NULL);
}
