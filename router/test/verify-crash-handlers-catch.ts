/**
 * The crash handlers must actually catch.
 *
 * THE PROBLEM
 *
 * The router died three times with exit code 1 and NOTHING in the
 * log — no "[Router] UNCAUGHT EXCEPTION", no "[Router] UNHANDLED
 * REJECTION". The handlers are installed, but they did not fire.
 *
 * Either:
 *   1. the process is dying some other way (a native crash in
 *      llama.cpp, which no JS handler can catch), or
 *   2. the handlers are not actually installed.
 *
 * This distinguishes them: it triggers a real unhandled rejection
 * in a child process and checks that the handler catches it and
 * prints the reason.
 *
 * Run: tsx <this file>
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';

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

console.log('\n=== the module is importable ===');

/** The module's URL. On Windows a raw path is not a valid ESM specifier. */
const MODULE_URL = pathToFileURL(
	path.join(ROUTER, 'src', 'server', 'crashHandlers.ts'),
).href;

const { installCrashHandlers } = await import(
	MODULE_URL
) as { installCrashHandlers: (g: () => undefined) => void };

check('it exports installCrashHandlers', () =>
	typeof installCrashHandlers === 'function' ? true : 'it does not');

console.log('\n=== it catches an unhandled rejection ===');

// A child process that installs the handlers and then throws.
const child = path.join(os.tmpdir(), `hermes-crash-${Date.now()}.mjs`);
fs.writeFileSync(child, `
import { installCrashHandlers } from '${MODULE_URL}';
installCrashHandlers(() => undefined);
Promise.reject(new Error('the deliberate test failure'));
setTimeout(() => { console.log('NO CRASH'); process.exit(0); }, 3000);
`, 'utf-8');

const r = spawnSync(
	'node',
	['--import', 'tsx', child],
	{ encoding: 'utf8', timeout: 30000, cwd: ROUTER },
);
const out = (r.stdout || '') + (r.stderr || '');

check('the child exited with 1', () =>
	r.status === 1 ? true : `it exited with ${r.status}`);

check('the handler printed the reason', () =>
	out.includes('UNHANDLED REJECTION')
		? true
		: `it printed: ${out.trim().slice(0, 200)}`);

check('the reason names the error', () =>
	out.includes('the deliberate test failure')
		? true
		: `it printed: ${out.trim().slice(0, 200)}`);

console.log('\n=== it catches an uncaught exception ===');

const child2 = path.join(os.tmpdir(), `hermes-crash2-${Date.now()}.mjs`);
fs.writeFileSync(child2, `
import { installCrashHandlers } from '${MODULE_URL}';
installCrashHandlers(() => undefined);
setTimeout(() => { throw new Error('the deliberate throw'); }, 50);
`, 'utf-8');

const r2 = spawnSync(
	'node',
	['--import', 'tsx', child2],
	{ encoding: 'utf8', timeout: 30000, cwd: ROUTER },
);
const out2 = (r2.stdout || '') + (r2.stderr || '');

check('the child exited with 1', () =>
	r2.status === 1 ? true : `it exited with ${r2.status}`);

check('the handler printed the reason', () =>
	out2.includes('UNCAUGHT EXCEPTION')
		? true
		: `it printed: ${out2.trim().slice(0, 200)}`);

check('the reason names the error', () =>
	out2.includes('the deliberate throw')
		? true
		: `it printed: ${out2.trim().slice(0, 200)}`);

for (const f of [child, child2]) {
	try { fs.unlinkSync(f); } catch { /* not fatal */ }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The crash handlers catch.');
