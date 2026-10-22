/**
 * The parity test for the three prompt-builder extractions.
 *
 * THE EXTRACTIONS
 *
 *   buildSystemPrompt     (33 lines)   -> prompts/promptBuilder.ts
 *   buildFESystemPrompt   (322 lines)  -> prompts/promptBuilder.ts
 *   ensembleRoute         (91 lines)   -> routing/ensembleRouter.ts
 *
 * WHAT WAS FIXED
 *
 * buildFESystemPrompt was 21 literals and 60 lines BEHIND. The live
 * version has five requirement rules the stale one lacked, and a
 * different architecture section:
 *
 *   stale:  '8. NEVER output "use client"; (this is a Vite React SPA...)'
 *   live:   '4. NEVER output "use client"; (this is a Vite React SPA...)'
 *
 * The live version renumbered the rules, and added:
 *
 *   'COMPONENT ARCHITECTURE (SINGLE-FILE HUB RULE)'
 *   'For this application, implement the entire solution
 *    self-contained inside `src/App.tsx`.'
 *   '1. 100% IMPORT CLOSURE: If you write `import Foo from
 *    "./components/Foo"`, you MUST generate `<file path="src/...'
 *   '1. Declare all TypeScript interfaces directly inside `src/App.tsx`.'
 *   '3. Helper subcomponents may be defined in the same file `src/App.tsx`.'
 *   '4. SEMANTIC MARKUP: real elements (section, ul/li, button, form),
 *    not a div soup.'
 *   '5. EVERY ID YOU QUERY MUST EXIST in your own markup — no dead
 *    getElementById targets.'
 *   '6. EVERY HANDLER MUST BE WIRED — a button without a listener is a defect.'
 *
 * The stale version also had a DIFFERENT stack-detection source: it
 * matched on keywords ('single file', 'no libraries', 'data table'),
 * while the live one uses the stack profile — the real detection, not
 * a keyword guess.
 *
 * WHAT THIS PROVES
 *
 *   1. The module holds the LIVE implementations; index.ts imports
 *      them and defines no copies.
 *   2. The live FE prompt's requirement rules are present, and the
 *      stale ones are gone.
 *   3. The FE prompt is CALLED, not grepped — a real context must
 *      produce a prompt carrying the live rules.
 *   4. The live stack detection (the stack profile) is used, not the
 *      old keyword guess.
 *   5. MUTATION: see verify-parity-prompt-builders-mutation.ts.
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

console.log('\n=== 1. the module holds the LIVE implementations ===');

const indexSrc = read('src/index.ts');
const promptSrc = read('src/prompts/promptBuilder.ts');
const ensembleSrc = read('src/routing/ensembleRouter.ts');

for (const name of ['buildSystemPrompt', 'buildFESystemPrompt']) {
	check(`promptBuilder.ts exports ${name}`, () =>
		new RegExp(`export function ${name}\\(`).test(promptSrc)
			? true : 'it does not');
	check(`index.ts does NOT define ${name}`, () =>
		new RegExp(`^function ${name}\\(`, 'm').test(indexSrc)
			? 'it still defines its own copy' : true);
}

check('index.ts imports them from prompts/promptBuilder', () => {
	// The names may be in any order.
	const m = /import\s*\{([^}]*)\}\s*from\s*'\.\/prompts\/promptBuilder\.js'/.exec(indexSrc);
	if (!m) return 'the import is missing';
	const names = m[1]!.split(',').map(s => s.trim());
	return names.includes('buildSystemPrompt') && names.includes('buildFESystemPrompt')
		? true : `the import is missing them: ${names.join(', ')}`;
});

check('ensembleRouter.ts exports ensembleRoute', () =>
	/export function ensembleRoute\(/.test(ensembleSrc) ? true : 'it does not');

check('index.ts does NOT define ensembleRoute', () =>
	/^function ensembleRoute\(/m.test(indexSrc)
		? 'it still defines its own copy' : true);

check('index.ts imports ensembleRoute', () =>
	/import\s*\{[^}]*ensembleRoute[^}]*\}\s*from\s*'\.\/routing\/ensembleRouter\.js'/.test(indexSrc)
		? true : 'the import is missing');

console.log('\n=== 2. the live FE prompt rules are present ===');

const LIVE_RULES = [
	'COMPONENT ARCHITECTURE (SINGLE-FILE HUB RULE)',
	'For this application, implement the entire solution self-contained inside `src/App.tsx`.',
	'1. 100% IMPORT CLOSURE',
	'1. Declare all TypeScript interfaces directly inside `src/App.tsx`.',
	'3. Helper subcomponents may be defined in the same file `src/App.tsx`.',
	'4. SEMANTIC MARKUP: real elements (section, ul/li, button, form), not a div soup.',
	'5. EVERY ID YOU QUERY MUST EXIST in your own markup — no dead getElementById targets.',
	'6. EVERY HANDLER MUST BE WIRED — a button without a listener is a defect.',
];

for (const rule of LIVE_RULES) {
	check(`the live rule is in the module: ${rule.slice(0, 52)}`, () =>
		promptSrc.includes(rule) ? true : 'it is missing');
}

console.log('\n=== 3. the STALE rules are gone ===');

check('the stale "8. NEVER output" numbering is gone', () =>
	promptSrc.includes('8. NEVER output "use client"')
		? 'the stale numbering is still there' : true);

check('the stale keyword-guess sources are gone', () => {
	const stale = ["'single file'", "'no libraries'", "'data table'", "'spreadsheet'"];
	const present = stale.filter(s => promptSrc.includes(s));
	return present.length === 0
		? true : `the old keyword guessing is still there: ${present.join(', ')}`;
});

check('the live stack-profile detection is used', () =>
	promptSrc.includes('detectStackProfile(')
		? true : 'the stack profile is not used');

console.log('\n=== 4. the FE prompt BEHAVIOUR: it is CALLED ===');

const { detectStackProfile } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'routing', 'stackProfile.ts')).href
) as { detectStackProfile: (msg: string, opts: any) => any };

const pb = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'prompts', 'promptBuilder.ts')).href
) as {
	buildFESystemPrompt: (ctx: any) => string;
	buildSystemPrompt: (...args: any[]) => string;
};

const CTX = {
	userMessage: 'build a task dashboard with a table',
	mode: 'create',
	activeFile: undefined,
	workspaceRoot: undefined,
	packageJson: undefined,
	openFiles: [],
};

check('a create request produces a prompt', () => {
	const out = pb.buildFESystemPrompt(CTX as any);
	return out.length > 0 ? true : 'the prompt was empty';
});

// The architecture rules are CONDITIONAL:
//
//   if (plainStack) { ... 'PLAIN STACK ARCHITECTURE RULES' ... }
//   else if (asksForSingleFile) { ... 'SINGLE-FILE HUB RULE' ... }
//
// `plainStack` is the stack profile's kind; `asksForSingleFile`
// needs the message to ask for a single file.

check('a single-file request uses the SINGLE-FILE HUB rules', () => {
	const out = pb.buildFESystemPrompt({
		...CTX,
		userMessage: 'build a simple single file widget with all state in src/app.tsx',
	} as any);
	return out.includes('COMPONENT ARCHITECTURE (SINGLE-FILE HUB RULE)')
		? true : `it does not:\n${out.slice(0, 300)}`;
});

check('the single-file rules include the interface rule', () => {
	const out = pb.buildFESystemPrompt({
		...CTX,
		userMessage: 'build a simple single file widget with all state in src/app.tsx',
	} as any);
	return out.includes('1. Declare all TypeScript interfaces directly inside `src/App.tsx`.')
		? true : 'it does not';
});

check('the single-file rules include the helper-subcomponent rule', () => {
	const out = pb.buildFESystemPrompt({
		...CTX,
		userMessage: 'build a simple single file widget with all state in src/app.tsx',
	} as any);
	return out.includes('3. Helper subcomponents may be defined in the same file `src/App.tsx`.')
		? true : 'it does not';
});

check('a MODULAR request uses the import-closure rules', () => {
	// The `100% IMPORT CLOSURE` rule lives in the MODULAR branch —
	// the ELSE of `asksForSingleFile`. A request that does NOT ask
	// for a single file takes it.
	const out = pb.buildFESystemPrompt({
		...CTX,
		userMessage: 'build a task dashboard with a table and several components',
	} as any);
	return out.includes('100% IMPORT CLOSURE')
		? true : `it does not:\n${out.slice(0, 300)}`;
});

check('the modular rules include the orphan rule', () => {
	const out = pb.buildFESystemPrompt({
		...CTX,
		userMessage: 'build a task dashboard with a table and several components',
	} as any);
	return out.includes('ZERO ORPHANS') ? true : 'it does not';
});

// The plain-stack branch needs a COMPLETE StackProfile — the prompt
// builder reads several of its fields. A partial profile throws.
//
// The profile is built with the router's OWN detectStackProfile(), so
// it is exactly what the router would produce.
const VANILLA_PROFILE = detectStackProfile('build a plain html page', {
	workspaceHasReact: false,
	packageJson: '',
});

check('a plain-stack request uses the plain architecture rules', () => {
	const out = pb.buildFESystemPrompt({
		...CTX,
		userMessage: 'build a plain html page',
		profile: VANILLA_PROFILE,
	} as any);
	return out.includes('PLAIN STACK ARCHITECTURE RULES')
		? true : `it does not:\n${out.slice(0, 300)}`;
});

check('the plain rules include the semantic-markup rule', () => {
	const out = pb.buildFESystemPrompt({
		...CTX,
		userMessage: 'build a plain html page',
		profile: VANILLA_PROFILE,
	} as any);
	return out.includes('4. SEMANTIC MARKUP: real elements (section, ul/li, button, form), not a div soup.')
		? true : 'it does not';
});

check('the plain rules include the wired-handler rule', () => {
	const out = pb.buildFESystemPrompt({
		...CTX,
		userMessage: 'build a plain html page',
		profile: VANILLA_PROFILE,
	} as any);
	return out.includes('6. EVERY HANDLER MUST BE WIRED — a button without a listener is a defect.')
		? true : 'it does not';
});

check('the prompt does NOT carry the stale "8. NEVER output"', () => {
	const out = pb.buildFESystemPrompt(CTX as any);
	return !out.includes('8. NEVER output "use client"')
		? true : 'the stale wording is still there';
});

check('buildSystemPrompt produces a prompt', () => {
	const out = pb.buildSystemPrompt('build a task app', false, 'create', 'fe', undefined, undefined, '', [], 'write', undefined);
	return typeof out === 'string' && out.length > 0
		? true : `it returned ${JSON.stringify(out)?.slice(0, 120)}`;
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The module holds the live prompt builders, and the live rules');
console.log('are in the prompt the model actually receives.');
