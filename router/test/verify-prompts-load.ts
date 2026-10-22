/**
 * The prompt loader must actually load the prompts.
 *
 * THE BUG
 *
 * src/prompts/promptBuilder.ts resolved the prompt files with:
 *
 *     path.join(import.meta.dirname, '../prompts', `${name}.md`)
 *
 * That file is at router/src/prompts/, so '../prompts' resolved to
 * router/src/prompts/ — where there are NO .md files. The prompts
 * are at router/prompts/ (51 of them, tracked in git).
 *
 * So EVERY prompt load failed, and the router went on to prompt the
 * model with the bare user request:
 *
 *     [Router] Warning: Could not load prompt fe/react.md
 *     [PromptRouter] WARN: fe/react.md not found
 *     ...
 *     PROMPTS LOADED:
 *     []
 *
 * No stack prompt. No framework guidance. No feature guidance. The
 * model was asked to write a whole application with nothing but the
 * user's sentence.
 *
 * The path was right when the function lived at
 * router/src/promptBuilder.ts. Moving the module into
 * router/src/prompts/ changed the depth by one and the path was not
 * updated.
 *
 * WHAT THIS PROVES
 *
 * The real prompt files load. And every prompt the code asks for by
 * name exists on disk — so a typo cannot silently degrade the
 * router the same way again.
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

const { loadPrompt } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'prompts', 'promptBuilder.ts')).href
) as { loadPrompt: (name: string) => string };

console.log('\n=== the loader loads the real prompts ===');

check('the fe/react prompt loads', () => {
	const content = loadPrompt('fe/react');
	return content.length > 0
		? true
		: 'it is empty — the path is wrong';
});

check('the fe/react prompt is substantial', () => {
	const content = loadPrompt('fe/react');
	return content.length > 400
		? true
		: `it is only ${content.length} characters — that is not a prompt`;
});

check('the be/agent prompt loads', () => {
	const content = loadPrompt('be/agent');
	return content.length > 0 ? true : 'it is empty';
});

check('a missing prompt returns empty rather than throwing', () => {
	const content = loadPrompt('fe/definitely-not-a-real-prompt');
	return content === '' ? true : `it returned ${content.length} characters`;
});

console.log('\n=== every prompt the code asks for exists ===');

const SRC = path.join(ROUTER, 'src');
const PROMPTS = path.join(ROUTER, 'prompts');

/** Every .ts file under src/. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (e.name.endsWith('.ts')) out.push(p);
	}
	return out;
}

/** The literal prompt names the code asks for. */
function requestedNames(): string[] {
	const names = new Set<string>();
	for (const f of walk(SRC)) {
		const text = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
		// loadPrompt('fe/react')
		for (const m of text.matchAll(/loadPrompt\(\s*['"`]([^'"`$]+)['"`]/g)) {
			names.add(m[1]!);
		}
		// load('react', ...) — the FE feature loader
		for (const m of text.matchAll(/\bload\(\s*['"`]([^'"`$]+)['"`]/g)) {
			names.add(`fe/${m[1]!}`);
		}
	}
	return [...names].sort();
}

const names = requestedNames();
console.log(`  ${names.length} prompt name(s) requested by the code`);

for (const n of names) {
	check(`the prompt "${n}" exists`, () =>
		fs.existsSync(path.join(PROMPTS, `${n}.md`))
			? true
			: 'it does not — the router would silently degrade');
}

console.log('\n=== the prompt directory is not empty ===');
const mdCount = fs.readdirSync(PROMPTS, { recursive: true })
	.filter(f => String(f).endsWith('.md')).length;
check('there are prompt files to load', () =>
	mdCount > 20 ? true : `only ${mdCount} .md file(s)`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The prompts load.');
