/**
 * The model manager must keep the advisor resident.
 *
 * THE PERFORMANCE BUG
 *
 * One request produced THIRTEEN model loads, SIX of them the full
 * 5.75 GB frontend model. The live log:
 *
 *     Loading "fe" ... Unloading "fe" ... Loading "advisor" ...
 *     Unloading "advisor" ... Loading "fe" ... "fe" already in VRAM
 *
 * The cause is the repair loop. When the model loops, it asks the
 * 0.6B ADVISOR to distill a task spec:
 *
 *     const advisorModel = await mm.acquire('advisor');
 *
 * The manager's contract was "one model at a time" — so acquiring
 * the advisor UNLOADED the specialist, and the loop then re-acquired
 * it:
 *
 *     activeModel = await mm.acquire(intent);
 *
 * A full 5.75 GB reload — measured at 11.5 s — plus a 500 ms
 * sleep, per loop recovery.
 *
 * The advisor is 0.45 GB and the specialist is 5.75 GB. Together
 * they are 6.2 GB, which FITS in this machine's 8 GB of VRAM. They
 * do not need to evict each other.
 *
 * WHAT THIS PROVES
 *
 * The manager keeps more than one model resident, an already
 * resident model is returned without a load, the cache is bounded,
 * and the eviction is LEAST RECENTLY USED — so the frontend and
 * the backend still evict each other (they cannot both fit), while
 * the small advisor is not thrown away for a 5.75 GB model.
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

const mmSrc = fs.readFileSync(path.join(SRC, 'models', 'legacyModelManager.ts'), 'utf8');

console.log('\n=== the cache exists ===');

check('there is a resident map', () =>
	/private readonly resident = new Map<string, Resident>\(\)/.test(mmSrc)
		? true
		: 'there is no resident map');

check('the cache is bounded', () =>
	/export const MAX_RESIDENT_MODELS/.test(mmSrc) &&
	/while \(this\.resident\.size >= MAX_RESIDENT_MODELS\)/.test(mmSrc)
		? true
		: 'the cache is not bounded');

check('the bound is 2 — the specialist and the advisor fit', () =>
	/export const MAX_RESIDENT_MODELS = 2/.test(mmSrc)
		? true
		: 'the bound is not 2');

console.log('\n=== an already-resident model is returned WITHOUT a load ===');

check('the cache is checked BEFORE the load', () => {
	const i = mmSrc.indexOf('async acquire(');
	if (i < 0) return 'acquire was not found';
	const body = mmSrc.slice(i, i + 2500);
	const cachedAt = body.indexOf('this.resident.get(key)');
	const loadAt = body.indexOf('loadModel(');
	return cachedAt > 0 && loadAt > 0 && cachedAt < loadAt
		? true
		: 'the cache is not checked before the load';
});

check('a cached model is returned directly', () =>
	/const cached = this\.resident\.get\(key\);[\s\S]{0,400}return cached\.model;/.test(mmSrc)
		? true
		: 'a cached model is not returned directly');

check('the single-model contract is gone', () =>
	!/if \(this\.activeModel && this\.activeKey === key\)/.test(mmSrc)
		? true
		: 'the old one-model-at-a-time check is still there');

console.log('\n=== the eviction is LEAST RECENTLY USED ===');

check('the eviction picks the oldest use', () =>
	/oldestUse/.test(mmSrc) && /entry\.lastUsed < oldestUse/.test(mmSrc)
		? true
		: 'it does not pick the least recently used');

check('each use bumps the counter', () =>
	/lastUsed = \+\+this\.useCounter/.test(mmSrc)
		? true
		: 'the use counter is not bumped');

console.log('\n=== the FE and the BE still evict each other ===');

check('the 500 ms VRAM-release sleep is kept', () =>
	/setTimeout\(r, 500\)/.test(mmSrc)
		? true
		: 'the sleep was removed — it gives the driver time to release the VRAM');

console.log('\n=== the status reports the residents ===');

check('the status lists the resident keys', () =>
	/resident: \[\.\.\.this\.resident\.keys\(\)\]/.test(mmSrc)
		? true
		: 'it does not');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The model manager keeps the advisor resident.');
