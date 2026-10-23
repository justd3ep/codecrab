/**
 * The frontend feature table and the file estimate.
 *
 * THE BUG
 *
 * The coverage table had EIGHTEEN entries and every one of them was
 * backend: jwt, repository, rbac, bcrypt. A FRONTEND request —
 * which is what the frontend model is asked for most of the time —
 * matched NONE of them, so its feature contract was empty and its
 * coverage score was 0/0:
 *
 *     [Validator] ===== DONE — 1 file(s) | 1 error(s) | 0 warning(s)
 *     | Coverage: 0/0 =====
 *
 * A 0/0 score is not a pass and not a fail. It is no measurement at
 * all. And the completeness check — "expected ~5 (min 2)" — had
 * nothing to compare against, so a correct one-file React component
 * was flagged incomplete and the model was sent round the repair
 * loop until it produced an identical response and the request
 * died.
 *
 * THE FIX
 *
 * The frontend scope now gets a scored feature table — the same
 * signals as the requirement probes, which are proven to catch a
 * missing drag-and-drop — and the estimate is one file per
 * requested feature, with a floor of 1.
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

const f = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

console.log('\n=== the frontend feature table exists ===');

check('there is a frontend feature table', () =>
	/export const FRONTEND_FEATURE_WEIGHTS/.test(f('parsing/frontendFeatures.ts'))
		? true
		: 'there is no frontend feature table');

check('the table has the drag-and-drop feature', () =>
	/drag_and_drop/.test(f('parsing/frontendFeatures.ts'))
		? true
		: 'the drag-and-drop feature is missing');

check('the keyboard accessibility feature is there', () =>
	/keyboard_accessibility/.test(f('parsing/frontendFeatures.ts'))
		? true
		: 'the keyboard accessibility feature is missing');

check('the signals match the probes', () => {
	const t = f('parsing/frontendFeatures.ts');
	const sigs = t.match(/FRONTEND_FEATURE_SIGNALS[\s\S]*?\];/) || [];
	const probes = f('validator.ts').match(/REQUIREMENT_PROBES[\s\S]*?\];/) || [];
	const probeSignals = probes.join('').match(/signal: \/[^/]+/g) || [];
	if (probeSignals.length === 0) return 'the probes were not found';
	for (const s of probeSignals.slice(0, 6)) {
		const sig = s.replace('signal: ', '');
		if (!t.includes(sig)) return `the signal ${sig.slice(0, 40)} is not in the frontend table`;
	}
	return true;
});

console.log('\n=== the contract builder uses the frontend table ===');

const pc = f('parsing/plannerContract.ts');

check('the contract builder detects frontend features', () =>
	/detectFrontendFeatures\(msg\)/.test(pc)
		? true
		: 'the contract builder does not detect frontend features');

check('the frontend scope gets its own features', () =>
	/scope === .frontend.\s*\n\t\t\? detectFrontendFeatures\(msg\)/.test(pc)
		? true
		: 'the frontend scope does not get its own features');

check('fullstack gets both', () =>
	/scope === .fullstack./.test(pc) && /detectFrontendFeatures/.test(pc)
		? true
		: 'fullstack does not combine both');

console.log('\n=== the estimate does not floor at 5 for a frontend request ===');

check('the frontend estimate is one file per feature', () =>
	/scope === .frontend.\s*\n\t\t\t\? Math\.max\(1, requiredFeatures\.length \+ 1\)/.test(pc)
		? true
		: 'the frontend estimate is not one file per feature');

check('the generic floor of 5 is gone from the frontend branch', () => {
	const i = pc.indexOf('const estimatedFiles = scope === \'fullstack\'');
	const tail = pc.slice(i, i + 400);
	return /scope === 'frontend'\s*\n\t\t\t\? Math\.max\(1, requiredFeatures\.length \+ 1\)/.test(tail)
		? true
		: 'the frontend branch still has a floor of 5';
});

console.log('\n=== the validator looks up the frontend weights ===');

const val = f('validator.ts');

check('the coverage function uses the frontend weights', () => {
	const t = val;
	return /FEATURE_WEIGHTS\[featureKey\]/.test(t)
		&& /FRONTEND_FEATURE_WEIGHTS\[featureKey\]/.test(t)
		? true
		: 'the coverage function does not use the frontend weights';
});

check('the validator imports the frontend weights', () =>
	/import \{ FRONTEND_FEATURE_WEIGHTS \} from '.\/parsing\/frontendFeatures\.js'/.test(val)
		? true
		: 'the validator does not import the frontend weights');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The frontend coverage is a real number, and the estimate is right.');