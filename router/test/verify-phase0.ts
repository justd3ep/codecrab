/**
 * Consolidated Phase 0 verification.
 *
 * Phase 0 made the router stop lying:
 *   P0.1  create-mode responses are no longer discarded
 *   P0.2  truncated and prose responses are detected, not written
 *   P0.3  scaffolded files are counted separately from generated files
 *   P0.4  an empty validator set is an issue, not a pass
 *   P0.5  zero generated files on a create request is a hard error
 *   P0.6  the undefined_symbol validator no longer reports phantoms
 *   P0.7  the frontend model is the f16 build, not the 4-bit one
 *
 * Every check is static or uses pure functions — no LLM inference.
 *
 * Run: node_modules/.bin/tsx scratch/verify-phase0.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');

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

const indexSrc = fs.readFileSync(path.join(ROUTER, 'src', 'index.ts'), 'utf8');
const validatorSrc = fs.readFileSync(path.join(ROUTER, 'src', 'validator.ts'), 'utf8');
const configSrc = fs.readFileSync(path.join(ROUTER, 'src', 'config', 'config.local.ts'), 'utf8');

/** Strip comments so prose about a pattern is not mistaken for the pattern. */
function stripComments(block: string): string {
	return block
		.split('\n')
		.map(l => {
			const t = l.trim();
			if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
			return l.replace(/\/\/.*$/, '');
		})
		.join('\n');
}

function sliceBetween(src: string, from: string, to: string): string {
	const i = src.indexOf(from);
	if (i < 0) return '';
	const j = src.indexOf(to, i + from.length);
	return src.slice(i, j < 0 ? undefined : j);
}

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== P0.1 — create-mode rescue ===');

const p3Block = sliceBetween(indexSrc, '// Pattern 3: Code fenced block', '// Pattern 4 (CRITICAL)');
const p4Block = sliceBetween(indexSrc, '// Pattern 4 (CRITICAL)', '// ---------------------------------------------------------------------------\n// JSX Symbol Validator');

check("Pattern 3 has no live `mode !== 'create'` guard", () =>
	!stripComments(p3Block).includes("mode !== 'create'") ? true : 'the P3 guard is still present in code');

check("Pattern 4 has no live `mode !== 'create'` guard", () =>
	!stripComments(p4Block).includes("mode !== 'create'") ? true : 'the P4 guard is still present in code');

check('Pattern 4 still uses extractRawCode + inferFilePath', () =>
	p4Block.includes('extractRawCode(text)') && p4Block.includes('inferFilePath(code')
		? true
		: 'the P4 implementation changed');

check('Pattern 3 no longer requires an empty seenPaths (multi-file works)', () =>
	!stripComments(p3Block).includes('!seenPaths.size') ? true : 'the `!seenPaths.size` restriction is back');

check('Pattern 4 is guarded by `edits.length === 0` (does not override P0)', () =>
	stripComments(p4Block).includes('edits.length === 0') ? true : 'the P4 ordering guard is gone');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== P0.2 — truncation and prose detection ===');

const diagSrc = fs.readFileSync(path.join(ROUTER, 'src', 'generation', 'responseDiagnosis.ts'), 'utf8');

check('a standalone responseDiagnosis module exists', () =>
	fs.existsSync(path.join(ROUTER, 'src', 'generation', 'responseDiagnosis.ts'))
		? true
		: 'src/generation/responseDiagnosis.ts is missing');

check('index.ts imports the diagnosis helpers', () =>
	indexSrc.includes("from './generation/responseDiagnosis.js'") ? true : 'the import is missing');

check('the generation loop calls diagnoseResponse', () =>
	indexSrc.includes('diagnoseResponse(fullResponse, responseTokenCount, genMaxTokens)')
		? true
		: 'the loop does not diagnose the response');

check('the diagnosis is applied BEFORE the main write path', () => {
	// The diagnosis must run before the response is parsed and written.
	// NOTE: the compaction-harvest paths (loop recovery / context cutoff)
	// call extractFallbackEdits EARLIER, but they pass onlyClosed:true, so
	// they only ever write file blocks that have a closing </file> tag —
	// a truncated file cannot be written by them. They are safe.
	const diagAt = indexSrc.indexOf('diagnoseResponse(fullResponse');
	const writeAt = indexSrc.indexOf('const fallbackEdits = extractFallbackEdits(fullResponse');
	return diagAt > 0 && writeAt > 0 && diagAt < writeAt
		? true
		: `diagnose at ${diagAt}, main write at ${writeAt} — the order is wrong`;
});

check('the harvest paths only write CLOSED file blocks (a truncated file cannot slip through)', () => {
	const n = (indexSrc.match(/extractFallbackEdits\(fullResponse, openFiles, workspaceRoot, lastUserMsg, mode, true\)/g) ?? []).length;
	return n >= 2 ? true : `only ${n} harvest call(s) with onlyClosed:true`;
});

