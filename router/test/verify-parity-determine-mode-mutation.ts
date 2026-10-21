/**
 * MUTATION CHECK for the determineMode parity test.
 *
 * A test that has never been observed to FAIL is not evidence.
 *
 * This deliberately breaks the consolidation five different ways and
 * confirms the parity test catches each one.
 *
 * The first mutation is the important one: it puts BACK the old
 * patterns — the ones that lost the create intent. That is the exact
 * regression this consolidation fixed.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

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

const MODULE = path.join(ROUTER, 'src', 'routing', 'agentMode.ts');
const INDEX = path.join(ROUTER, 'src', 'index.ts');
const PARITY = path.join(ROUTER, 'test', 'verify-parity-determine-mode.ts');

const modOriginal = fs.readFileSync(MODULE, 'utf8');
const indexOriginal = fs.readFileSync(INDEX, 'utf8');

function runParity(): { status: number | null; out: string } {
	const r = spawnSync(
		process.execPath,
		[path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), PARITY],
		{ cwd: ROUTER, encoding: 'utf8', timeout: 120000 },
	);
	return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function restore() {
	fs.writeFileSync(MODULE, modOriginal, 'utf8');
	fs.writeFileSync(INDEX, indexOriginal, 'utf8');
}

console.log('\n=== 0. the parity test passes on the unmodified source ===');
{
	const r = runParity();
	check('the parity test passes', () =>
		r.status === 0 ? true : `it failed:\n${r.out.slice(-400)}`);
}

console.log('\n=== 1. restoring the OLD patterns must FAIL the test ===');
{
	// The exact regression: the create-intent patterns for
	// board/kanban/component/dashboard/page are removed, so
	// "create a kanban board" on a workspace with files loses its
	// create intent.
	const m = modOriginal.replace(
		'|board|kanban|component|dashboard|page)',
		')',
	);
	if (m === modOriginal) {
		check('the mutation applies', () => 'the patterns were not found');
	} else {
		fs.writeFileSync(MODULE, m, 'utf8');
		const r = runParity();
		restore();
		check('removing the create-intent patterns makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed — the regression is not covered');
	}
}

console.log('\n=== 2. removing the whole Tier 1 block must FAIL the test ===');
{
	const m = modOriginal.replace(
		"if (explicitCreate.some(p => p.test(message))) return 'create';",
		"if (false) return 'create';",
	);
	if (m === modOriginal) {
		check('the mutation applies', () => 'the Tier 1 check was not found');
	} else {
		fs.writeFileSync(MODULE, m, 'utf8');
		const r = runParity();
		restore();
		check('disabling Tier 1 makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 3. making Tier 2 always fire must FAIL the test ===');
{
	// Tier 2 (the filesystem state) firing first is what swallowed the
	// create intent.
	const m = modOriginal.replace(
		'const specialistFilesExist = currentSpecialist === \'be\' ? backendFileCount > 0 : frontendFileCount > 0;',
		'const specialistFilesExist = true;',
	);
	if (m === modOriginal) {
		check('the mutation applies', () => 'the Tier 2 check was not found');
	} else {
		fs.writeFileSync(MODULE, m, 'utf8');
		const r = runParity();
		restore();
		check('making Tier 2 always fire makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 4. re-introducing a local copy in index.ts must FAIL ===');
{
	const local = `
function determineMode(
	message: string,
	currentSpecialist: 'be' | 'fe',
	backendFileCount: number,
	frontendFileCount: number,
): 'create' | 'edit' | 'needs_context' {
	return 'needs_context';
}

`;
	fs.writeFileSync(INDEX, indexOriginal + local, 'utf8');
	const r = runParity();
	restore();
	check('a re-introduced local copy makes the test fail', () =>
		r.status !== 0 ? true : 'the test still passed');
}

console.log('\n=== 5. removing the export must FAIL the test ===');
{
	const m = modOriginal.replace(
		'export function determineMode(',
		'function determineMode(',
	);
	if (m === modOriginal) {
		check('the mutation applies', () => 'the export was not found');
	} else {
		fs.writeFileSync(MODULE, m, 'utf8');
		const r = runParity();
		restore();
		check('removing the export makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 6. the source files are byte-identical ===');
check('agentMode.ts is byte-identical', () =>
	fs.readFileSync(MODULE, 'utf8') === modOriginal ? true : 'it was not restored');
check('index.ts is byte-identical', () =>
	fs.readFileSync(INDEX, 'utf8') === indexOriginal ? true : 'it was not restored');

console.log('\n=== 7. the parity test passes again ===');
{
	const r = runParity();
	check('the parity test passes', () =>
		r.status === 0 ? true : `it failed:\n${r.out.slice(-400)}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The parity test catches every mutation, including the exact');
console.log('regression this consolidation fixed.');
