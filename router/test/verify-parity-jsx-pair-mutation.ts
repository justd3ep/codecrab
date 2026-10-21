/**
 * MUTATION CHECK for the JSX pair parity test.
 *
 * A test that has never been observed to FAIL is not evidence.
 *
 * This deliberately breaks the JSX pair in five different ways and
 * confirms the parity test catches each one:
 *
 *   1. remove the no_output kind         (the P0.4 fix)
 *   2. remove the missing_function kind
 *   3. remove the missingFilesToGenerate feature
 *   4. restore the stale prompt wording
 *   5. put the local definition BACK in index.ts (a re-introduced
 *      duplicate)
 *
 * The source is restored after each mutation, and the final check
 * confirms it is byte-identical to the original.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';

const HELPERS = path.join(ROUTER, 'src', 'generation', 'pipelineHelpers.ts');
const INDEX = path.join(ROUTER, 'src', 'index.ts');

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

const read = (p: string) => fs.readFileSync(p, 'utf8');

function runParity(): { status: number | null; out: string } {
	const r = spawnSync(
		process.execPath,
		[path.join('node_modules', 'tsx', 'dist', 'cli.mjs'),
		 path.join(ROUTER, 'test', 'verify-parity-jsx-pair.ts')],
		{ cwd: ROUTER, encoding: 'utf8', timeout: 120000 },
	);
	return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const helpersOriginal = read(HELPERS);
const indexOriginal = read(INDEX);

console.log('\n=== the baseline: the test passes ===');

const baseline = runParity();
check('the parity test passes on the unmodified source', () =>
	baseline.status === 0 ? true : `exit ${baseline.status}\n${baseline.out.slice(-400)}`);

console.log('\n=== 1. removing the no_output kind must FAIL the test ===');

const m1 = helpersOriginal.replace("kind: 'no_output'", "kind: 'no_output_removed'");
if (m1 === helpersOriginal) {
	check('the mutation applies', () => 'the no_output kind was not found');
} else {
	fs.writeFileSync(HELPERS, m1, 'utf8');
	const r = runParity();
	fs.writeFileSync(HELPERS, helpersOriginal, 'utf8');
	check('removing the no_output kind makes the test fail', () =>
		r.status !== 0 ? true : 'the test stayed green');
}

console.log('\n=== 2. removing the missing_function kind must FAIL the test ===');

const m2 = helpersOriginal.replace("kind: 'missing_function'", "kind: 'missing_function_removed'");
if (m2 === helpersOriginal) {
	check('the mutation applies', () => 'the missing_function kind was not found');
} else {
	fs.writeFileSync(HELPERS, m2, 'utf8');
	const r = runParity();
	fs.writeFileSync(HELPERS, helpersOriginal, 'utf8');
	check('removing the missing_function kind makes the test fail', () =>
		r.status !== 0 ? true : 'the test stayed green');
}

console.log('\n=== 3. removing the missing-file feature must FAIL the test ===');

// The mutation must remove the BEHAVIOUR, not the variable name. A
// rename would not remove the feature, and a name-based check would
// miss that — which is exactly what the first version of this test
// did.
const m3 = helpersOriginal.replace(
	'if (iss.missingFileTarget) missingFilesToGenerate.add(iss.missingFileTarget);',
	'// the missing-file tracking was removed',
);
if (m3 === helpersOriginal) {
	check('the mutation applies', () => 'the missing-file tracking was not found');
} else {
	fs.writeFileSync(HELPERS, m3, 'utf8');
	const r = runParity();
	fs.writeFileSync(HELPERS, helpersOriginal, 'utf8');
	check('removing the missing-file feature makes the test fail', () =>
		r.status !== 0 ? true : 'the test stayed green');
}

console.log('\n=== 3b. RENAMING the variable must NOT fail the test ===');

// A rename is not a behaviour change, so the test must stay green.
// This proves the check is behaviour-based, not name-based.
//
// The replacement is GLOBAL — a partial rename would leave the code
// referencing an undefined variable, which is a broken build, not a
// rename.
const m3b = helpersOriginal.replace(/missingFilesToGenerate/g, 'filesToGenerate');
if (m3b === helpersOriginal) {
	check('the rename mutation applies', () => 'the variable was not found');
} else {
	fs.writeFileSync(HELPERS, m3b, 'utf8');
	const r = runParity();
	fs.writeFileSync(HELPERS, helpersOriginal, 'utf8');
	check('renaming the variable does NOT fail the test (it is not a behaviour change)', () =>
		r.status === 0 ? true : 'the test is name-based, not behaviour-based');
}

console.log('\n=== 4. restoring the stale prompt wording must FAIL the test ===');

const m4 = helpersOriginal.replace(
	'Frontend code validation failed with the following critical errors:',
	'JSX symbol validation failed. The following components are broken:',
);
if (m4 === helpersOriginal) {
	check('the mutation applies', () => 'the live wording was not found');
} else {
	fs.writeFileSync(HELPERS, m4, 'utf8');
	const r = runParity();
	fs.writeFileSync(HELPERS, helpersOriginal, 'utf8');
	check('restoring the stale wording makes the test fail', () =>
		r.status !== 0 ? true : 'the test stayed green');
}

console.log('\n=== 5. re-introducing a local copy in index.ts must FAIL the test ===');

const m5 = indexOriginal.replace(
	"import { validateJsxSymbols, buildJsxRepairPrompt, ",
	"function validateJsxSymbols(a: any, b: any): any { return []; }\nimport { validateJsxSymbols, buildJsxRepairPrompt, ",
);
if (m5 === indexOriginal) {
	check('the mutation applies', () => 'the import line was not found');
} else {
	fs.writeFileSync(INDEX, m5, 'utf8');
	const r = runParity();
	fs.writeFileSync(INDEX, indexOriginal, 'utf8');
	check('a re-introduced local copy makes the test fail', () =>
		r.status !== 0 ? true : 'the test stayed green');
}

console.log('\n=== the source is restored ===');

check('pipelineHelpers.ts is byte-identical', () =>
	read(HELPERS) === helpersOriginal ? true : 'a mutation was not reverted');

check('index.ts is byte-identical', () =>
	read(INDEX) === indexOriginal ? true : 'a mutation was not reverted');

const final = runParity();
check('the parity test passes again', () =>
	final.status === 0 ? true : `exit ${final.status}\n${final.out.slice(-400)}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The parity test catches every mutation. It is real protection.');
