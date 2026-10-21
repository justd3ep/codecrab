/**
 * The parity test for the JSX pair extraction.
 *
 * The pair is {validateJsxSymbols, buildJsxRepairPrompt} plus the
 * JsxSymbolIssue type.
 *
 * WHAT WAS FIXED
 *
 * There were TWO copies of each:
 *
 *   index.ts (LIVE)              pipelineHelpers.ts (STALE)
 *   validator: 10,465 chars      validator:  3,301 chars
 *   prompt:     2,951 chars      prompt:     1,354 chars
 *
 * The live validator produced 7 issue kinds; the module's produced 2.
 * The live prompt handled 6 kinds; the module's handled 1. The module
 * copy also lacked the P0.4 no_output check.
 *
 * chatRoutes.ts imported the MODULE copy, so mounting it would have
 * silently downgraded the validator from 7 kinds to 2.
 *
 * WHAT THIS PROVES
 *
 *   1. The module holds the LIVE implementations — all 7 kinds, and
 *      the no_output check.
 *   2. index.ts imports them rather than defining them.
 *   3. The prompt's ACTUAL OUTPUT handles every kind the validator
 *      produces, except no_output (which has a different remedy — no
 *      output at all is not a symbol repair).
 *   4. The missing-file feature works end to end: a missing_file
 *      issue makes the prompt ask for the file to be generated.
 *   5. MUTATION: see verify-parity-jsx-pair-mutation.ts.
 *
 * The prompt is exercised by CALLING it, not by grepping the source.
 * A source-text check would be defeated by a rename; a behavioural one
 * is not.
 *
 * The type-stripper is the LOADER'S OWN, imported from
 * capture-fixture.ts — so this test and the golden fixtures strip
 * types the same way, and there is only one stripper to maintain.
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

const read = (p: string) => fs.readFileSync(p, 'utf8');
const norm = (s: string) => s.replace(/\r\n/g, '\n');
const indexSrc = norm(read(path.join(ROUTER, 'src', 'index.ts')));
const helpersSrc = norm(read(path.join(ROUTER, 'src', 'generation', 'pipelineHelpers.ts')));

console.log('\n=== 1. one implementation, and it is the LIVE one ===');

check('index.ts does NOT define validateJsxSymbols', () =>
	/function validateJsxSymbols/.test(indexSrc) ? 'it still defines it' : true);

check('index.ts does NOT define buildJsxRepairPrompt', () =>
	/function buildJsxRepairPrompt/.test(indexSrc) ? 'it still defines it' : true);

check('index.ts does NOT define the JsxSymbolIssue interface', () =>
	/interface JsxSymbolIssue/.test(indexSrc) ? 'it still defines it' : true);

check('the module exports validateJsxSymbols', () =>
	/export function validateJsxSymbols/.test(helpersSrc) || 'not exported');

check('the module exports buildJsxRepairPrompt', () =>
	/export function buildJsxRepairPrompt/.test(helpersSrc) || 'not exported');

check('the module exports the JsxSymbolIssue interface', () =>
	/export interface JsxSymbolIssue/.test(helpersSrc) || 'not exported');

check('index.ts imports the pair from the module', () =>
	/import \{[^}]*validateJsxSymbols[^}]*\} from '\.\/generation\/pipelineHelpers\.js'/.test(indexSrc)
		? true : 'the import is missing');

console.log('\n=== 2. the module has the LIVE capabilities ===');

const ALL_KINDS = [
	'missing_file',
	'missing_function',
	'missing_import',
	'missing_map',
	'no_output',
	'orphan_file',
	'prop_mismatch',
];

for (const kind of ALL_KINDS) {
	check(`the validator produces the "${kind}" kind`, () =>
		helpersSrc.includes(`kind: '${kind}'`) ? true : `the kind "${kind}" is missing`);
}

check('the P0.4 no_output check survived', () =>
	helpersSrc.includes("no_output") ? true : 'the no_output check is missing');

console.log('\n=== 3. the prompt is the live one — spot-check its text ===');

check('the prompt uses the live wording for a missing import', () =>
	helpersSrc.includes('Component <${iss.component} /> used but NOT imported.')
		? true : 'the live wording is missing');

check('the prompt uses the live wording for a missing file', () =>
	helpersSrc.includes('was imported from "${iss.importPath}"')
		? true : 'the live wording is missing');

check('the prompt ends with the live instruction', () =>
	helpersSrc.includes('[Validator] output the required files now.')
		? true : 'the live ending is missing');

check('the STALE wording is gone', () =>
	helpersSrc.includes("JSX symbol validation failed. The following components are broken:")
		? 'the stale wording is still there'
		: true);

console.log('\n=== 4. the module is the SOURCE OF TRUTH for chatRoutes.ts ===');

const chatRoutes = norm(read(path.join(ROUTER, 'src', 'router', 'chatRoutes.ts')));
check('chatRoutes.ts imports the pair from pipelineHelpers', () =>
	/buildJsxRepairPrompt/.test(chatRoutes) && /pipelineHelpers/.test(chatRoutes)
		? true : 'the import is missing');

check('chatRoutes.ts does NOT define its own copy', () =>
	/function buildJsxRepairPrompt/.test(chatRoutes) ? 'it defines its own' : true);

console.log('\n=== 5. the sizes match the live versions ===');

check('the module validator is the full 10K+ version, not the 3K stale one', () => {
	const i = helpersSrc.indexOf('export function validateJsxSymbols(');
	const j = helpersSrc.indexOf('\n}\n', i);
	const len = j - i;
	return len > 9000 ? true : `the validator is only ${len} chars — the stale one was ~3,300`;
});

check('the module prompt is the full 2.9K version, not the 1.3K stale one', () => {
	const i = helpersSrc.indexOf('export function buildJsxRepairPrompt(');
	const j = helpersSrc.indexOf('\n}\n', i);
	const len = j - i;
	return len > 2500 ? true : `the prompt is only ${len} chars — the stale one was ~1,350`;
});

console.log('\n=== 6. the prompt BEHAVIOUR: it handles every kind ===');

/**
 * Load the prompt builder from the module and CALL it.
 *
 * The module is imported DIRECTLY — the real implementation, not a
 * copy. So the prompt this test exercises is exactly the prompt the
 * router sends to the model.
 */
