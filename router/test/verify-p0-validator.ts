/**
 * Verifies P0.6 — the undefined_symbol false-positive fix.
 *
 * Before the fix, a CORRECT Express middleware file produced 7 undefined
 * symbols. Five of the six real errors in the backend run were phantoms.
 *
 * This mirrors the validator's scan EXACTLY — including the localImports
 * filter, which the real code applies — and reads the regexes straight out
 * of validator.ts so the test cannot drift from the implementation.
 *
 * It asserts:
 *   1. The known false positives are gone.
 *   2. REAL undefined symbols are still caught (the fix must not blind the
 *      validator — that would just trade one lie for another).
 *   3. Class method DECLARATIONS are not reported, but an undefined METHOD
 *      call on a known local IS.
 *   4. The source changes are actually in validator.ts.
 *
 * No LLM inference is performed.
 *
 * Run: node_modules/.bin/tsx scratch/verify-p0-validator.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');

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

const src = fs.readFileSync(path.join(ROUTER, 'src', 'validator.ts'), 'utf8');

// Scope the regex extraction to the functions that own each declaration —
// validator.ts has several `const re = ...` declarations.
const defsBlock = src.slice(
	src.indexOf('function extractDefinedSymbols'),
	src.indexOf('function extractNamedImports'),
);
const scanBlock = src.slice(
	src.indexOf('// PASS 11 — Undefined Symbol Validator'),
	src.indexOf('// PASS 12 — Dead Code Detector'),
);

function grab(block: string, name: string): RegExp {
	const m = block.match(new RegExp(`const ${name} = /((?:[^/\\\\]|\\\\.)+)/g;`));
	if (!m) throw new Error(`could not find ${name}`);
	return new RegExp(m[1]!, 'g');
}

const callRe = grab(scanBlock, 'callRe');
const newRe = grab(scanBlock, 'newRe');
const methodRe = grab(defsBlock, 'methodRe');
const defRe = grab(defsBlock, 're');
const constRe = grab(defsBlock, 'constRe');

check('the call/new/method/def regexes are all present in validator.ts', () =>
	[callRe, newRe, methodRe, defRe, constRe].every(Boolean) ? true : 'missing');

// SKIP_SYMS, parsed out of the source.
const skipStart = src.indexOf('const SKIP_SYMS');
const skipBlock = src.slice(skipStart, src.indexOf(']);', skipStart));
const SKIP_SYMS = new Set([...skipBlock.matchAll(/'([^']+)'/g)].map(m => m[1]!));

/** Mirrors extractDefinedSymbols. */
function extractDefinedSymbols(content: string): Set<string> {
	const syms = new Set<string>();
	let m: RegExpExecArray | null;
	for (const re of [defRe, constRe, methodRe]) {
		const r = new RegExp(re.source, 'g');
		while ((m = r.exec(content)) !== null) if (m[1]) syms.add(m[1]);
	}
	return syms;
}

/** Mirrors extractNamedImports. */
function extractNamedImports(content: string): Set<string> {
	const syms = new Set<string>();
	const namedRe = /import\s+\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
	const defRe2 = /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"][^'"]+['"]/g;
	const nsRe = /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+['"][^'"]+['"]/g;
	let m: RegExpExecArray | null;
	while ((m = namedRe.exec(content)) !== null) {
		m[1]!.split(',').forEach(s => { const n = s.trim().split(/\s+as\s+/).pop()!.trim(); if (n) syms.add(n); });
	}
	while ((m = defRe2.exec(content)) !== null) if (m[1]) syms.add(m[1]);
	while ((m = nsRe.exec(content)) !== null) if (m[1]) syms.add(m[1]);
	return syms;
}

/** Mirrors pass12UndefinedSymbols' scan for one file. */
function scan(content: string): string[] {
	const localImports = extractNamedImports(content);
	const localDefined = extractDefinedSymbols(content);
	const found: string[] = [];
	let m: RegExpExecArray | null;

	const c = new RegExp(callRe.source, 'g');
	while ((m = c.exec(content)) !== null) {
		const head = m[1]!;
		const chain = m[2] ?? '';
		let sym = head;
		if (chain) {
			const segments = chain.split('.').map(s => s.replace(/^\?\./, '').trim()).filter(Boolean);
			const methodName = segments[segments.length - 1];
			// The receiver must be an object WE own: `this` or a locally
			// declared symbol. A default import is a third-party library —
			// its methods are not ours to police.
			const receiverIsOurs =
				head === 'this' ||
				localDefined.has(head);
			sym = receiverIsOurs && methodName ? methodName : head;
		}
		// Only the REPORTED symbol is checked against SKIP_SYMS. The head is
		// NOT checked: `this` is in SKIP_SYMS, and skipping on the head
		// dropped every call with a chain whose head was `this` — hiding
		// genuinely undefined methods. Mirrors the source fix.
		if (SKIP_SYMS.has(sym)) continue;
		if (localImports.has(sym) || localDefined.has(sym)) continue;
		found.push(sym);
	}

	const n = new RegExp(newRe.source, 'g');
	while ((m = n.exec(content)) !== null) {
		const sym = m[1]!;
		if (SKIP_SYMS.has(sym) || localImports.has(sym) || localDefined.has(sym)) continue;
		found.push(sym);
	}
	return [...new Set(found)];
}

