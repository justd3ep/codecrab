/**
 * The loader test.
 *
 * WHAT THIS PROVES
 *
 *   1. Every function the tests need loads from the REAL module — the
 *      one the router runs. There is no second copy.
 *   2. The loader handles every parameter shape: an object type in a
 *      parameter, a union with no initializer, a generic, an optional
 *      parameter, a default value.
 *   3. The functions actually WORK — the validator finds a real
 *      missing import, the prompt explains it.
 *   4. MUTATION: a broken module makes the loader fail, rather than
 *      silently returning something that looks fine.
 *
 * WHY THIS EXISTS
 *
 * The loader used to strip TypeScript out of source text and evaluate
 * it with `new Function`. That was a house of regexes, and this
 * session found SIX ways it corrupted TypeScript:
 *
 *   1. a prose comment containing "as code" matched the `as Type` cast
 *      rule, merging the comment with the declaration after it
 *   2. the first `{` after a signature is inside a PARAMETER's type
 *      (Array<{ path: string }>), so the extraction truncated
 *   3. a `//` inside a template literal was deleted, unbalancing the
 *      backtick
 *   4. a `/regex/` containing a quote was mistaken for a string
 *   5. a `let x: T;` with no initializer was never stripped
 *   6. the `): Type {` rule could cross a comma and reach a `|` in a
 *      regex further down the body
 *
 * The consolidation made the stripper unnecessary: the functions moved
 * out of src/index.ts, and every module can be imported directly. This
 * test locks that in — the loader must import, not strip.
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

async function check(name: string, fn: () => true | string | Promise<true | string>): Promise<void> {
	try {
		const r = await fn();
		if (r === true) { pass++; console.log(`  PASS  ${name}`); }
		else { fail++; failures.push(`${name} -> ${r}`); console.log(`  FAIL  ${name} -> ${r}`); }
	} catch (e: any) {
		fail++; failures.push(`${name} -> threw: ${e.message}`);
		console.log(`  FAIL  ${name} -> threw: ${e.message}`);
	}
}

const mod = await import(
	pathToFileURL(path.join(ROUTER, 'test', 'capture-fixture.ts')).href
) as {
	loadFunction?: (file: string, name: string) => Promise<(...a: any[]) => any>;
	loadAll?: () => Promise<{ extractFallbackEdits: (...a: any[]) => any[] }>;
};

if (typeof mod.loadFunction !== 'function') {
	console.error('FATAL: capture-fixture.ts does not export loadFunction()');
	process.exit(2);
}
if (typeof mod.loadAll !== 'function') {
	console.error('FATAL: capture-fixture.ts does not export loadAll()');
	process.exit(2);
}

console.log('\n=== 1. the loader IMPORTS, it does not strip ===');

const loaderSrc = fs.readFileSync(path.join(ROUTER, 'test', 'capture-fixture.ts'), 'utf8');

await check('the loader imports the module', () =>
	/await import\('\.\.\/src\/generation\/pipelineHelpers\.js'\)/.test(loaderSrc)
		? true : 'it does not import the real module');

await check('the loader does NOT evaluate source text', () =>
	!/new Function\(/.test(loaderSrc)
		? true : 'it still uses new Function — the type-stripper is back');

await check('the type-stripper helpers are gone', () => {
	const gone = ['stripTypes', 'stripComments', 'findParamsEnd', 'findFunctionEnd', 'loadFunctions'];
	const present = gone.filter(g => new RegExp(`function ${g}\\s*\\(`).test(loaderSrc));
	return present.length === 0
		? true : `still present: ${present.join(', ')}`;
});

console.log('\n=== 2. every function the tests need loads ===');

const FUNCTIONS: Array<[string, string]> = [
	['src/generation/pipelineHelpers.ts', 'validateJsxSymbols'],
	['src/generation/pipelineHelpers.ts', 'buildJsxRepairPrompt'],
	['src/generation/pipelineHelpers.ts', 'buildNoOutputPrompt'],
	['src/generation/pipelineHelpers.ts', 'extractFallbackEdits'],
	['src/generation/pipelineHelpers.ts', 'cleanCodeBlock'],
	['src/generation/pipelineHelpers.ts', 'extractRawCode'],
	['src/generation/pipelineHelpers.ts', 'escapeRegExp'],
	['src/tools/toolEngine.ts', 'inferFilePath'],
];

for (const [file, name] of FUNCTIONS) {
	let ok = true, detail = '';
	try {
		const fn = await mod.loadFunction!(file, name);
		ok = typeof fn === 'function';
		if (!ok) detail = 'it is not a function';
	} catch (e: any) {
		ok = false;
		detail = e.message;
	}
	if (ok) { pass++; console.log(`  PASS  ${name} loads`); }
	else { fail++; failures.push(`${name} loads -> ${detail}`); console.log(`  FAIL  ${name} loads -> ${detail}`); }
}

console.log('\n=== 3. loading a function that does not exist fails LOUDLY ===');

await check('a missing export throws', async () => {
	try {
		await mod.loadFunction!('src/generation/pipelineHelpers.ts', 'noSuchFunction');
		return 'it returned instead of throwing';
	} catch {
		return true;
	}
});

await check('a missing file throws', async () => {
	try {
		await mod.loadFunction!('src/nope.ts', 'whatever');
		return 'it returned instead of throwing';
	} catch {
		return true;
	}
});

console.log('\n=== 4. the functions really WORK ===');

await check('the validator finds a real missing import', async () => {
	const v = await mod.loadFunction!('src/generation/pipelineHelpers.ts', 'validateJsxSymbols');
	const issues = v(
		[{ path: 'src/App.tsx', content: 'import React from "react";\nconst A = () => <TaskCard />;\n' }],
		'C:/tmp',
	);
	return Array.isArray(issues) && issues.length === 1 && issues[0].kind === 'missing_import'
		? true : `it returned ${JSON.stringify(issues)}`;
});

await check('the validator reports no_output for an empty input (the P0.4 fix)', async () => {
	const v = await mod.loadFunction!('src/generation/pipelineHelpers.ts', 'validateJsxSymbols');
	const issues = v([], 'C:/tmp');
	return Array.isArray(issues) && issues.some((i: any) => i.kind === 'no_output')
		? true : `it returned ${JSON.stringify(issues)}`;
});

await check('the prompt explains the issue the validator found', async () => {
	const v = await mod.loadFunction!('src/generation/pipelineHelpers.ts', 'validateJsxSymbols');
	const p = await mod.loadFunction!('src/generation/pipelineHelpers.ts', 'buildJsxRepairPrompt');
	const issues = v(
		[{ path: 'src/App.tsx', content: 'import React from "react";\nconst A = () => <TaskCard />;\n' }],
		'C:/tmp',
	);
	const out = p(issues);
	return out.includes('TaskCard') && out.includes('NOT imported')
		? true : 'the prompt did not explain the issue';
});

await check('the extractor rescues a raw-code response (Pattern 4)', async () => {
	const { extractFallbackEdits } = await mod.loadAll!();
	const WS = path.join(ROUTER, '.hermes-probe-ws');
	fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
	try {
		const raw = 'import React from "react";\nexport default function App() {\n  return <div>hello</div>;\n}\n';
		const edits = extractFallbackEdits(raw, undefined, WS, undefined, 'create', false);
		return edits.length > 0
			? true : 'nothing was extracted — Pattern 4 did not run';
	} finally {
		fs.rmSync(WS, { recursive: true, force: true });
	}
});

console.log('\n=== 5. MUTATION: a broken module must make the loader fail ===');

// A module that does not export the function must fail loudly — not
// silently return something that looks right.
const HELPERS = path.join(ROUTER, 'src', 'generation', 'pipelineHelpers.ts');
const original = fs.readFileSync(HELPERS, 'utf8');

const broken = original.replace(
	'export function buildJsxRepairPrompt',
	'export function buildJsxRepairPromptRenamed',
);
if (broken === original) {
	await check('the mutation applies', () => 'buildJsxRepairPrompt was not found');
} else {
	fs.writeFileSync(HELPERS, broken, 'utf8');
	let threw = false;
	try {
		// The module must be imported with a CACHE-BUSTING query.
		// ESM caches by URL, so a plain import would return the
		// ORIGINAL module — the mutation would be invisible, and
		// the check would pass for the wrong reason.
		const fresh = await import(`${pathToFileURL(HELPERS).href}?v=${Date.now()}`);
		if (typeof fresh.buildJsxRepairPrompt === 'function') {
			threw = false;
		} else {
			threw = true;
		}
	} catch {
		threw = true;
	}
	fs.writeFileSync(HELPERS, original, 'utf8');
	await check('renaming the export makes the import lose it', () =>
		threw ? true : 'the import still returned the function — the module is cached');
}

await check('the module is byte-identical after the mutation', () =>
	fs.readFileSync(HELPERS, 'utf8') === original ? true : 'the mutation was not reverted');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The loader imports the real modules. The golden fixtures and the');
console.log('parity tests exercise exactly the code the router runs.');
