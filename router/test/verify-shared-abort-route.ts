/**
 * Both chat routes must serve the SAME abort route.
 *
 * THE BUG
 *
 * The abort route was inline in BOTH routes:
 *
 *   index.ts (LIVE)
 *       app.post('/v1/chat/abort', ...)
 *
 *   router/chatRoutes.ts (SHADOW)
 *       router.post('/chat/abort', ...)
 *
 * With the same body, and the same mutable module-level
 * `activeController` behind it — but the two copies could drift
 * apart, and one of them would abort a controller the other
 * registered.
 *
 * It lives in server/requestMutex.ts now, and both routes mount the
 * SAME factory. So there is one implementation and one
 * active-generation handle.
 *
 * WHAT THIS PROVES
 *
 * Neither route defines the abort route inline, both use the
 * module's factory, and the module has exactly one abort route.
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

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const indexSrc = read('index.ts');
const chatSrc = read('router/chatRoutes.ts');
const mutexSrc = read('server/requestMutex.ts');

console.log('\n=== the module owns the abort route ===');

check('the module has the factory', () =>
	/export function makeAbortRoutes\s*\(/.test(mutexSrc)
		? true
		: 'it does not');

check('the module defines the route once', () => {
	const n = (mutexSrc.match(/router\.post\('\/chat\/abort'/g) ?? []).length;
	return n === 1 ? true : `it defines it ${n} time(s)`;
});

check('the module owns the active-generation handle', () =>
	/export function abortActiveGeneration\s*\(/.test(mutexSrc) &&
	/export function setActiveController\s*\(/.test(mutexSrc)
		? true
		: 'it does not');

console.log('\n=== the live route uses the module ===');

check('index.ts does not define the abort route inline', () =>
	!/app\.post\('\/v1\/chat\/abort'/.test(indexSrc)
		? true
		: 'it still defines one inline');

check('index.ts mounts the module\'s factory', () =>
	indexSrc.includes("app.use('/v1', makeAbortRoutes())")
		? true
		: 'it does not');

check('index.ts imports the factory', () =>
	/from\s+'\.\/server\/requestMutex\.js'/.test(indexSrc) &&
	indexSrc.includes('makeAbortRoutes')
		? true
		: 'it does not');

console.log('\n=== the shadow route uses the module ===');

check('chatRoutes.ts does not define the abort route inline', () =>
	!/router\.post\('\/chat\/abort'/.test(chatSrc)
		? true
		: 'it still defines one inline');

check('chatRoutes.ts uses the module\'s factory', () =>
	chatSrc.includes('makeAbortRoutes()')
		? true
		: 'it does not');

check('chatRoutes.ts imports the factory', () =>
	/from\s+'\.\.\/server\/requestMutex\.js'/.test(chatSrc) &&
	chatSrc.includes('makeAbortRoutes')
		? true
		: 'it does not');

console.log('\n=== one active-generation handle ===');

check('the live route registers through the module', () =>
	indexSrc.includes('setActiveController(c)')
		? true
		: 'it registers through something else');

check('the shadow route registers through the module', () =>
	chatSrc.includes('setActiveController(controller)')
		? true
		: 'it registers through something else');

check('neither route declares its own controller variable', () => {
	const live = /^\s*let\s+activeController\s*=/m.test(indexSrc);
	const chat = /^\s*let\s+activeController\s*=/m.test(chatSrc);
	return !live && !chat
		? true
		: 'one of them declares its own — the two would not see each other';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('Both routes share one abort route.');
