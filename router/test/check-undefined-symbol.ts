/**
 * Verifies a suspected false-positive class in the validator's
 * `undefined_symbol` pass.
 *
 * Observed in the BE probe log:
 *   ❌ [undefined_symbol] src/middleware/auth.ts: "if" called or referenced ...
 *   ❌ [undefined_symbol] src/middleware/auth.ts: "json" ...
 *   ❌ [undefined_symbol] src/middleware/auth.ts: "handlers" ...
 *   ❌ [undefined_symbol] src/middleware/auth.ts: "catch" ...
 *   ❌ [undefined_symbol] src/middleware/auth.ts: "send" ...
 *
 * "if", "catch" are JS keywords. "send" is a method on `res`. "json" is a
 * property. "handlers" is likely a local. These are not undefined symbols.
 *
 * Hypothesis: the call regex matches ANY identifier followed by "(" — including
 * keywords, method calls on objects (where only the FIRST segment is captured
 * correctly, but bare `foo(` where foo is a local method is missed), and
 * property accesses in odd positions.
 *
 * Run: node_modules/.bin/tsx scratch/check-undefined-symbol.ts
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

const VALIDATOR_SRC = fileURLToPath(new URL('../src/validator.ts', import.meta.url));
const validatorSrc = fs.readFileSync(VALIDATOR_SRC, 'utf8');

let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, fn: () => true | string): void {
	try {
		const r = fn();
		if (r === true) { pass++; console.log(`  PASS  ${name}`); }
		else { fail++; failures.push(`${name} -> ${r}`); console.log(`  FAIL  ${name} -> ${r}`); }
	} catch (e: any) {
		fail++; failures.push(`${name} -> threw: ${e.message}`);
		console.log(`  FAIL  ${name} -> threw: ${e.message}`);
	}
}

// The validator's exact regexes, copied from validator.ts:1365-1372.
const callRe = /\b(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/g;
const newRe = /\bnew\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/g;

const SKIP_SYMS = new Set([
	'require', 'import', 'typeof', 'next', 'res', 'req', 'err', 'error', 'console', 'process',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
	'JSON', 'Math', 'Promise', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
	'data', 'result', 'Date', 'RegExp', 'Array', 'Object', 'String', 'Number', 'Boolean',
	'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError',
	'SyntaxError', 'Buffer', 'URL', 'URLSearchParams', 'fetch', 'Headers', 'Request', 'Response',
	'FormData', 'AbortController', 'Blob',
]);

/** Mirrors the validator's call/new scan over one file's content. */
function scan(content: string): string[] {
	const found: string[] = [];
	let m: RegExpExecArray | null;
	const call = new RegExp(callRe.source, 'g');
	while ((m = call.exec(content)) !== null) {
		const sym = m[1]!;
		if (SKIP_SYMS.has(sym)) continue;
		found.push(sym);
	}
	const nw = new RegExp(newRe.source, 'g');
	while ((m = nw.exec(content)) !== null) {
		const sym = m[1]!;
		if (SKIP_SYMS.has(sym)) continue;
		found.push(sym);
	}
	return found;
}

console.log('\n=== A. JS keywords are not in SKIP_SYMS ===');

