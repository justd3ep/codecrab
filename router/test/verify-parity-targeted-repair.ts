/**
 * The parity test for the buildTargetedRepairPrompt consolidation.
 *
 * WHAT WAS FIXED
 *
 * There were TWO copies of buildTargetedRepairPrompt:
 *
 *   index.ts (LIVE)              repairEngine.ts (STALE)
 *   143 lines                    141 lines
 *
 * They differed in ONE line — the compile-errors heading:
 *
 *   live:   ### COMPILE ERRORS (fix type errors — do not restructure)
 *   stale:  ### COMPILE ERRORS (fix type errors in these files)
 *
 * The live wording is the better one: "do not restructure" tells the
 * model what NOT to do. The stale wording says nothing about it, so a
 * model told to fix a type error would happily rewrite the file.
 *
 * chatRoutes.ts imports the MODULE copy, so mounting it would have
 * used the weaker instruction.
 *
 * WHAT THIS PROVES
 *
 *   1. The module holds the LIVE implementation.
 *   2. index.ts imports it rather than defining it.
 *   3. The prompt is CALLED, not grepped — with a real issue, the
 *      output must contain the live wording.
 *   4. The live instruction ("do not restructure") survives.
 *   5. The stale wording is gone.
 *   6. MUTATION: see verify-parity-targeted-repair-mutation.ts.
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

console.log('\n=== 1. the module holds the LIVE implementation ===');

const modSrc = read('src/repairEngine.ts');
const indexSrc = read('src/index.ts');

check('repairEngine.ts exports buildTargetedRepairPrompt', () =>
	/export function buildTargetedRepairPrompt\(/.test(modSrc)
		? true : 'it does not');

check('index.ts does NOT define it', () =>
	/^function buildTargetedRepairPrompt\(/m.test(indexSrc)
		? 'it still defines its own copy' : true);

// LOCATION-INDEPENDENT SINCE THE PHASE REFACTOR: the caller moved, so
// pinning index.ts tested the refactor. ONE definition, imported by
// every user, is the property.
{
	const anchor = await import(
		pathToFileURL(path.join(ROUTER, 'test', 'srcAnchor.ts')).href
	) as { singleSourceViolations: (root: string, name: string, moduleRel: string) => string[] };
	check('only repairEngine.ts defines buildTargetedRepairPrompt, and every user imports it', () => {
		const v = anchor.singleSourceViolations(ROUTER, 'buildTargetedRepairPrompt', 'repairEngine.ts');
		return v.length === 0 ? true : v.join('; ');
	});
}

check('the live wording is in the module', () =>
	modSrc.includes('### COMPILE ERRORS (fix type errors — do not restructure)')
		? true : 'the live wording is missing');

check('the STALE wording is gone', () =>
	modSrc.includes('### COMPILE ERRORS (fix type errors in these files)')
		? 'the stale wording is still there' : true);

console.log('\n=== 2. the prompt BEHAVIOUR: it is CALLED ===');

const mod = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'repairEngine.ts')).href
) as { buildTargetedRepairPrompt: (issues: any[], files?: string[], ws?: string) => string };

const build = mod.buildTargetedRepairPrompt;

const ISSUE = {
	severity: 'error',
	kind: 'compile_error',
	file: 'src/App.tsx',
	line: 12,
	message: "Type 'string' is not assignable to type 'number'.",
	category: 'type_error',
};

check('no issues produces an empty prompt', () => {
	const out = build([]);
	return out === '' ? true : `it returned ${JSON.stringify(out.slice(0, 80))}`;
});

check('a non-error issue is ignored', () => {
	const out = build([{ ...ISSUE, severity: 'warning' }]);
	return out === '' ? true : 'a warning produced a prompt';
});

check('an error issue produces a prompt', () => {
	const out = build([ISSUE], ['src/App.tsx'], '');
	return out.length > 0 ? true : 'the prompt was empty';
});

check('the prompt contains the LIVE compile-errors wording', () => {
	const out = build([ISSUE], ['src/App.tsx'], '');
	return out.includes('### COMPILE ERRORS (fix type errors — do not restructure)')
		? true : `the live wording is missing from:\n${out.slice(0, 400)}`;
});

check('the prompt does NOT contain the STALE wording', () => {
	const out = build([ISSUE], ['src/App.tsx'], '');
	return !out.includes('### COMPILE ERRORS (fix type errors in these files)')
		? true : 'the stale wording is still there';
});

check('the prompt names the file with the error', () => {
	const out = build([ISSUE], ['src/App.tsx'], '');
	return out.includes('src/App.tsx') ? true : 'the file is not named';
});

check('the prompt carries the error message', () => {
	const out = build([ISSUE], ['src/App.tsx'], '');
	return out.includes("Type 'string' is not assignable to type 'number'.")
		? true : 'the error message is missing';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The module holds the live buildTargetedRepairPrompt, with the');
console.log('stronger "do not restructure" instruction.');