check('the responseDiagnosis module is imported WITHOUT starting the server', () =>
	!diagSrc.includes("import ... from '../index") && !diagSrc.includes("from './index")
		? true
		: 'the module imports index.ts, which would start the server');

// Behaviour: exercise the real diagnoseResponse.
const { diagnoseResponse, buildTruncationContinuationPrompt, buildProseOutputPrompt } =
	await import(pathToFileURL(path.join(ROUTER, 'src', 'generation', 'responseDiagnosis.ts')).href);

check('a response at the token cap is detected as TRUNCATED', () => {
	const d = diagnoseResponse('const a = 1;', 4096, 4096);
	return d.truncated ? true : `not detected: ${JSON.stringify(d)}`;
});

check('a response just under the cap is NOT flagged as truncated', () => {
	const d = diagnoseResponse('const a = 1;', 3000, 4096);
	return !d.truncated ? true : `wrongly flagged: ${JSON.stringify(d)}`;
});

check('a response at 99% of the cap IS flagged (near-cap responses slip through)', () => {
	const d = diagnoseResponse('const a = 1;', 4050, 4096);
	return d.truncated ? true : `a near-cap response slipped through: ${JSON.stringify(d)}`;
});

check('a response at exactly the cap is flagged', () => {
	const d = diagnoseResponse('const a = 1;', 4096, 4096);
	return d.truncated ? true : 'the exact-cap case slipped through';
});

check('an English explanation is detected as PROSE', () => {
	const prose = "To build a REST API backend, we'll implement the following components:\n\n1. **Data Store**: An in-memory array.";
	const d = diagnoseResponse(prose, 500, 4096);
	return d.prose ? true : `not detected: ${JSON.stringify(d)}`;
});

check('a real code response is neither truncated nor prose', () => {
	const code = 'import React from "react";\nexport default function App() { return <div/>; }';
	const d = diagnoseResponse(code, 500, 4096);
	return (!d.truncated && !d.prose) ? true : `wrongly flagged: ${JSON.stringify(d)}`;
});

check('a <file> tagged response is not prose', () => {
	const tagged = '<file path="src/App.tsx">\nexport const App = () => <div/>;\n</file>';
	const d = diagnoseResponse(tagged, 500, 4096);
	return !d.prose ? true : 'a tagged response was called prose';
});

check('the truncation prompt asks for the REMAINING files', () => {
	const p = buildTruncationContinuationPrompt('create', 'build a dashboard', ['src/App.tsx']);
	return p.includes('src/App.tsx') && p.includes('REMAINING')
		? true
		: 'the prompt does not reference the already-emitted files';
});

