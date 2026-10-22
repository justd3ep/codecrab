/**
 * The shared constants must have exactly ONE copy.
 *
 * THE BUG THIS CAUGHT
 *
 * 23 constants were declared in two or three places. They all agreed
 * right now — but agreement is a coincidence of history, not a
 * guarantee. Three of the FUNCTIONS already found were stale copies
 * that had diverged:
 *
 *   extractFallbackEdits   the module copy was missing the create-mode fix
 *   buildJsxRepairPrompt   the module copy handled 1 issue kind, not 6
 *   executeToolCall        the module copy had no scaffold guard at all
 *
 * A constant can drift the same way. And one already HAD:
 * planning/requirementParser.ts held a BACKEND_ONLY_PATTERNS whose
 * regex differed —
 *
 *   the live copies:  /(?:[\w-]+\s+){0,3}(?:rest\s+|server\s+)?backend/i
 *   the stale one:     /(?:[\w-]+\s+)*(?:rest\s+|server\s+)?backend/i
 *
 * `{0,3}` versus `*` — up to three intervening words, versus any
 * number. Two different answers to "is this a backend request?".
 *
 * WHAT THIS CHECKS
 *
 * For each shared constant, exactly ONE file declares it. Every other
 * file that uses it imports it.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';
import { parse } from './ts-source-tool.js';

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

/** The shared constants. */
const SHARED = [
	'ARCH_DETECTION', 'ARCH_FOLDERS_MAP', 'BACKEND_ONLY_PATTERNS',
	'FEATURE_DETECTION', 'FRONTEND_ONLY_PATTERNS',
	'BE_AUTH_INFRA_PATTERN', 'BE_DB_PATTERN', 'BE_SERVER_PATTERN',
	'READ_PATTERNS', 'UI_COMPONENT_PATTERN', 'UI_DESIGN_PATTERN',
	'UI_FRAMEWORK_PATTERN', 'UI_INTERACTION_PATTERN', 'WRITE_PATTERNS',
	'GPU_LAYERS', 'IDLE_UNLOAD_MS',
	'MAX_AGENT_ITERATIONS', 'MAX_CORRECTIONS_PER_FILE', 'MAX_TOKENS',
	'MAX_TOTAL_CORRECTIONS', 'REPEAT_PENALTY', 'REPEAT_PENALTY_TOKENS',
	'REQUEST_TIMEOUT_MS',
];

/** Every .ts file under src/, relative to src/. */
function listTs(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...listTs(p, base));
		else if (e.name.endsWith('.ts')) out.push(path.relative(base, p).replace(/\\/g, '/'));
	}
	return out;
}

const files = listTs(SRC);
const infos = new Map<string, ReturnType<typeof parse>>();
for (const rel of files) {
	try { infos.set(rel, parse(path.join(SRC, rel))); } catch { /* skip */ }
}

console.log('\n=== 1. the dead file is gone ===');
check('planning/requirementParser.ts does not exist', () =>
	!fs.existsSync(path.join(SRC, 'planning', 'requirementParser.ts'))
		? true : 'it is still there');

console.log('\n=== 2. every shared constant has exactly ONE declaration ===');

for (const name of SHARED) {
	const declarers: string[] = [];
	for (const [rel, info] of infos) {
		const span = info.spans.get(name);
		if (!span) continue;
		// Is it a DECLARATION, not just a mention? The span starts
		// with `const NAME` / `export const NAME`.
		const text = info.text.slice(span.start, span.start + 60);
		if (new RegExp(`^(?:export\\s+)?(?:const|let|var|function|class)\\s+${name}\\b`).test(text)) {
			declarers.push(rel);
		}
	}
	check(`${name} is declared exactly once`, () =>
		declarers.length === 1
			? true
			: `declared ${declarers.length} times: ${declarers.join(', ')}`);
}

console.log('\n=== 3. every USER imports it rather than redeclaring it ===');

/** The module that holds each constant. */
const HOME: Record<string, string> = {
	ARCH_DETECTION: 'parsing/plannerContract.ts',
	ARCH_FOLDERS_MAP: 'parsing/plannerContract.ts',
	FEATURE_DETECTION: 'parsing/plannerContract.ts',
	BACKEND_ONLY_PATTERNS: 'parsing/constraintParser.ts',
	FRONTEND_ONLY_PATTERNS: 'parsing/constraintParser.ts',
	BE_AUTH_INFRA_PATTERN: 'routing/intentClassifier.ts',
	BE_DB_PATTERN: 'routing/intentClassifier.ts',
	BE_SERVER_PATTERN: 'routing/intentClassifier.ts',
	READ_PATTERNS: 'routing/intentClassifier.ts',
	UI_COMPONENT_PATTERN: 'routing/intentClassifier.ts',
	UI_DESIGN_PATTERN: 'routing/intentClassifier.ts',
	UI_FRAMEWORK_PATTERN: 'routing/intentClassifier.ts',
	UI_INTERACTION_PATTERN: 'routing/intentClassifier.ts',
	WRITE_PATTERNS: 'routing/intentClassifier.ts',
	GPU_LAYERS: 'models/legacyModelManager.ts',
	IDLE_UNLOAD_MS: 'models/legacyModelManager.ts',
	MAX_AGENT_ITERATIONS: 'index.ts',
	MAX_CORRECTIONS_PER_FILE: 'index.ts',
	MAX_TOKENS: 'index.ts',
	MAX_TOTAL_CORRECTIONS: 'index.ts',
	REPEAT_PENALTY: 'index.ts',
	REPEAT_PENALTY_TOKENS: 'index.ts',
	REQUEST_TIMEOUT_MS: 'index.ts',
};

for (const name of SHARED) {
	const home = HOME[name]!;
	const users: string[] = [];
	const bad: string[] = [];
	for (const [rel, info] of infos) {
		const uses = (info.text.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
		if (uses === 0) continue;
		users.push(rel);
		// The HOME module declares it — that is the point. Any OTHER
		// module that declares it too is a second copy.
		if (rel === home) continue;
		const span = info.spans.get(name);
		if (span) {
			const text = info.text.slice(span.start, span.start + 60);
			if (new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`).test(text)) {
				bad.push(rel);
			}
		}
	}
	if (users.length === 0) {
		check(`${name} is used somewhere`, () => true);
		continue;
	}
	check(`${name}: every user imports it (the home is ${home})`, () =>
		bad.length === 0 ? true : `still declares it locally: ${bad.join(', ')}`);
}

console.log('\n=== 4. the imports actually resolve ===');
for (const [rel, info] of infos) {
	const unresolved: string[] = [];
	for (const imp of info.imports) {
		if (!imp.module.startsWith('.')) continue;
		const cand = path.resolve(SRC, path.dirname(rel), imp.module.replace(/\.js$/, '.ts'));
		if (!fs.existsSync(cand)) unresolved.push(imp.module);
	}
	if (unresolved.length) {
		check(`${rel}: every relative import resolves`, () =>
			`unresolved: ${unresolved.join(', ')}`);
	}
}
check('every relative import in src/ resolves', () => true);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('Every shared constant has exactly one declaration, and every user');
console.log('imports it.');