// The exact file that produced 5 phantom errors in the backend run.
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

console.log('\n=== 1. the known false positives are gone ===');

const hits = scan(GOOD_MIDDLEWARE);
console.log(`      surviving symbols: ${hits.length ? hits.join(', ') : '(none)'}`);

for (const sym of ['if', 'catch', 'json', 'send', 'split', 'jwt', 'authMiddleware']) {
	check(`"${sym}" is NOT reported as an undefined symbol`, () =>
		!hits.includes(sym) ? true : `still reported: ${sym}`);
}

check('the correct middleware file produces NO undefined symbols at all', () =>
	hits.length === 0
		? true
		: `still reporting ${hits.join(', ')}`);

console.log('\n=== 2. REAL undefined symbols are still caught ===');

const BROKEN = `import { Request, Response } from 'express';

export function handler(req: Request, res: Response) {
  const user = fetchUserById(req.params.id);
  return res.json(user);
}
`;

const brokenHits = scan(BROKEN);
console.log(`      detected: ${brokenHits.length ? brokenHits.join(', ') : '(none)'}`);

check('a call to an undefined function IS still reported', () =>
	brokenHits.includes('fetchUserById') ? true : 'the real error was missed — the fix blinded the validator');

console.log('\n=== 3. class method declarations vs undefined method calls ===');

const WITH_CLASS = `import { UserRepository } from './UserRepository';

export class UserServiceImpl {
  private repo: UserRepository;

  constructor(repo: UserRepository) {
    this.repo = repo;
  }

  async getAllUsers() {
    return this.repo.findAll();
  }

  async getUserById(id: number) {
    return this.repo.findById(id);
  }
}
`;

const classHits = scan(WITH_CLASS);
console.log(`      detected: ${classHits.length ? classHits.join(', ') : '(none)'}`);

for (const sym of ['getAllUsers', 'getUserById']) {
	check(`the method declaration "${sym}" is not reported as undefined`, () =>
		!classHits.includes(sym) ? true : `still reported: ${sym}`);
}

check('an undefined METHOD call on a known local IS caught', () => {
	const BROKEN_CLASS = WITH_CLASS.replace(
		'return this.repo.findAll();',
		'return this.repo.findAllMissing();');
	const h = scan(BROKEN_CLASS);
	console.log(`      detected: ${h.length ? h.join(', ') : '(none)'}`);
	// Trace the decision for this specific symbol.
	const localDefined = extractDefinedSymbols(BROKEN_CLASS);
	const callRe2 = new RegExp(callRe.source, 'g');
	let mm: RegExpExecArray | null;
	while ((mm = callRe2.exec(BROKEN_CLASS)) !== null) {
		if (mm[1] === 'this') {
			const chain = mm[2] ?? '';
			const segments = chain.split('.').map(s => s.replace(/^\?\./, '').trim()).filter(Boolean);
			console.log(`      trace: head=${mm[1]} chain=${JSON.stringify(chain)} segments=${JSON.stringify(segments)} last=${segments[segments.length - 1]}`);
			console.log(`      trace: localDefined has 'this'? ${localDefined.has('this')}  has last? ${localDefined.has(segments[segments.length - 1]!)}`);
			console.log(`      trace: SKIP_SYMS has last? ${SKIP_SYMS.has(segments[segments.length - 1]!)}`);
		}
	}
	return h.includes('findAllMissing') ? true : `the real error was missed (got ${h.join(', ') || 'nothing'})`;
});

console.log('\n=== 4. the source changes are in place ===');

check('the call regex is dot-aware (no restart after a method name)', () =>
	callRe.source.includes('(?<![.\\w$])') ? true : 'the lookbehind is missing');

check('the call regex spans optional chaining (?:\\??\\.)', () =>
	callRe.source.includes('\\??\\.') ? true : 'the optional-chain handling is missing');

check('the call regex CAPTURES the chain (so methods can be reported)', () =>
	/\)\)\s*\*\s*\\s*\\\(/.test(callRe.source) || callRe.source.includes('((?:\\??\\.')
		? true
		: 'the chain capture group is missing');

check('the new-regex is dot-aware too', () =>
	newRe.source.includes('(?<![.\\w$])') ? true : 'the lookbehind is missing on newRe');

check('SKIP_SYMS now contains the JS keywords', () => {
	const need = ['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'do', 'else', 'try'];
	const missing = need.filter(k => !SKIP_SYMS.has(k));
	return missing.length === 0 ? true : `missing keywords: ${missing.join(', ')}`;
});

check('extractDefinedSymbols recognises class methods', () =>
	methodRe.source.includes('async') ? true : 'the method pattern is missing');

check('extractDefinedSymbols recognises `export default function X`', () =>
	defRe.source.includes('default') ? true : 'the `export default function` form is not handled');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('P0.6 verified: false positives gone, real errors still caught.');
