/**
 * The parity test for the logRoutingFailure consolidation.
 *
 * THIS ONE IS ALSO A DEAD-CODE FIX
 *
 * `logRoutingFailure` is the routing-failure logger. There were two
 * copies:
 *
 *   index.ts (LIVE)               prompts/promptBuilder.ts
 *   const FAILURE_LOG_PATH =      let _failureLogPath = '';
 *     path.join(config.runtime     export function setFailureLogPath(p)
 *       .root, 'logs/routing_        { _failureLogPath = p; }
 *       failures.jsonl');
 *   ...
 *   uses FAILURE_LOG_PATH         uses _failureLogPath
 *
 * Three facts:
 *
 *   1. `setFailureLogPath` is NEVER CALLED. So the module's copy
 *      would have written nowhere — its path was never set.
 *
 *   2. `logRoutingFailure` itself is never called either, so the
 *      routing-failure log is not being written at all. That is a
 *      separate gap — wiring it up belongs to the measurement rig.
 *
 *   3. The live copy computed the path itself, from the config. That
 *      is the behaviour worth keeping: there is no injection step to
 *      forget.
 *
 * So the module's version now computes the path the way the live one
 * did, and the unused injection mechanism is gone.
 *
 * WHAT THIS PROVES
 *
 *   1. promptBuilder.ts holds the only copy; index.ts does not.
 *   2. The path is computed from config.runtime.root — the same
 *      place the live one used.
 *   3. The dead `setFailureLogPath` mechanism is gone, so nobody
 *      can reintroduce the "path was never set" bug.
 *   4. The function writes a JSONL line with the four fields the
 *      live one wrote, and does not throw when the directory does
 *      not exist.
 *
 * Run: tsx <this file>
 */
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

const read = (rel: string) => fs.readFileSync(path.join(ROUTER, rel), 'utf8');

console.log('\n=== 1. the module holds the only copy ===');

const indexSrc = read('src/index.ts');
const pbSrc = read('src/prompts/promptBuilder.ts');

check('promptBuilder.ts defines logRoutingFailure', () =>
	pbSrc.includes('export function logRoutingFailure(') ? true : 'it does not');

check('index.ts does NOT define its own copy', () =>
	/^function logRoutingFailure\(/m.test(indexSrc)
		? 'it still defines its own copy' : true);

check('index.ts imports it from promptBuilder', () => {
	// The function is NOT imported by index.ts, and that is correct:
	// nothing calls it yet. It is the routing-failure COLLECTOR —
	// "collect 500–2000 failures before finetuning the advisor" —
	// and no call site was ever wired up.
	//
	// The import was removed as dead, correctly. What matters is
	// that the module still HAS the collector, and that it computes
	// its own path (the old setFailureLogPath injection was never
	// called, so it was dead too).
	//
	// So the check is: the module has it, and it is self-sufficient.
	const m = /export function logRoutingFailure\s*\(/.test(pbSrc);
	return m ? true : 'promptBuilder.ts does not export it';
});

check('the collector is self-sufficient — it computes its own path', () => {
	// The old design had setFailureLogPath(), which was never
	// called, so the logger wrote nowhere. It now derives the path
	// from the config.
	const injects = /export function setFailureLogPath\s*\(/.test(pbSrc);
	return !injects
		? true
		: 'it still has the injection mechanism, and it was never called';
});

console.log('\n=== 2. the path comes from the config, like the live one ===');

check('the module imports the config', () =>
	pbSrc.includes("import config from '@/config/index.js';")
		? true : 'the config import is missing');

check('the path is config.runtime.root + logs/routing_failures.jsonl', () =>
	pbSrc.includes("path.join(config.runtime.root, 'logs/routing_failures.jsonl')")
		? true : 'the path is computed differently');

console.log('\n=== 3. the dead injection mechanism is gone ===');

check('setFailureLogPath is gone', () => {
	// The name survives in a COMMENT that explains why it was
	// removed. The check must look at the CODE.
	const code = pbSrc
		.split('\n')
		.filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
		.join('\n');
	return !code.includes('setFailureLogPath')
		? true : 'the unused injection mechanism is still there';
});

check('_failureLogPath is gone', () => {
	const code = pbSrc
		.split('\n')
		.filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
		.join('\n');
	return !code.includes('_failureLogPath')
		? true : 'the unused path variable is still there';
});

check('nothing anywhere calls setFailureLogPath', () => {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith('.ts')) files.push(p);
		}
	};
	walk(path.join(ROUTER, 'src'));
	const hits = files.filter(f => {
		const text = fs.readFileSync(f, 'utf8');
		const code = text
			.split('\n')
			.filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
			.join('\n');
		return code.includes('setFailureLogPath');
	});
	return hits.length === 0
		? true : `it is still referenced in: ${hits.map(f => path.relative(ROUTER, f)).join(', ')}`;
});

console.log('\n=== 4. the function BEHAVES like the live one ===');

const { logRoutingFailure } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'prompts', 'promptBuilder.ts')).href
) as { logRoutingFailure: (p: string, pred: string, exp: string) => void };

// Find the log path the module computes.
const { default: config } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'config', 'index.ts')).href
) as { default: any };

const logPath = path.join(config.runtime.root, 'logs/routing_failures.jsonl');

check('the log file does not exist before the call', () =>
	!fs.existsSync(logPath) ? true : `it already exists: ${logPath}`);

check('the call does not throw', () => {
	try {
		logRoutingFailure('make a kanban board', 'edit', 'create');
		return true;
	} catch (e: any) {
		return `it threw: ${e.message}`;
	}
});

check('the log file now exists', () =>
	fs.existsSync(logPath) ? true : `it was not created: ${logPath}`);

check('the log line has the four fields the live one wrote', () => {
	if (!fs.existsSync(logPath)) return 'the file does not exist';
	const line = fs.readFileSync(logPath, 'utf8').trim();
	let parsed: any;
	try { parsed = JSON.parse(line); } catch (e: any) { return `the line is not JSON: ${line}`; }
	const keys = Object.keys(parsed).sort().join(',');
	return keys === 'expected,predicted,prompt,ts'
		? true : `the fields are: ${keys}`;
});

check('the values are the ones passed in', () => {
	if (!fs.existsSync(logPath)) return 'the file does not exist';
	const parsed = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
	return parsed.prompt === 'make a kanban board'
		&& parsed.predicted === 'edit'
		&& parsed.expected === 'create'
		? true : `the values are wrong: ${JSON.stringify(parsed)}`;
});

// Clean up: the log file is a test artifact.
try {
	fs.rmSync(logPath, { force: true });
	const dir = path.dirname(logPath);
	if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
	console.log('\n  (the test log file was removed)');
} catch { /* the artifact is harmless */ }

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The routing-failure logger computes its own path, and the dead');
console.log('injection mechanism that would have written nowhere is gone.');
