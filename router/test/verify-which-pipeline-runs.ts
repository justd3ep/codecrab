/**
 * Which chat pipeline actually runs?
 *
 * THE FINDING
 *
 * index.ts has TWO implementations of the chat pipeline:
 *
 *   1. runIncrementalEngine()      a separate module, in
 *                                   incrementalEngine.ts
 *   2. the monolithic try block    ~1,890 lines, with the BE loop
 *                                   (711 lines) and the FE loop
 *                                   (362 lines)
 *
 * And `useIncremental` decides. The decision is:
 *
 *     const useIncremental = readWriteMode === 'write'
 *         && shouldUseIncrementalEngine({
 *             intent, isCreate, graph, minNodes: 3,
 *         });
 *
 * and shouldUseIncrementalEngine is:
 *
 *     if (intent === 'frontend') return false;
 *     if (!graph || graph.nodes.length < minNodes) return false;
 *     return true;
 *
 * So for a FRONTEND request — which is what the frontend model is
 * asked for most of the time — the incremental engine NEVER runs,
 * and the monolithic loop is the live path.
 *
 * This was confirmed against a live request: the log shows
 * "[Router] --- Agentic iteration 1 ---", which is the monolithic
 * loop, and no "VNext incremental" line.
 *
 * WHY IT MATTERS
 *
 * Splitting the monolithic loop into phases is a lot of work. If
 * the incremental engine were the live path, the monolithic loop
 * would be dead code and could be deleted outright.
 *
 * So the question has to be answered BEFORE the refactor, not
 * after.
 *
 * WHAT THIS PROVES
 *
 * The decision logic is what it claims, and a frontend request
 * cannot take the incremental path.
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
const incSrc = read('incrementalEngine.ts');

console.log('\n=== the decision ===');

check('index.ts asks shouldUseIncrementalEngine', () =>
	indexSrc.includes('shouldUseIncrementalEngine({')
		? true
		: 'it does not');

check('the decision requires a graph of at least 3 nodes', () =>
	/minNodes:\s*3/.test(indexSrc)
		? true
		: 'the minNodes is not 3');

console.log('\n=== a frontend request NEVER takes the incremental path ===');

check('shouldUseIncrementalEngine refuses a frontend intent', () => {
	const i = incSrc.indexOf('export function shouldUseIncrementalEngine');
	if (i < 0) return 'the function was not found';
	const body = incSrc.slice(i, i + 600);
	return /if\s*\(intent\s*===\s*'frontend'\)\s*return false/.test(body)
		? true
		: 'it does not refuse a frontend intent';
});

check('the function is the one index.ts imports', () =>
	indexSrc.includes("from './incrementalEngine.js'") &&
	indexSrc.includes('shouldUseIncrementalEngine')
		? true
		: 'index.ts imports something else');

console.log('\n=== so the monolithic loop is the live path ===');

check('the monolithic BE loop exists', () =>
	/for\s*\(let\s+iteration\s*=/.test(indexSrc)
		? true
		: 'it does not');

check('the monolithic FE loop exists', () =>
	/for\s*\(let\s+feIter\s*=/.test(indexSrc)
		? true
		: 'it does not');

check('the incremental path returns early — it does not fall through', () => {
	// The incremental branch must end the request, or the
	// monolithic loop would run after it.
	const i = indexSrc.indexOf('runIncrementalEngine({');
	if (i < 0) return 'the call was not found';
	const seg = indexSrc.slice(i, i + 3000);
	// A res.end() or a return after the call.
	return /\bres\.end\(\)|^\s*return;/m.test(seg)
		? true
		: 'the incremental path does not end the request — the monolithic loop would run after it';
});

console.log('\n=== the two paths are not both live for the same request ===');

check('the incremental branch is guarded by useIncremental', () => {
	const i = indexSrc.indexOf('if (useIncremental && graph)');
	return i > 0 ? true : 'the guard was not found';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The monolithic loop is the live path for frontend requests.');
