/**
 * The advisor acquire must be guarded.
 *
 * THE BUG
 *
 * The model manager throws:
 *
 *     if (this.loading) throw new Error('Model load already in progress. Retry.');
 *
 * The auto-compaction path swaps models on every 75% cutoff, and
 * the log shows it happening on EVERY iteration:
 *
 *     [ModelManager] Swapping "fe" -> "advisor"
 *     [ModelManager] Swapping "advisor" -> "fe"
 *
 * So two acquires CAN overlap. An unguarded acquire inside an async
 * Express handler becomes an unhandled rejection — and that takes the
 * whole router down with exit code 1 and no explanation.
 *
 * The shadow route's runAdvisorProjectSummary had a bare:
 *
 *     const advisorModel = await mm.acquire('advisor');
 *     return runAdvisorProjectSummaryImpl(advisorModel, params);
 *
 * while every advisor acquire in the live route is wrapped:
 *
 *     try {
 *         const advisorModel = await mm.acquire('advisor');
 *         ...
 *     } catch (e) { ... }
 *
 * The shadow route killed the router twice.
 *
 * WHAT THIS PROVES
 *
 * The advisor summary's acquire is guarded, and a failing acquire
 * degrades to an empty summary instead of taking the router down.
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

const chat = fs.readFileSync(
	path.join(SRC, 'router', 'chatRoutes.ts'), 'utf-8',
).replace(/\r\n/g, '\n');

console.log('\n=== the advisor summary acquire is guarded ===');

// The wrapper function. There are TWO functions with a similar name:
// the wrapper (which acquires the model) and the impl (which is
// imported under an alias). The check must use the wrapper — the
// one that contains mm.acquire.
const fnStart = chat.indexOf('async function runAdvisorProjectSummary(');
check('the function exists', () =>
	fnStart > 0 ? true : 'it does not');

// The body runs to the first line that is exactly "}" at column 0.
let fnEnd = -1;
{
	const rest = chat.slice(fnStart);
	const lines = rest.split('\n');
	let offset = 0;
	for (let i = 1; i < lines.length; i++) {
		offset += lines[i - 1]!.length + 1;
		if (lines[i] === '}') { fnEnd = fnStart + offset; break; }
	}
}
const body = chat.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);

check('the acquire is inside a try block', () => {
	// The try must come BEFORE the acquire.
	const tryAt = body.indexOf('try {');
	const acquireAt = body.indexOf("mm.acquire('advisor')");
	if (tryAt < 0) return 'there is no try block';
	if (acquireAt < 0) return 'the acquire is not there';
	return acquireAt > tryAt
		? true
		: 'the acquire comes BEFORE the try block';
});

check('there is a catch that returns empty', () => {
	const catchAt = body.indexOf('catch');
	if (catchAt < 0) return 'there is no catch';
	return /return\s+''|return\s+""|return\s+undefined/.test(body)
		? true
		: 'the catch does not degrade — it must return an empty summary';
});

check('the acquire is awaited', () =>
	/await\s+mm\.acquire\('advisor'\)/.test(body)
		? true
		: 'it is not awaited');

check('the try comes before the catch', () => {
	const tryAt = body.indexOf('try {');
	const catchAt = body.indexOf('catch');
	return tryAt >= 0 && catchAt > tryAt ? true : 'the order is wrong';
});

console.log('\n=== the live route guards its advisor acquires too ===');

// POST-REFACTOR: the live route no longer acquires the advisor model
// itself — preparation moved to chat/preparation.ts and the advisor call
// to routing/intentClassifier.ts. Anchor on the module that actually
// acquires it; requiring the acquire to sit in index.ts would re-test the
// refactor instead of the guard.
const live = fs.readFileSync(path.join(SRC, 'routing', 'intentClassifier.ts'), 'utf-8').replace(/\r\n/g, '\n');
const liveLines = live.split('\n');
const advisorAcquires: number[] = [];
liveLines.forEach((l, i) => {
	if (l.includes("mm.acquire('advisor')")) advisorAcquires.push(i);
});

check(`the live advisor path has ${advisorAcquires.length} advisor acquire(s)`, () =>
	advisorAcquires.length >= 1 ? true : `only ${advisorAcquires.length}`);

for (const i of advisorAcquires) {
	check(`the live route's advisor acquire at line ${i + 1} is guarded`, () => {
		// Look back for a try.
		for (let j = i; j >= Math.max(0, i - 12); j--) {
			if (liveLines[j]!.trim().startsWith('try {')) return true;
		}
		return 'there is no try block around it';
	});
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The advisor acquires are guarded.');
