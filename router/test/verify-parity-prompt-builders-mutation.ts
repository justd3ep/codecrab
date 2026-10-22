/**
 * MUTATION CHECK for the prompt-builder parity test.
 *
 * A test that has never been observed to FAIL is not evidence.
 *
 * This breaks the prompt builders six different ways and confirms
 * the parity test catches each one.
 *
 * The first three are the important ones: they remove a live
 * requirement rule from the prompt the model receives. A missing
 * rule is a silent quality loss — the model simply does not know.
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

const PROMPTS = path.join(ROUTER, 'src', 'prompts', 'promptBuilder.ts');
const INDEX = path.join(ROUTER, 'src', 'index.ts');
const PARITY = path.join(ROUTER, 'test', 'verify-parity-prompt-builders.ts');

const promptsOriginal = fs.readFileSync(PROMPTS, 'utf8');
const indexOriginal = fs.readFileSync(INDEX, 'utf8');

function runParity(): { status: number | null; out: string } {
	const r = spawnSync(
		process.execPath,
		[path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), PARITY],
		{ cwd: ROUTER, encoding: 'utf8', timeout: 180000 },
	);
	return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function restore() {
	fs.writeFileSync(PROMPTS, promptsOriginal, 'utf8');
	fs.writeFileSync(INDEX, indexOriginal, 'utf8');
}

console.log('\n=== 0. the parity test passes on the unmodified source ===');
{
	const r = runParity();
	check('the parity test passes', () =>
		r.status === 0 ? true : `it failed:\n${r.out.slice(-500)}`);
}

const MUTATIONS: Array<[string, string, string]> = [
	[
		'removing the SINGLE-FILE HUB rule',
		"'COMPONENT ARCHITECTURE (SINGLE-FILE HUB RULE)',",
		"'SOMETHING ELSE',",
	],
	[
		'removing the PLAIN STACK rule',
		"'PLAIN STACK ARCHITECTURE RULES',",
		"'SOMETHING ELSE',",
	],
	[
		'removing the IMPORT CLOSURE rule',
		"'1. 100% IMPORT CLOSURE: If you write `import Foo from \"./components/Foo\"`, you MUST generate `<file path=\"src/components/Foo.tsx\">` in this exact same response.',",
		"'1. something',",
	],
	[
		'removing the SEMANTIC MARKUP rule',
		"'4. SEMANTIC MARKUP: real elements (section, ul/li, button, form), not a div soup.',",
		"'4. something',",
	],
	[
		'removing the WIRED HANDLER rule',
		"'6. EVERY HANDLER MUST BE WIRED — a button without a listener is a defect.',",
		"'6. something',",
	],
	[
		'restoring the STALE keyword guessing',
		"'PLAIN STACK ARCHITECTURE RULES',",
		"'PLAIN STACK ARCHITECTURE RULES', 'single file', 'no libraries', 'data table',",
	],
];

for (const [name, from, to] of MUTATIONS) {
	console.log(`\n=== ${name} must FAIL the test ===`);
	const m = promptsOriginal.replace(from, to);
	if (m === promptsOriginal) {
		check(`${name} applies`, () => 'the text was not found');
		continue;
	}
	fs.writeFileSync(PROMPTS, m, 'utf8');
	const r = runParity();
	restore();
	check(`${name} makes the test fail`, () =>
		r.status !== 0 ? true : 'the test still passed');
}

console.log('\n=== a re-introduced local copy in index.ts must FAIL ===');
{
	const local = `
function buildFESystemPrompt(ctx: any): string {
	return 'a local copy';
}

`;
	fs.writeFileSync(INDEX, indexOriginal + local, 'utf8');
	const r = runParity();
	restore();
	check('a re-introduced local copy makes the test fail', () =>
		r.status !== 0 ? true : 'the test still passed');
}

console.log('\n=== the source files are byte-identical ===');
check('promptBuilder.ts is byte-identical', () =>
	fs.readFileSync(PROMPTS, 'utf8') === promptsOriginal ? true : 'it was not restored');
check('index.ts is byte-identical', () =>
	fs.readFileSync(INDEX, 'utf8') === indexOriginal ? true : 'it was not restored');

console.log('\n=== the parity test passes again ===');
{
	const r = runParity();
	check('the parity test passes', () =>
		r.status === 0 ? true : `it failed:\n${r.out.slice(-500)}`);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The parity test catches every mutation of the prompt builders.');
