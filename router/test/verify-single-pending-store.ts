/**
 * There must be ONE pending store.
 *
 * THE BUG
 *
 * index.ts declared:
 *
 *     const pendingStore = new Map<string, PendingSession>();
 *
 * and router/src/tools/toolEngine.ts declares:
 *
 *     export const pendingStore = new Map<string, PendingSession>();
 *
 * TWO separate Maps.
 *
 * The SESSIONS ARE CREATED in the toolEngine one:
 *
 *     export function createPendingSession(...) {
 *         ...
 *         pendingStore.set(id, session);
 *
 * And the inline edit routes in index.ts read the index.ts map. Which
 * is ALWAYS EMPTY.
 *
 * So the editor's "review the pending changes" flow was broken: the
 * chat route created a pending session in the toolEngine map, and
 * GET /v1/edits/:id looked for it in a different, empty map. Every
 * request answered 404 "Session not found or expired."
 *
 * The dead-code check caught it once the inline routes moved out and
 * the index.ts map lost its last reader — which is exactly the kind
 * of bug that a duplicate produces.
 *
 * WHAT THIS PROVES
 *
 * The pending store is declared ONCE, and it is the one the sessions
 * are created in.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';
const SRC = path.join(ROUTER, 'src');

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

/** Every .ts file under src/. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (e.name.endsWith('.ts')) out.push(p);
	}
	return out;
}

const files = walk(SRC);
const read = (f: string) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

console.log('\n=== the pending store is declared ONCE ===');

const declarers: string[] = [];
for (const f of files) {
	const text = read(f);
	// A DECLARATION: `const pendingStore = new Map` or
	// `export const pendingStore = new Map`.
	if (/^\s*(?:export\s+)?const\s+pendingStore\s*=/m.test(text)) {
		declarers.push(path.relative(SRC, f).replace(/\\/g, '/'));
	}
}

check('exactly one file declares the pending store', () =>
	declarers.length === 1
		? true
		: `${declarers.length} files declare it: ${declarers.join(', ')}`);

check('it is tools/toolEngine.ts', () =>
	declarers[0] === 'tools/toolEngine.ts'
		? true
		: `it is ${declarers[0]}`);

console.log('\n=== the sessions are created in THAT store ===');

const tool = read(path.join(SRC, 'tools', 'toolEngine.ts'));
check('createPendingSession puts the session in the store', () => {
	const i = tool.indexOf('export function createPendingSession');
	if (i < 0) return 'the function was not found';
	const body = tool.slice(i, i + 1500);
	return /pendingStore\.set\(/.test(body)
		? true
		: 'it does not set the session in the store';
});

console.log('\n=== the edit routes READ that store ===');

const edit = read(path.join(SRC, 'router', 'editRoutes.ts'));
check('the edit routes import the store from toolEngine', () =>
	/from\s+'\.\.\/tools\/toolEngine\.js'/.test(edit) &&
	edit.includes('pendingStore')
		? true
		: 'they do not import it from toolEngine');

check('the edit routes do not declare their own', () =>
	!/^\s*(?:export\s+)?const\s+pendingStore\s*=/m.test(edit)
		? true
		: 'they declare their own store');

console.log('\n=== index.ts does not declare it either ===');

const index = read(path.join(SRC, 'index.ts'));
check('index.ts does not declare a pending store', () =>
	!/^\s*(?:export\s+)?const\s+pendingStore\s*=/m.test(index)
		? true
		: 'it declares one — the sessions go in the toolEngine map, and the reads would miss them');

console.log('\n=== the edit routes are mounted ===');

check('index.ts mounts the edit routes', () =>
	index.includes("app.use('/v1', makeEditRoutes())")
		? true
		: 'the module is not mounted — the routes would 404');

check('index.ts imports the edit routes', () =>
	/from\s+'\.\/router\/editRoutes\.js'/.test(index)
		? true
		: 'it does not import them');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('There is one pending store, and it is the live one.');
