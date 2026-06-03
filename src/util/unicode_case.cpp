// Unicode-aware lower()/upper() SQL functions backed by a generated case table
// (unicode_case_data.h), so the driver gets Unicode case conversion without an
// ICU dependency. The table is generated from Node's toLowerCase/toUpperCase
// (see deps/gen-unicode-case.mjs), so these match the client-side IVM matcher's
// case conversion. Registered as an auto-extension, overriding SQLite's
// ASCII-only built-in lower()/upper() on every connection.
//
// This matches JavaScript's default (locale-independent) case conversion for
// all input: per-code-point full mappings plus the one context-sensitive rule
// that algorithm applies — Greek final sigma (see LowerSigma). Locale-specific
// rules (Turkish dotless i, Lithuanian) are not applied, and neither does
// String.prototype.toLowerCase, so the two stay consistent.

#include <sqlite3.h>

#include "unicode_case_data.h"

namespace UnicodeCase {

static int IsCont(unsigned int b) { return (b & 0xC0u) == 0x80u; }

// Strictly decodes one UTF-8 code point from s[*i, n): rejects bad continuation
// bytes, overlong encodings, surrogates, and values > U+10FFFF. Advances *i and
// returns U+FFFD consuming a single byte on any malformed sequence, so output is
// always well-formed UTF-8 and we never loop.
static unsigned int Utf8Decode(const unsigned char* s, int n, int* i) {
	int p = *i;
	unsigned int c = s[p];
	if (c < 0x80u) {
		*i = p + 1;
		return c;
	}
	if (c >= 0xC2u && c <= 0xDFu && p + 1 < n && IsCont(s[p + 1])) {
		*i = p + 2;
		return ((c & 0x1Fu) << 6) | (s[p + 1] & 0x3Fu);
	}
	if (c >= 0xE0u && c <= 0xEFu && p + 2 < n && IsCont(s[p + 1]) && IsCont(s[p + 2])) {
		unsigned int cp = ((c & 0x0Fu) << 12) | ((s[p + 1] & 0x3Fu) << 6) | (s[p + 2] & 0x3Fu);
		if (cp >= 0x800u && !(cp >= 0xD800u && cp <= 0xDFFFu)) {
			*i = p + 3;
			return cp;
		}
	}
	if (c >= 0xF0u && c <= 0xF4u && p + 3 < n &&
		IsCont(s[p + 1]) && IsCont(s[p + 2]) && IsCont(s[p + 3])) {
		unsigned int cp = ((c & 0x07u) << 18) | ((s[p + 1] & 0x3Fu) << 12) |
			((s[p + 2] & 0x3Fu) << 6) | (s[p + 3] & 0x3Fu);
		if (cp >= 0x10000u && cp <= 0x10FFFFu) {
			*i = p + 4;
			return cp;
		}
	}
	*i = p + 1;
	return 0xFFFDu;
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

// Whether `cp` falls in one of the sorted, non-overlapping [lo, hi] ranges.
static int InRanges(const ZeroRange* r, int len, unsigned int cp) {
	int lo = 0, hi = len - 1;
	while (lo <= hi) {
		int mid = (lo + hi) >> 1;
		if (cp < r[mid].lo) hi = mid - 1;
		else if (cp > r[mid].hi) lo = mid + 1;
		else return 1;
	}
	return 0;
}

static int IsCased(unsigned int cp) {
	return InRanges(kZeroCased, kZeroCasedLen, cp);
}
static int IsCaseIgnorable(unsigned int cp) {
	return InRanges(kZeroCaseIgnorable, kZeroCaseIgnorableLen, cp);
}

static const unsigned int kCapitalSigma = 0x3A3u; // Σ
static const unsigned int kSmallSigma = 0x3C3u;   // σ
static const unsigned int kFinalSigma = 0x3C2u;   // ς

// Lowercasing Σ is the one context-sensitive rule in the default (locale-
// independent) algorithm that JS toLowerCase applies: Σ -> ς when it is preceded
// by a cased letter (ignoring case-ignorable chars) and not followed by one;
// otherwise Σ -> σ. `prevCased` is whether the last non-ignorable input char was
// cased; `in`/`n`/`after` scan the input following the Σ.
static unsigned int LowerSigma(const unsigned char* in, int n, int after, int prevCased) {
	int followedByCased = 0;
	int j = after;
	while (j < n) {
		unsigned int c = Utf8Decode(in, n, &j);
		if (IsCaseIgnorable(c)) continue;
		followedByCased = IsCased(c);
		break;
	}
	return (prevCased && !followedByCased) ? kFinalSigma : kSmallSigma;
}

static void Apply(sqlite3_context* ctx, sqlite3_value* arg, const ZeroCaseMap* map, int len, int lower) {
	if (sqlite3_value_type(arg) == SQLITE_NULL) {
		sqlite3_result_null(ctx);
		return;
	}
	// Request UTF-8 text first, then its byte length (SQLite requires this order).
	const unsigned char* in = sqlite3_value_text(arg);
	if (in == NULL) {
		// Not an SQL NULL (handled above), so this is an allocation/conversion
		// failure — surface it rather than silently returning NULL.
		sqlite3_result_error_nomem(ctx);
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
	int prevCased = 0; // was the last non-case-ignorable input char cased?
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
		if (lower && cp == kCapitalSigma) {
			outn += Utf8Encode(LowerSigma(in, n, i, prevCased), out + outn);
		} else {
			const ZeroCaseMap* m = Lookup(map, len, cp);
			if (m) {
				for (int k = 0; k < m->n; k++) outn += Utf8Encode(m->to[k], out + outn);
			} else {
				outn += Utf8Encode(cp, out + outn);
			}
		}
		// Context for final-sigma is evaluated on the original input.
		if (!IsCaseIgnorable(cp)) prevCased = IsCased(cp);
	}
	sqlite3_result_text(ctx, out, outn, sqlite3_free);
}

static void LowerFunc(sqlite3_context* ctx, int argc, sqlite3_value** argv) {
	(void)argc;
	Apply(ctx, argv[0], kZeroLowerMap, kZeroLowerMapLen, 1);
}

static void UpperFunc(sqlite3_context* ctx, int argc, sqlite3_value** argv) {
	(void)argc;
	Apply(ctx, argv[0], kZeroUpperMap, kZeroUpperMapLen, 0);
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