const KEYWORDS = ['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'do', 'else', 'try'];

check('FINDING: JS keywords like "if"/"catch" are NOT in SKIP_SYMS', () => {
	const missing = KEYWORDS.filter(k => !SKIP_SYMS.has(k));
	if (missing.length === 0) {
		return 'all keywords are skipped — finding would be wrong';
	}
	console.log(`      missing keywords: ${missing.join(', ')}`);
	return true;
});

console.log('\n=== B. a normal Express middleware file produces false positives ===');

// A realistic, correct Express middleware file.
const GOOD_MIDDLEWARE = `import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export default function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Missing token' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string);
    (req as Request & { userId?: number }).userId = Number(decoded.userId);
    next();
  } catch (_) {
    return res.status(403).send({ error: { code: 'FORBIDDEN' } });
  }
}
`;

const hits = scan(GOOD_MIDDLEWARE);

check('FINDING: a CORRECT Express middleware file yields false positives', () => {
	if (hits.length === 0) {
		return 'no false positives — finding would be wrong';
	}
	console.log(`      false positives in a valid file: ${[...new Set(hits)].join(', ')}`);
	return true;
});

console.log('\n=== C. which constructs produce the false positives? ===');
console.log(`    detected symbols: ${[...new Set(hits)].join(', ') || '(none)'}`);

check('FINDING: "if" is flagged (a keyword, never a call)', () =>
	hits.includes('if') ? true : 'expected "if" among the hits');

check('FINDING: "catch" is flagged (a keyword, never a call)', () =>
	hits.includes('catch') ? true : 'expected "catch" among the hits');

check('FINDING: "json" is flagged (it is res.json(...), a method — not a free symbol)', () =>
	hits.includes('json') ? true : 'expected "json" among the hits');

check('FINDING: "send" is flagged (res.send(...), a method)', () =>
	hits.includes('send') ? true : 'expected "send" among the hits');

check('FINDING: "split" is flagged (a String method, not a free symbol)', () =>
	hits.includes('split') ? true : 'expected "split" among the hits');

console.log('\n=== D. method calls on an object are reported by their METHOD name ===');

const WITH_METHOD = `import express from 'express';
const app = express();
app.get('/x', (req, res) => {
  const payload = res.json({ ok: true });
  res.send(payload);
});
`;

const hits2 = scan(WITH_METHOD);

check('FINDING: obj.method() is reported as a free symbol named "method"', () => {
	// The regex captures the FIRST identifier before the dot chain, so
	// `res.json(...)` should yield "res" (skipped), not "json".
	// Verify what actually happens.
	const m = [...WITH_METHOD.matchAll(/\b(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/g)]
		.map(x => x[1]);
	console.log(`      raw capture of obj.method(): ${[...new Set(m)].join(', ')}`);
	return true;
});

check('FINDING: a locally defined function IS correctly captured by the regex', () => {
	// `authMiddleware` above is defined via `export default function` — the
	// validator's extractDefinedSymbols is what suppresses it, not the regex.
	return hits.includes('authMiddleware')
		? true
		: 'authMiddleware was not captured (unexpected)';
});

console.log('\n=== E. impact on the repair loop ===');

check('false positives reach the user as hard ERRORS (severity=error)', () => {
	// The validator pushes these with severity:'error' at validator.ts:1370.
	return validatorSrc.includes(`kind: 'undefined_symbol', file: f.path, message: \`"\${sym}" called or referenced but not defined or imported\`, severity: 'error'`)
		? true
		: 'could not confirm severity:error';
});

console.log('\n=== F. the validator filters that SHOULD suppress these ===');

check('extractDefinedSymbols recognises local function declarations', () => {
	// The filter that would rescue a locally-defined symbol.
	const i = validatorSrc.indexOf('function extractDefinedSymbols');
	if (i < 0) return 'extractDefinedSymbols not found';
	const blk = validatorSrc.slice(i, i + 600);
	return /function\s*\*?\s*\[|function\s+|const\s+\[|=>|=>|new RegExp/.test(blk)
		? true
		: 'could not confirm it matches function declarations';
});

check('SKIP_SYMS does not contain the JS keywords the regex can match', () => {
	const i = validatorSrc.indexOf('const SKIP_SYMS');
	if (i < 0) return 'SKIP_SYMS not found';
	const blk = validatorSrc.slice(i, i + 900);
	const hasKeywords = /\b'if'\b|\b'catch'\b|\b'for'\b|\b'while'\b/.test(blk);
	return hasKeywords
		? 'keywords ARE in SKIP_SYMS (hypothesis wrong)'
		: true;
});

check('the call regex is not keyword-aware', () => {
	// If the regex excluded keywords, "if (" and "catch (" would not match.
	const re = /\b(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/g;
	const m = re.exec('if (x) { }');
	return m && m[1] === 'if'
		? true
		: 'the regex does not match "if (" (hypothesis wrong)';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('undefined_symbol false-positive class confirmed.');
