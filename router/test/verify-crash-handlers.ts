/**
 * The router's crash handlers must exist.
 *
 * THE BUG
 *
 * Commit 5b6618d added them to index.ts:
 *
 *     fix: the router reports WHY it died, instead of exiting 1 in silence
 *
 *     2. There was NO uncaughtException / unhandledRejection handler, so
 *        the reason went nowhere.
 *
 * Then commit 0b82970 — the refactor that moved the prompt builders
 * into their modules — DELETED them. The router died with exit code 1
 * and no explanation, which is the exact failure they were added to
 * prevent.
 *
 * The same commit also broke the prompt path:
 *
 *     -  path.join(import.meta.dirname, '../../prompts', `${name}.md`);
 *     +  path.join(import.meta.dirname, '../prompts', `${name}.md`);
 *
 * So that one refactor silently broke the prompt loading AND the
 * crash reporting, and neither was noticed until a shadow
 * comparison run produced an obviously-empty prompt.
 *
 * WHAT THIS PROVES
 *
 * The handlers are installed, and they are installed from a MODULE —
 * so moving code around index.ts cannot lose them again.
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
const handlersSrc = read('server/crashHandlers.ts');

console.log('\n=== the crash handlers exist ===');

check('the module exists', () =>
	fs.existsSync(path.join(SRC, 'server', 'crashHandlers.ts'))
		? true
		: 'src/server/crashHandlers.ts does not exist');

check('the module handles uncaughtException', () =>
	handlersSrc.includes("process.on('uncaughtException'")
		? true
		: 'it does not');

check('the module handles unhandledRejection', () =>
	handlersSrc.includes("process.on('unhandledRejection'")
		? true
		: 'it does not');

check('the module handles the server error event', () =>
	handlersSrc.includes("server.on('error'")
		? true
		: 'it does not');

console.log('\n=== index.ts installs them ===');

check('index.ts imports the module', () =>
	/from\s+'\.\/server\/crashHandlers\.js'/.test(indexSrc)
		? true
		: 'it does not import them');

check('index.ts calls installCrashHandlers', () =>
	indexSrc.includes('installCrashHandlers(')
		? true
		: 'it does not install them');

check('index.ts KEEPS the server object', () => {
	// app.listen(PORT, ...) does not keep the server, and a failed
	// bind is an unhandled 'error' event on a server nobody holds a
	// reference to.
	return /const\s+server\s*=\s*app\.listen\(/.test(indexSrc)
		? true
		: 'app.listen is not assigned — a bind failure would exit 1 silently';
});

console.log('\n=== the prompt path is not broken again ===');

const builderSrc = read('prompts/promptBuilder.ts');
check('the prompt path goes up two levels', () => {
	// The prompts are at router/prompts/ and the module is at
	// router/src/prompts/.
	return builderSrc.includes("'../../prompts'")
		? true
		: "it does not use '../../prompts'";
});

check('the prompt path does not resolve to src/prompts', () => {
	const wrong = /path\.join\(import\.meta\.dirname,\s*'\.\.\/prompts'/.test(builderSrc);
	return !wrong
		? true
		: "it uses '../prompts', which resolves to router/src/prompts/ where there are no .md files";
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The crash handlers and the prompt path are both in place.');
