/**
 * Pins down the EXACT regex defect behind the undefined_symbol false
 * positives: chained calls and optional chaining.
 *
 * The BE probe log showed:
 *   "split" / "if" / "json" / "catch" / "send"  flagged as undefined symbols
 * in a file the model wrote.
 *
 * Three candidate mechanisms:
 *   1. JS keywords not in SKIP_SYMS            → "if", "catch"
 *   2. Chained call after a closing paren      → res.status(401).json(...)
 *   3. Optional chaining (?.)                   → req.headers.authorization?.split(...)
 *
 * Run: node_modules/.bin/tsx scratch/check-chaining-defect.ts
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

const validatorSrc = fs.readFileSync(
	fileURLToPath(new URL('../src/validator.ts', import.meta.url)), 'utf8');

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

const callRe = /\b(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/g;

function capture(src: string): string[] {
	return [...src.matchAll(new RegExp(callRe.source, 'g'))].map(m => m[1]!);
}

console.log('\n=== 1. the regex used by the validator (verbatim from validator.ts) ===');

check('call regex in validator.ts matches the one under test', () => {
	const i = validatorSrc.indexOf('const callRe =');
	if (i < 0) return 'callRe not found in validator.ts';
	const line = validatorSrc.slice(i, validatorSrc.indexOf('\n', i));
	return line.includes('(?:await\\s+)?([A-Za-z_$][A-Za-z0-9_$]*)')
		? true
		: `validator uses a different regex: ${line.trim()}`;
});

console.log('\n=== 2. mechanism: chained call after a closing paren ===');

check('FINDING: res.status(401).json(...) captures "json" as a free symbol', () => {
	const caps = capture('return res.status(401).json({ error: "x" });');
	console.log(`      captures: ${caps.join(', ')}`);
	return caps.includes('json')
		? true
		: `expected "json" among ${caps.join(', ')} — finding would be wrong`;
});

check('FINDING: res.status(403).send(...) captures "send" as a free symbol', () => {
	const caps = capture('return res.status(403).send({ error: 1 });');
	console.log(`      captures: ${caps.join(', ')}`);
	return caps.includes('send') ? true : `expected "send" among ${caps.join(', ')}`;
});

check('CONTRAST: a SIMPLE res.json(...) captures "res" (which IS skipped)', () => {
	const caps = capture('return res.json({ ok: true });');
	console.log(`      captures: ${caps.join(', ')}`);
	return caps.includes('res') && !caps.includes('json')
		? true
		: `unexpected: ${caps.join(', ')}`;
});

console.log('\n=== 3. mechanism: optional chaining ===');

check('FINDING: req.headers.authorization?.split(...) captures "split"', () => {
	const caps = capture('const t = req.headers.authorization?.split(" ")[1];');
	console.log(`      captures: ${caps.join(', ')}`);
	return caps.includes('split') ? true : `expected "split" among ${caps.join(', ')}`;
});

check('FINDING: the dot-chain group cannot span "?."', () => {
	// The chain group is (?:\.[A-Za-z_$]...)* — "?." does not match it, so the
	// scan restarts at the identifier AFTER "?.".
	const src = 'x?.foo(';
	const caps = capture(src);
	console.log(`      captures for "${src}": ${caps.join(', ')}`);
	return caps.includes('foo') ? true : `expected "foo" among ${caps.join(', ')}`;
});

console.log('\n=== 4. mechanism: keywords ===');

check('FINDING: "if" and "catch" are captured (never in SKIP_SYMS)', () => {
	const caps = capture('if (!token) { return null; } catch (_) { return 0; }');
	console.log(`      captures: ${caps.join(', ')}`);
	const want = ['if', 'catch'].filter(k => caps.includes(k));
	return want.length === 2 ? true : `expected if+catch among ${caps.join(', ')}`;
});

console.log('\n=== 5. how many false positives per typical Express handler ===');

const HANDLER = `import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export default function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Missing token' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string);
    next();
  } catch (_) {
    return res.status(403).send({ error: { code: 'FORBIDDEN' } });
  }
}
`;

const SKIP_SYMS = new Set([
	'require', 'import', 'typeof', 'next', 'res', 'req', 'err', 'error', 'console', 'process',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
	'JSON', 'Math', 'Promise', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
	'data', 'result', 'Date', 'RegExp', 'Array', 'Object', 'String', 'Number', 'Boolean',
	'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError',
	'SyntaxError', 'Buffer', 'URL', 'URLSearchParams', 'fetch', 'Headers', 'Request', 'Response',
	'FormData', 'AbortController', 'Blob',
]);

check('FINDING: after applying ONLY SKIP_SYMS, false positives remain', () => {
	const caps = capture(HANDLER).filter(s => !SKIP_SYMS.has(s));
	const uniq = [...new Set(caps)];
	console.log(`      surviving false positives: ${uniq.join(', ')}`);
	return uniq.length > 0 ? true : 'no false positives survive — finding would be wrong';
});

check('FINDING: the surviving set matches the BE probe log', () => {
	const caps = capture(HANDLER).filter(s => !SKIP_SYMS.has(s));
	const uniq = new Set(caps);
	// The real log showed: split, if, json, handlers, catch, send
	const expected = ['split', 'if', 'json', 'catch', 'send'];
	const missing = expected.filter(e => !uniq.has(e));
	return missing.length === 0
		? true
		: `expected ${expected.join(', ')}; missing ${missing.join(', ')} (got ${[...uniq].join(', ')})`;
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('Chaining/keyword false-positive mechanism confirmed.');