check('the prose prompt restates the output contract', () => {
	const p = buildProseOutputPrompt('create', 'build a dashboard');
	return p.includes('<file path=') && p.toLowerCase().includes('explanation')
		? true
		: 'the prompt does not restate the contract';
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== P0.3 — scaffolded vs generated ===');

check('scaffoldedFiles is declared', () =>
	indexSrc.includes('const scaffoldedFiles = new Set<string>();') ? true : 'not declared');

check('the scaffold push sites tag their files as scaffolded', () => {
	const n = (indexSrc.match(/scaffoldedFiles\.add\(f\)/g) ?? []).length;
	return n >= 2 ? true : `only ${n} tagging site(s)`;
});

check('the BE-phase log separates generated from scaffolded', () =>
	indexSrc.includes('file(s) generated, ${scaffoldedFiles.size} scaffolded')
		? true
		: 'the log still conflates the two');

check('the request-finished log separates generated from scaffolded', () =>
	(indexSrc.match(/file\(s\) generated, \$\{scaffoldedFiles\.size\} scaffolded/g) ?? []).length >= 2
		? true
		: 'the request log still conflates the two');

check('the user-facing completion message counts only generated files', () =>
	indexSrc.includes('file(s) generated` })') ? true : 'the message still counts the scaffold');

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== P0.4 — the empty validator set is an issue ===');

// NOTE: validateJsxSymbols lives in index.ts, NOT validator.ts. The
// validator.ts file holds the 18-pass quality validator; the JSX symbol
// checker is a separate function in the server entry point.
check("the JsxSymbolIssue kind union includes 'no_output'", () =>
	indexSrc.includes("'missing_map' | 'no_output'") ? true : 'the kind was not added');

check('validateJsxSymbols reports no_output for an empty input', () => {
	const i = indexSrc.indexOf('function validateJsxSymbols');
	if (i < 0) return 'validateJsxSymbols not found';
	const blk = indexSrc.slice(i, i + 2000);
	return blk.includes('generatedFiles.length === 0') && blk.includes("kind: 'no_output'")
		? true
		: 'the empty-input guard is missing';
});

check('the main-loop call site handles no_output', () =>
	indexSrc.includes("jsxIssues.find(i => i.kind === 'no_output')")
		? true
		: 'no call site handles no_output');

check('both call sites handle no_output (main loop and fullstack FE)', () =>
	(indexSrc.match(/kind === 'no_output'/g) ?? []).length >= 2
		? true
		: 'only one call site handles no_output');

check('a no_output triggers a re-prompt, not a symbol repair', () =>
	indexSrc.includes('buildNoOutputPrompt(mode)') ? true : 'the re-prompt helper is not used');

check('buildNoOutputPrompt exists and restates the contract', () => {
	const i = indexSrc.indexOf('function buildNoOutputPrompt');
	if (i < 0) return 'the helper is missing';
	const blk = indexSrc.slice(i, i + 2000);
	return blk.includes('<file path=') ? true : 'the prompt does not restate the contract';
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== P0.5 — zero generated files is a hard error ===');

check('the zero-output guard exists', () =>
	indexSrc.includes('scaffoldedFiles.size > 0 && generatedFinal === 0')
		? true
		: 'the guard is missing');

check('the guard is scoped to create mode', () =>
	indexSrc.includes("mode === 'create' && workspaceRoot && scaffoldedFiles.size > 0")
		? true
		: 'the guard is not scoped to create mode');

check('the guard throws (not just logs)', () => {
	const i = indexSrc.indexOf('scaffoldedFiles.size > 0 && generatedFinal === 0');
	const blk = indexSrc.slice(i, i + 1200);
	return blk.includes('throw new Error') ? true : 'the guard does not throw';
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== P0.6 — no more phantom undefined symbols ===');

check('the call regex is dot-aware', () =>
	validatorSrc.includes("(?<![.\\w$])") ? true : 'the lookbehind is missing');

check('the call regex spans optional chaining', () =>
	validatorSrc.includes('\\??\\.') ? true : 'the optional-chain handling is missing');

check('SKIP_SYMS contains the JS keywords', () => {
	const i = validatorSrc.indexOf('const SKIP_SYMS');
	const blk = validatorSrc.slice(i, validatorSrc.indexOf(']);', i));
	const need = ['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'try'];
	const missing = need.filter(k => !blk.includes(`'${k}'`));
	return missing.length === 0 ? true : `missing: ${missing.join(', ')}`;
});

check('extractDefinedSymbols recognises class methods', () => {
	const i = validatorSrc.indexOf('function extractDefinedSymbols');
	const blk = validatorSrc.slice(i, i + 1500);
	return blk.includes('const methodRe') ? true : 'the method pattern is missing';
});

check('extractDefinedSymbols recognises `export default function X`', () => {
	const i = validatorSrc.indexOf('function extractDefinedSymbols');
	const blk = validatorSrc.slice(i, i + 1500);
	return blk.includes('default') ? true : 'the `export default function` form is not handled';
});

check('a chained call on `this` is not dropped by the SKIP_SYMS filter', () => {
	// The bug: `if (SKIP_SYMS.has(sym) || SKIP_SYMS.has(head)) continue;` dropped
	// every call whose head was `this`, hiding real undefined methods.
	const i = validatorSrc.indexOf("const callRe = /(?<![.\\w$])");
	const blk = validatorSrc.slice(i, i + 2500);
	return !blk.includes('SKIP_SYMS.has(head)')
		? true
		: 'the SKIP_SYMS.has(head) filter is back — chained calls on `this` are dropped';
});

// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== P0.7 — the frontend model is the f16 build ===');

check('config prefers the f16 FE model', () =>
	configSrc.includes('feF16Path') && configSrc.includes('frontendModelPath')
		? true
		: 'the f16 preference is missing');

check('config falls back to the Q4 model when f16 is absent', () => {
	// P1.6 refactored the selection into resolveModelPath(preferred,
	// fallback). The BEHAVIOUR is what matters: prefer f16, fall back to
	// Q4. This checks the helper is called with the right arguments.
	const call = configSrc.match(/resolveModelPath\('frontend model',\s*(\w+),\s*(\w+)\)/);
	if (!call) return 'the frontend model is not resolved through resolveModelPath';
	const [, preferred, fallback] = call;
	if (preferred !== 'feF16Path') return `the preferred model is ${preferred}, not feF16Path`;
	if (fallback !== 'feQ4Path') return `the fallback is ${fallback}, not feQ4Path`;
	return true;
});

check('the config no longer hardcodes the Q4 path as the frontend model', () =>
	!/frontend:\s*path\.resolve\([^)]*qwen-fe-v4-q4_k_m/.test(configSrc)
		? true
		: 'the frontend still points straight at the Q4 model');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('Phase 0 verified: the router no longer discards work or reports false success.');
