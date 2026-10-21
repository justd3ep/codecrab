/**
 * MUTATION CHECK for the buildTargetedRepairPrompt parity test.
 *
 * A test that has never been observed to FAIL is not evidence.
 *
 * This deliberately breaks the consolidation four different ways and
 * confirms the parity test catches each one.
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

const MODULE = path.join(ROUTER, 'src', 'repairEngine.ts');
const INDEX = path.join(ROUTER, 'src', 'index.ts');
const PARITY = path.join(ROUTER, 'test', 'verify-parity-targeted-repair.ts');

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

console.log('\n=== 1. restoring the STALE wording must FAIL the test ===');
{
	// The whole point of the consolidation: the live wording is
	// stronger, and the module must keep it.
	const m = modOriginal.replace(
		'### COMPILE ERRORS (fix type errors — do not restructure)',
		'### COMPILE ERRORS (fix type errors in these files)',
	);
	if (m === modOriginal) {
		check('the mutation applies', () => 'the live wording was not found');
	} else {
		fs.writeFileSync(MODULE, m, 'utf8');
		const r = runParity();
		restore();
		check('restoring the stale wording makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 2. removing the live wording must FAIL the test ===');
{
	const m = modOriginal.replace(
		'### COMPILE ERRORS (fix type errors — do not restructure)',
		'### COMPILE ERRORS',
	);
	if (m === modOriginal) {
		check('the mutation applies', () => 'the live wording was not found');
	} else {
		fs.writeFileSync(MODULE, m, 'utf8');
		const r = runParity();
		restore();
		check('weakening the live wording makes the test fail', () =>
			r.status !== 0 ? true : 'the test still passed');
	}
}

console.log('\n=== 3. re-introducing a local copy in index.ts must FAIL ===');
{
	// The consolidation must be a MOVE, not a copy. If index.ts
	// defines its own, the two can drift again.
	const local = `
function buildTargetedRepairPrompt(
	issues: ValidationIssue[],
	generatedFiles: string[] = [],
	workspaceRoot = '',
): string {
	return 'a local copy';
}

`;
	const m = indexOriginal + local;
	fs.writeFileSync(INDEX, m, 'utf8');
	const r = runParity();
	restore();
	check('a re-introduced local copy makes the test fail', () =>
		r.status !== 0 ? true : 'the test still passed');
}

console.log('\n=== 4. the module losing the export must FAIL the test ===');
{
	const m = modOriginal.replace(
		'export function buildTargetedRepairPrompt(',
		'function buildTargetedRepairPrompt(',
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

console.log('\n=== 5. the source files are byte-identical ===');
check('repairEngine.ts is byte-identical', () =>
	fs.readFileSync(MODULE, 'utf8') === modOriginal ? true : 'it was not restored');
check('index.ts is byte-identical', () =>
	fs.readFileSync(INDEX, 'utf8') === indexOriginal ? true : 'it was not restored');

console.log('\n=== 6. the parity test passes again ===');
{
	const r = runParity();
	check('the parity test passes', () =>
		r.status === 0 ? true : `it failed:\n${r.out.slice(-400)}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The parity test catches every mutation of the consolidation.');
