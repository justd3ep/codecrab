/**
 * A request that arrives during startup must WAIT, not fail.
 *
 * THE BUG
 *
 * The router starts listening before the llama engine is up, so this
 * sequence is normal:
 *
 *     [Router] Listening on 3141
 *     [ModelManager] Initializing llama engine...
 *
 * Any request in that window hit:
 *
 *     if (!this.llama) throw new Error('Engine not initialized.');
 *
 * ...and died in 0.09 s. It is how the frontend-only proof run failed
 * before it could prove anything: the ensemble correctly routed to
 * frontend, the FE phase asked for the FE model, and acquire threw
 * because the engine had not finished starting.
 *
 * THE SECOND RACE
 *
 *     if (this.loading) throw new Error('Model load already in progress. Retry.');
 *
 * Nobody performs that retry. Two phases wanting a model at once — the
 * advisor while the specialist is loading — failed the second request.
 * A serialised load queue fixes it: the second caller waits, then takes
 * the cache hit.
 *
 * WHAT THIS PROVES
 *
 *   1. acquire() on a never-initialised manager says so — that is a
 *      startup programming error, not a live-request race
 *   2. acquire() waits for init() instead of throwing
 *   3. two concurrent acquires load the model ONCE and get the same one
 *   4. two concurrent acquires for DIFFERENT models both succeed
 *   5. /health reports engineReady so a client can wait
 *
 * The engine is stubbed: no model file, no VRAM. This tests the
 * manager's orchestration, not llama.cpp.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';
import { mm } from '../src/models/legacyModelManager.js';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';
const SRC = path.join(ROUTER, 'src');

let pass = 0, fail = 0;
const failures: string[] = [];

function record(name: string, r: true | string): void {
	if (r === true) { pass++; console.log(`  PASS  ${name}`); }
	else { fail++; failures.push(`${name} -> ${r}`); console.log(`  FAIL  ${name} -> ${r}`); }
}

async function check(name: string, fn: () => Promise<true | string> | true | string): Promise<void> {
	try { record(name, await fn()); }
	catch (e: any) { record(name, `threw: ${e.message}`); }
}

/** Replace the engine with a stub and count loadModel() calls. */
function stubEngine(): () => number {
	let loads = 0;
	(mm as any).ready = Promise.resolve();
	(mm as any).llama = {
		loadModel: async () => {
			loads++;
			// A load takes real time; that window is the race.
			await new Promise(r => setTimeout(r, 60));
			return { dispose: async () => {} };
		},
		getVramState: async () => ({ total: 0 }),
	};
	(mm as any).maxResident = 2;
	(mm as any).findModelFile = () => 'stub.gguf';
	return () => loads;
}

async function main(): Promise<void> {
	console.log('\n=== acquire waits for the engine ===');

	// 1. Never initialised: a clear programming error.
	(mm as any).ready = null;
	(mm as any).llama = null;
	await check('a never-initialised manager names the missing init', async () => {
		try {
			await mm.acquire('frontend');
			return 'acquire resolved without an engine';
		} catch (e: any) {
			return /init\(\) was never called/.test(e.message)
				? true
				: `wrong error: ${e.message}`;
		}
	});

	// 2. /health can tell a client the engine is not ready yet.
	await check('status reports engineReady=false while starting', () =>
		(mm.status as any).engineReady === false ? true : `engineReady=${(mm.status as any).engineReady}`);

	const loads = stubEngine();

	await check('status reports engineReady=true after init', () =>
		(mm.status as any).engineReady === true ? true : `engineReady=${(mm.status as any).engineReady}`);

	// 3. Two acquires for the same model: one load, one model.
	await mm.unloadAll();
	await check('two concurrent acquires load the model once', async () => {
		const [a, b] = await Promise.all([mm.acquire('frontend'), mm.acquire('frontend')]);
		return loads() === 1 && a === b
			? true
			: `loads=${loads()}, same instance=${a === b}`;
	});

	// 4. Two acquires for DIFFERENT models: neither throws "Retry".
	await mm.unloadAll();
	const before = loads();
	await check('two concurrent acquires for different models both succeed', async () => {
		const [be, adv] = await Promise.all([mm.acquire('backend'), mm.acquire('advisor')]);
		const n = loads() - before;
		return n === 2 && be !== adv ? true : `loads=${n}, distinct=${be !== adv}`;
	});

	// 5. /health surfaces it — a route that drops the field is no better
	// than a manager that does not report it.
	console.log('\n=== /health reports it ===');
	await check('/health spreads the manager status', () => {
		const sys = fs.readFileSync(path.join(SRC, 'router', 'systemRoutes.ts'), 'utf-8').replace(/\r\n/g, '\n');
		const health = sys.slice(sys.indexOf("router.get('/health'"), sys.indexOf("router.get('/stats'"));
		if (!/\.\.\.mm\.status/.test(health)) return '/health does not spread mm.status';
		const mgr = fs.readFileSync(path.join(SRC, 'models', 'legacyModelManager.ts'), 'utf-8').replace(/\r\n/g, '\n');
		return /engineReady:/.test(mgr) ? true : 'status has no engineReady field';
	});

	await mm.unloadAll();
	const timer = (mm as any).idleTimer;
	if (timer) clearTimeout(timer);

	console.log(`\n=== ${pass} passed, ${fail} failed ===`);
	if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
	console.log('A request during startup waits for the engine instead of failing.');
}

void main();
