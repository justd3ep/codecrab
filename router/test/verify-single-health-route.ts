/**
 * There must be ONE /health route, and it must serve the full
 * contract.
 *
 * THE BUG
 *
 * There were THREE implementations of /health and /stats:
 *
 *   1. the inline routes in index.ts     (the correct, newest)
 *   2. router/src/router/systemRoutes.ts  (a module, never mounted)
 *   3. router/src/router/healthRoutes.ts  (a module, mounted LAST)
 *
 * The third one is the dangerous one. Its /health contract is:
 *
 *     r.get('/health', ...).json({ status: 'ok', ts: ... })
 *
 * The real one is:
 *
 *     { router: 'ok', engine: 'node-llama-cpp', ollama: 'connected',
 *       ...mm.status, context, models, modelResolution }
 *
 * The editor reads the real one — the ISpecialistModel expects a
 * narrow domain/status union, and the router used to report
 * 'ready' / 'Frontend UI/UX', which matched neither, so the model
 * picker silently showed garbage. And a silent model fallback must
 * be visible, or a 3x-slower model hides.
 *
 * So the duplicate must be gone, and the surviving route must serve
 * the FULL contract.
 *
 * WHAT THIS PROVES
 *
 * Exactly one module serves /health, it is mounted, and it reports
 * every field the editor needs.
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
const systemSrc = read('router/systemRoutes.ts');

console.log('\n=== there is ONE /health route ===');

check('index.ts does not define /health inline', () =>
	!/app\.get\('\/health'/.test(indexSrc)
		? true
		: 'it still defines one inline');

check('index.ts does not define /stats inline', () =>
	!/app\.get\('\/stats'/.test(indexSrc)
		? true
		: 'it still defines one inline');

check('the healthRoutes module is gone', () =>
	!fs.existsSync(path.join(SRC, 'router', 'healthRoutes.ts'))
		? true
		: 'it still exists — and it serves a DIFFERENT contract');

check('index.ts does not import healthRoutes', () =>
	!indexSrc.includes('healthRoutes')
		? true
		: 'it still imports it');

console.log('\n=== the module is mounted ===');

check('index.ts mounts the system routes', () =>
	indexSrc.includes("app.use('/', makeSystemRoutes())")
		? true
		: 'it does not');

check('index.ts imports makeSystemRoutes', () =>
	/from\s+'\.\/router\/systemRoutes\.js'/.test(indexSrc) &&
	indexSrc.includes('makeSystemRoutes')
		? true
		: 'it does not');

console.log('\n=== the health contract is COMPLETE ===');

// Every field the editor reads.
const FIELDS: [string, string][] = [
	['router', "router: 'ok'"],
	['engine', "engine: 'node-llama-cpp'"],
	['ollama', "ollama: 'connected'"],
	['the model status', '...mm.status'],
	['the context usage', 'context: activeContextUsage'],
	['the model list', 'models: getAvailableModels()'],
	['the model resolution', 'modelResolution: config.modelResolution'],
];

for (const [label, needle] of FIELDS) {
	check(`the health route reports ${label}`, () =>
		systemSrc.includes(needle)
			? true
			: `it does not — the field "${needle}" is missing`);
}

console.log('\n=== the module serves the four routes ===');

for (const p of ['/health', '/stats', '/context-usage', '/v1/models']) {
	check(`the module serves ${p}`, () =>
		systemSrc.includes(`router.get('${p}'`)
			? true
			: 'it does not');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('There is one health route, and it is complete.');
