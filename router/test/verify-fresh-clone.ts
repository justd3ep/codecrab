/**
 * A fresh clone must have every file the source imports.
 *
 * THE BUG THIS CAUGHT
 *
 * router/.gitignore had a bare `models/`:
 *
 *     models/
 *
 * That was meant for the GGUF weights at router/models/. But git
 * matches a pattern with no slash against ANY directory at any
 * depth — so it also matched router/src/models/, which holds SOURCE
 * FILES:
 *
 *     embeddingManager.ts
 *     legacyModelManager.ts
 *     modelLease.ts
 *     modelManager.ts
 *
 * Seven tracked files import from there — including index.ts. So the
 * committed index.ts imported a file that was not in the repository:
 * a fresh clone could not build the router.
 *
 * The fix anchored the pattern to `/models/`.
 *
 * WHAT THIS CHECKS
 *
 * It clones the repository into a temp directory and verifies that
 * every relative import in every tracked .ts file resolves to a
 * file in the clone. It does not run npm install — that is too slow
 * for the suite — it checks the FILE GRAPH.
 *
 * The one allowed absence is ./config.local.js: the local config is
 * gitignored by design (it holds the machine's model paths), the
 * repo ships config.example.ts, and the config module raises a
 * formatted ConfigurationError with the path to fix when it is
 * missing. That is deliberate, not a defect.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';
const REPO = path.resolve(ROUTER, '..');

// The local config is gitignored by design.
const ALLOWED_MISSING = new Set(['./config.local.js']);

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

console.log('\n=== cloning the repository into a temp directory ===');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-clone-'));
const clone = path.join(tmp, 'repo');
console.log(`  ${tmp}`);

const cloneResult = spawnSync(
	'git',
	['clone', '--no-hardlinks', '--quiet', REPO, clone],
	{ encoding: 'utf8', timeout: 300000 },
);

let cloneOk = false;
check('the clone succeeded', () => {
	if (cloneResult.status === 0) { cloneOk = true; return true; }
	return `it failed: ${(cloneResult.stderr || '').slice(0, 300)}`;
});

if (cloneOk) {
	console.log('\n=== the model source files are in the clone ===');
	for (const rel of [
		'router/src/models/legacyModelManager.ts',
		'router/src/models/modelManager.ts',
		'router/src/models/embeddingManager.ts',
		'router/src/models/modelLease.ts',
	]) {
		check(`the clone has ${rel}`, () =>
			fs.existsSync(path.join(clone, rel)) ? true : 'it is missing');
	}

	console.log('\n=== the GGUF weights are correctly absent ===');
	check('no .gguf file is in the clone', () => {
		const dir = path.join(clone, 'router', 'models');
		if (!fs.existsSync(dir)) return true;
		const ggufs: string[] = [];
		const walk = (d: string) => {
			for (const e of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.name.endsWith('.gguf')) ggufs.push(p);
			}
		};
		walk(dir);
		return ggufs.length === 0 ? true : `${ggufs.length} weights were committed`;
	});

	console.log('\n=== every relative import resolves ===');
	const IMPORT_RE = /(?:from|import)\s*['"](\.[^'"]+)['"]/g;
	const missing: string[] = [];
	let checked = 0;

	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) { walk(p); continue; }
			if (!e.name.endsWith('.ts')) continue;
			const text = fs.readFileSync(p, 'utf8');
			for (const m of text.matchAll(IMPORT_RE)) {
				const spec = m[1]!;
				if (!spec.endsWith('.js')) continue;
				const cand = path.resolve(path.dirname(p), spec).replace(/\.js$/, '.ts');
				checked++;
				if (!fs.existsSync(cand) && !ALLOWED_MISSING.has(spec)) {
					missing.push(`${path.relative(clone, p)}  ->  ${spec}`);
				}
			}
		}
	};
	walk(path.join(clone, 'router', 'src'));

	console.log(`  ${checked} relative imports checked`);
	check('every relative import resolves to a file in the clone', () =>
		missing.length === 0
			? true
			: `${missing.length} unresolved:\n    ${missing.join('\n    ')}`);

	console.log('\n=== the local config is gitignored by design ===');
	check('the clone has config.example.ts', () =>
		fs.existsSync(path.join(clone, 'router', 'src', 'config', 'config.example.ts'))
			? true : 'it is missing');
	check('the config module reports a missing config clearly', () => {
		const idx = fs.readFileSync(path.join(clone, 'router', 'src', 'config', 'index.ts'), 'utf8');
		return idx.includes('validateConfig(undefined)')
			? true : 'the missing-config path is gone';
	});
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n  (the temp clone was removed)');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('A fresh clone has every file the source imports.');