async function loadPromptBuilder(): Promise<(issues: any[]) => string> {
	const mod = await import(
		pathToFileURL(path.join(ROUTER, 'test', 'capture-fixture.ts')).href
	) as { loadFunction?: (file: string, name: string) => Promise<(...a: any[]) => any> };

	if (typeof mod.loadFunction !== 'function') {
		throw new Error('capture-fixture.ts does not export loadFunction()');
	}
	return await mod.loadFunction('src/generation/pipelineHelpers.ts', 'buildJsxRepairPrompt');
}

const buildPrompt = await loadPromptBuilder();

check('the prompt builder loads and can be called', () =>
	typeof buildPrompt === 'function' ? true : 'it is not a function');

if (typeof buildPrompt === 'function') {
	// One issue of each kind, and what the prompt must say about it.
	const CASES: Array<{ kind: string; issue: any; must: string }> = [
		{
			kind: 'missing_import',
			issue: { file: 'src/App.tsx', component: 'TaskCard', kind: 'missing_import' },
			must: 'used but NOT imported',
		},
		{
			kind: 'missing_file',
			issue: {
				file: 'src/App.tsx', component: 'TaskCard', kind: 'missing_file',
				importPath: './components/TaskCard', missingFileTarget: 'src/components/TaskCard.tsx',
			},
			must: 'NEVER generated',
		},
		{
			kind: 'missing_function',
			issue: {
				file: 'src/App.tsx', component: 'App', kind: 'missing_function',
				functionName: 'handleSubmit',
			},
			must: 'is NEVER declared, defined, or imported',
		},
		{
			kind: 'orphan_file',
			issue: { file: 'src/Orphan.tsx', component: 'Orphan', kind: 'orphan_file' },
			must: 'is NEVER imported or rendered anywhere',
		},
		{
			kind: 'prop_mismatch',
			issue: {
				file: 'src/App.tsx', component: 'TaskCard', kind: 'prop_mismatch',
				functionName: 'tasks',
			},
			must: 'does NOT declare',
		},
		{
			kind: 'missing_map',
			issue: {
				file: 'src/App.tsx', component: 'TaskList', kind: 'missing_map',
				functionName: 'items',
			},
			must: 'does NOT map over it',
		},
	];

	for (const c of CASES) {
		check(`the prompt explains the "${c.kind}" kind`, () => {
			const out = buildPrompt([c.issue]);
			return out.includes(c.must)
				? true : `the prompt did not mention "${c.must}"\n${out.slice(0, 400)}`;
		});
	}

	console.log('\n=== 7. the missing-file feature: the prompt ASKS for the file ===');

	// The feature is checked BEHAVIOURALLY: a missing_file issue must
	// make the prompt ask for the file to be generated. A name-based
	// check would fail on a harmless rename, and would miss the
	// removal of the tracking that actually makes the feature work.
	const missingFileIssue = {
		file: 'src/App.tsx', component: 'TaskCard', kind: 'missing_file',
		importPath: './components/TaskCard', missingFileTarget: 'src/components/TaskCard.tsx',
	};
	const out = buildPrompt([missingFileIssue]);

	check('the prompt asks the model to generate the missing file', () =>
		out.includes('You MUST generate the following missing component file(s) right now:')
			? true : 'the generation instruction is missing');

	check('the prompt includes the missing file path', () =>
		out.includes('src/components/TaskCard.tsx')
			? true : 'the missing file path is missing');

	check('the prompt includes a file block template for it', () =>
		out.includes('<file path="src/components/TaskCard.tsx">')
			? true : 'the file template is missing');

	// And the counter-case: a missing_file issue WITHOUT a target
	// must NOT ask for a file to be generated.
	const noTarget = buildPrompt([{
		file: 'src/App.tsx', component: 'TaskCard', kind: 'missing_file',
		importPath: './components/TaskCard',
	}]);
	check('without a target, the prompt does not ask for a file to be generated', () =>
		!noTarget.includes('You MUST generate the following missing component file(s)')
			? true : 'it asked for a file it does not know the name of');

	console.log('\n=== 8. the no_output kind is NOT a symbol repair ===');

	const noOut = buildPrompt([{ file: '', component: '', kind: 'no_output' }]);
	check('the prompt does not invent a symbol problem for no_output', () =>
		!noOut.includes('used but NOT imported') && !noOut.includes('NEVER generated')
			? true : 'it produced a symbol error for a no_output issue');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The module holds the LIVE JSX pair, and the prompt handles every');
console.log('kind the validator produces. Mounting chatRoutes.ts would no');
console.log('longer downgrade the validator from 7 kinds to 2.');
