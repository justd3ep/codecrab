/**
 * The parity test for the determineMode consolidation.
 *
 * THIS ONE IS ALSO A BEHAVIOUR FIX
 *
 * For every other function, index.ts held the ahead copy. Here it was
 * the other way round: routing/agentMode.ts had the newer patterns,
 * and index.ts's local copy was BEHIND.
 *
 * The bug that caused:
 *
 * On a workspace that already has files, "create a kanban board"
 * missed Tier 1 (explicit create intent) in the live version. Tier 2
 * then fired — files exist -> 'edit'. The create intent was LOST:
 * the router would EDIT the existing app instead of creating a board.
 *
 * Tier 3 (projectNouns) is only reached when Tier 2 does NOT fire,
 * so on an existing workspace it never got a chance.
 *
 * The router's own prompt families include `kanban-plain` and
 * `create-mode-plain`, so "create a kanban board" is a first-class
 * request this router is supposed to handle.
 *
 * WHAT THIS PROVES
 *
 *   1. index.ts imports determineMode; it does not define its own.
 *   2. The BEHAVIOUR, measured:
 *      - "create a kanban board" on a workspace with files -> 'create'
 *      - "build a dashboard" on a workspace with files -> 'create'
 *      - "create a page" on a workspace with files -> 'create'
 *      - "create a component" on a workspace with files -> 'create'
 *      - "generate a kanban app" on a workspace with files -> 'create'
 *   3. The behaviour that must NOT change:
 *      - "add a button" on a workspace with files -> 'edit'
 *      - "fix the login bug" -> 'edit'
 *      - "from scratch" -> 'create'
 *      - "create a new project" -> 'create'
 *   4. MUTATION: see verify-parity-determine-mode-mutation.ts.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
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

console.log('\n=== 1. index.ts imports it, and does not define it ===');

const indexSrc = read('src/index.ts');
const modSrc = read('src/routing/agentMode.ts');

check('routing/agentMode.ts exports determineMode', () =>
	/export function determineMode\(/.test(modSrc) ? true : 'it does not');

check('index.ts does NOT define it', () =>
	/^function determineMode\(/m.test(indexSrc)
		? 'it still defines its own copy' : true);

check('index.ts imports it from routing/agentMode', () =>
	/import\s*\{[^}]*determineMode[^}]*\}\s*from\s*'\.\/routing\/agentMode\.js'/.test(indexSrc)
		? true : 'the import is missing');

console.log('\n=== 2. the BEHAVIOUR FIX: explicit create intent wins ===');

const mod = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'routing', 'agentMode.ts')).href
) as { determineMode: (msg: string, spec: 'be' | 'fe', be: number, fe: number) => string };

const determineMode = mod.determineMode;

// The workspace already has files — the case that used to lose the
// create intent.
const ON_EXISTING = { be: 0, fe: 3 } as const;

for (const message of [
	'create a kanban board',
	'build a kanban board',
	'create a dashboard',
	'build a dashboard',
	'create a page',
	'create a component',
	'generate a kanban app',
]) {
	check(`"${message}" on a workspace with files -> 'create'`, () => {
		const out = determineMode(message, 'fe', ON_EXISTING.be, ON_EXISTING.fe);
		return out === 'create'
			? true : `it returned '${out}' — the create intent was lost`;
	});
}

check('"create a page" on a backend workspace with files -> \'create\'', () => {
	const out = determineMode('create a page', 'be', 4, 0);
	return out === 'create' ? true : `it returned '${out}'`;
});

console.log('\n=== 3. the behaviour that must NOT change ===');

for (const [message, expected] of [
	['add a button', 'edit'],
	['fix the login bug', 'edit'],
	['update the styling', 'edit'],
] as const) {
	check(`"${message}" on a workspace with files -> '${expected}'`, () => {
		const out = determineMode(message, 'fe', ON_EXISTING.be, ON_EXISTING.fe);
		return out === expected ? true : `it returned '${out}'`;
	});
}

for (const [message, expected] of [
	['from scratch', 'create'],
	['new project', 'create'],
	['scaffold', 'create'],
	['create a new project', 'create'],
	['build a new backend', 'create'],
] as const) {
	check(`"${message}" -> '${expected}'`, () => {
		const out = determineMode(message, 'fe', ON_EXISTING.be, ON_EXISTING.fe);
		return out === expected ? true : `it returned '${out}'`;
	});
}

check('an ambiguous request on an EMPTY workspace -> \'needs_context\'', () => {
	const out = determineMode('do the thing', 'fe', 0, 0);
	return out === 'needs_context' ? true : `it returned '${out}'`;
});

check('an ambiguous request on a workspace with files -> \'edit\'', () => {
	const out = determineMode('do the thing', 'fe', ON_EXISTING.be, ON_EXISTING.fe);
	return out === 'edit' ? true : `it returned '${out}'`;
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The module holds determineMode, and the create intent is no');
console.log('longer lost on a workspace that already has files.');
