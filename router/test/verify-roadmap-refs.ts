/**
 * Verifies every file:line reference in plans/CODE_CRAB_ROADMAP.md against
 * the actual current source. A roadmap with wrong line numbers is worse
 * than no roadmap.
 *
 * Run: node_modules/.bin/tsx scratch/verify-roadmap-refs.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ROUTER = path.join(ROOT, 'router');
const DOC = path.join(ROOT, 'plans', 'CODE_CRAB_ROADMAP.md');

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
const lines = (p: string) => read(p).split(/\r?\n/);

const indexTs = path.join(ROUTER, 'src', 'index.ts');
const validatorTs = path.join(ROUTER, 'src', 'validator.ts');
const gitHarnessTs = path.join(ROUTER, 'src', 'gitHarness.ts');
const configLocal = path.join(ROUTER, 'src', 'config', 'config.local.ts');
const chatRoutes = path.join(ROUTER, 'src', 'router', 'chatRoutes.ts');
const scaffold = path.join(ROUTER, 'src', 'frontendScaffold.ts');

/** Assert that `needle` appears on `lineNo` (1-indexed) of `file`. */
/**
 * Find the FIRST line containing `needle` and return its number.
 *
 * Content-anchored on purpose: line numbers shift on every router change,
 * so a line-number-anchored assertion goes stale constantly. The needle
 * must be unique enough in its file to identify one line.
 */
function find(file: string, needle: string): true | string {
	const L = lines(file);
	for (let i = 0; i < L.length; i++) {
		if (L[i]!.includes(needle)) return true;
	}
	return `${path.basename(file)} does not contain ${JSON.stringify(needle)}`;
}

/**
 * Remove comments from source text.
 *
 * Block comments MUST be stripped over the whole text first: a per-line
 * regex can never match a multi-line `/** ... *\/` doc comment, whose
 * body lines start with ` * `. The gitHarness doc comment explains why
 * `git add .` is dangerous, and a per-line stripper read that prose as
 * an actual command.
 */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(String.fromCharCode(10))
		.map(l => l.replace(/\/\/.*/, ''))
		.join(String.fromCharCode(10));
}

function at(file: string, lineNo: number, needle: string): true | string {
	const L = lines(file);
	const actual = L[lineNo - 1];
	if (actual === undefined) return `${path.basename(file)} has only ${L.length} lines; wanted ${lineNo}`;
	return actual.includes(needle)
		? true
		: `${path.basename(file)}:${lineNo} does not contain ${JSON.stringify(needle)}; got ${JSON.stringify(actual.trim().slice(0, 90))}`;
}

console.log('\n=== 1. the roadmap doc exists and is non-trivial ===');

check('plans/CODE_CRAB_ROADMAP.md exists', () =>
	fs.existsSync(DOC) ? true : 'missing');

check('the doc is substantial (>300 lines)', () =>
	lines(DOC).length > 300 ? true : `only ${lines(DOC).length} lines`);

console.log('\n=== 2. P0 file:line references resolve correctly ===');

// Phase 0.1 REMOVED the `mode !== 'create'` guards on Pattern 3 and
// Pattern 4. These assertions therefore check that the guards are GONE,
// not that they are present.
// The extraction implementation moved from src/index.ts into
// src/generation/pipelineHelpers.ts, so the pattern blocks are looked
// up in the COMBINED source of both files. The test does not care
// where the implementation lives — only that the behaviour is right.
const SOURCE_FILES = [
	path.join(ROUTER, 'src', 'index.ts'),
	path.join(ROUTER, 'src', 'generation', 'pipelineHelpers.ts'),
];
const source = (): string =>
	SOURCE_FILES.map(f => fs.existsSync(f) ? read(f) : '').join('\n');

/** Strip comments so prose mentioning a guard is not read as a guard. */
//
// Uses String.fromCharCode(10) rather than a '\n' literal: the patch
// tool has repeatedly mangled backslash escapes in this file, and a
// CRLF file leaving a trailing \r on each line does not affect the
// substring check this helper exists for.
const NL = String.fromCharCode(10);
const liveLines = (text: string): string =>
	text.split(NL).map((l: string) => l.replace(/\/\/.*/, '')).join(NL);

check('Pattern 3 exists and is no longer gated on create mode', () => {
	const src = source();
	const i = src.indexOf('// Pattern 3: Code fenced block');
	if (i < 0) return 'the Pattern 3 block is missing';
	const live = liveLines(src.slice(i, i + 1600));
	return !live.includes("mode !== 'create'") ? true : 'the P3 create-mode guard is BACK';
});

check('Pattern 4 exists and is no longer gated on create mode', () => {
	const src = source();
	const i = src.indexOf('// Pattern 4 (CRITICAL)');
	if (i < 0) return 'the Pattern 4 block is missing';
	const live = liveLines(src.slice(i, i + 1800));
	return !live.includes("mode !== 'create'") ? true : 'the P4 create-mode guard is BACK';
});

check('index.ts:4168 — responseTokenCount is computed', () =>
	find(indexTs, 'responseTokenCount'));

check('index.ts:3033 — MAX_TOKENS = 4096', () =>
	find(indexTs, 'MAX_TOKENS'));

check('index.ts:3485 — filesModified is declared', () =>
	find(indexTs, 'filesModified'));

check('index.ts:3739 — scaffold push (beBootstrapped)', () =>
	find(indexTs, 'beBootstrapped'));

check('index.ts:3745 — scaffold push (feBootstrapped)', () =>
	find(indexTs, 'feBootstrapped'));

check('index.ts:4365 — extractedForValidation', () =>
	find(indexTs, 'extractedForValidation'));

check('index.ts:4366 — validateJsxSymbols(extractedForValidation)', () =>
	find(indexTs, 'validateJsxSymbols'));

check('index.ts:4938 — validateJsxSymbols(feExtracted)', () =>
	find(indexTs, 'validateJsxSymbols'));

check('validator.ts:1365 — the callRe regex', () =>
	find(validatorTs, 'const callRe'));

check('validator.ts:1347 — SKIP_SYMS', () =>
	find(validatorTs, 'const SKIP_SYMS'));

check('gitHarness.ts — no BARE `git add .` command (it staged deletions)', () => {
	const src = read(gitHarnessTs);
	// Strip comments, then look for a bare `git add .` that is NOT the safe
	// per-file form `git add -- "<path>"`.
	//
	// The file uses CRLF, so a line comment must be stripped with a regex
	// 	// that tolerates the trailing CR. A "does the line start with //"
	// test is not enough: the comment is preceded by tabs.
	const live = stripComments(src);
	const bare = live.match(/git add \.(?![-\s])/);
	return !bare ? true : 'a bare `git add .` command is back — it stages deletions';
});

check('config.local.ts:15 — the frontend model path', () =>
	find(configLocal, 'frontend:'));

check('chatRoutes.ts:158 — makeChatRoutes export', () =>
	find(chatRoutes, 'makeChatRoutes'));

console.log('\n=== 3. the claims the roadmap makes are true ===');

check('P4 is NOT gated on mode !== \'create\' (the Phase 0 fix survived the consolidation)', () => {
	const src = source();
	const i = src.indexOf('// Pattern 4 (CRITICAL): Raw unfenced code detection');
	if (i < 0) return 'Pattern 4 comment not found';
	const blk = src.slice(i, i + 1800)
		.split(String.fromCharCode(10))
		.map(l => l.replace(/\/\/.*/, ''))
		.join(String.fromCharCode(10));
	return !blk.includes("mode !== 'create'") ? true : 'the P4 create-mode guard is BACK';
});

check('P3 is NOT gated on mode !== \'create\' (the Phase 0 fix survived the consolidation)', () => {
	const src = source();
	const i = src.indexOf('// Pattern 3: Code fenced block');
	if (i < 0) return 'Pattern 3 comment not found';
	const blk = src.slice(i, i + 1800)
		.split(String.fromCharCode(10))
		.map(l => l.replace(/\/\/.*/, ''))
		.join(String.fromCharCode(10));
	return !blk.includes("mode !== 'create'") ? true : 'the P3 create-mode guard is BACK';
});

check('no token-cap comparison exists (truncation is silent)', () => {
	const src = read(indexTs);
	for (const cap of ['genMaxTokens', 'maxTokens', 'MAX_TOKENS']) {
		if (new RegExp(`responseTokenCount\\s*(?:>=|===|==|>)\\s*${cap}\\b`).test(src)) {
			return `a cap comparison vs ${cap} exists`;
		}
	}
	return true;
});

check('makeChatRoutes is NOT imported anywhere (dead code confirmed)', () => {
	const hits: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.name === 'node_modules' || e.name === 'out' || e.name.startsWith('.')) continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith('.ts') && e.name !== 'chatRoutes.ts') {
				if (read(p).includes('makeChatRoutes')) hits.push(p);
			}
		}
	};
	walk(path.join(ROUTER, 'src'));
	return hits.length === 0 ? true : `imported by: ${hits.join(', ')}`;
});

check('the f16 FE model is on disk and the config prefers it (P0.7 applied)', () => {
	const f16 = path.join(ROUTER, 'models', 'base', 'qwen-fe-v4-f16.gguf');
	const q4 = path.join(ROUTER, 'models', 'base', 'qwen-fe-v4-q4_k_m.gguf');
	if (!fs.existsSync(f16)) return 'the f16 FE model is not on disk';
	if (!fs.existsSync(q4)) return 'the Q4 FE model is not on disk either';
	const cfg = read(configLocal);
	// P1.6 moved the selection into resolveModelPath(preferred, fallback).
	// The behaviour must be: prefer f16, fall back to Q4.
	const call = cfg.match(/resolveModelPath\('frontend model',\s*(\w+),\s*(\w+)\)/);
	if (!call) return 'the frontend model is not resolved through resolveModelPath';
	if (call[1] !== 'feF16Path') return `the preferred model is ${call[1]}, not feF16Path`;
	if (call[2] !== 'feQ4Path') return `the fallback is ${call[2]}, not feQ4Path`;
	return true;
});

check('the model sizes quoted in the roadmap are right', () => {
	const f16 = fs.statSync(path.join(ROUTER, 'models', 'base', 'qwen-fe-v4-f16.gguf')).size;
	const q4 = fs.statSync(path.join(ROUTER, 'models', 'base', 'qwen-fe-v4-q4_k_m.gguf')).size;
	const doc = read(DOC);
	const claimedF16 = doc.includes('6,178,316,672');
	const claimedQ4 = doc.includes('1,929,902,464');
	if (f16 !== 6178316672) return `f16 size is ${f16}, roadmap says 6,178,316,672`;
	if (q4 !== 1929902464) return `Q4 size is ${q4}, roadmap says 1,929,902,464`;
	return claimedF16 && claimedQ4 ? true : 'the roadmap does not quote both sizes';
});

check('the scaffold never CREATES App.tsx (so it always breaks the build)', () => {
	const src = read(scaffold);
	// Look for an actual write of App.tsx, not merely the string "App.tsx"
	// (the scaffold mentions it in progress.txt text and in a rename guard).
	const createsIt = /writeFileSync\(\s*[^)]*App\.tsx/.test(src)
		|| /['"`]src\/App\.tsx['"`]\s*\]\s*\)?\s*(?:\/\/.*)?$/.test(src)
		|| /copyFileSync\([^)]*App\.tsx/.test(src);
	if (createsIt) return 'the scaffold DOES write App.tsx — roadmap claim is stale';
	// Confirm main.tsx is created and imports ./App
	if (!/main\.tsx/.test(src)) return 'could not confirm main.tsx creation';
	// And confirm the string only appears in progress/rename contexts
	const mentions = src.split(/\r?\n/)
		.map((l, i) => [i + 1, l] as [number, string])
		.filter(([, l]) => l.includes('App.tsx'));
	const writes = mentions.filter(([, l]) => /writeFileSync|copyFileSync/.test(l));
	return writes.length === 0
		? true
		: `App.tsx appears on a write line: ${writes.map(([n, l]) => n).join(', ')}`;
});

check('main.tsx DOES import ./App (so the scaffold breaks tsc)', () => {
	const src = read(scaffold);
	// The scaffold writes src/main.tsx at ~line 402; the import is inside that
	// template. Anchor on the actual import line rather than a fixed offset.
	const m = src.match(/import\s+App\s+from\s+['"]\.\/App['"]/);
	return m
		? true
		: "could not find `import App from './App'` in the scaffold";
});

// P1.2 REMOVED the `git add .` — it staged deletions and made a run's
// file removals permanent. The assertion now checks there is no BARE
// `git add .` command. The safe per-file form `git add -- "<path>"` is
// allowed, and the prose in comments is ignored.
check('`git add .` is GONE — it staged deletions and destroyed user work', () => {
	const src = read(gitHarnessTs);
	const live = stripComments(src);
	const bare = live.match(/git add \.(?![-\s])/);
	return !bare ? true : '`git add .` is back';
});

check('the git harness stages only the files the agent wrote', () =>
	read(gitHarnessTs).includes('stageAgentFiles') ? true : 'stageAgentFiles is missing');

check('the git harness never stages a deletion', () => {
	const src = read(gitHarnessTs);
	const live = stripComments(src);
	return live.includes("code.includes('D')") ? true : 'deletions are not explicitly skipped';
});

console.log('\n=== 4. the training-data claims ===');

const DS = 'D:\\benchmark pipeline\\datasets';

check('train_sft.jsonl has 0 samples with the <file> envelope', () => {
	const p = path.join(DS, 'train_sft.jsonl');
	if (!fs.existsSync(p)) return 'train_sft.jsonl not found';
	const rows = read(p).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
	const tagged = rows.filter(r => String(r.response).includes('<file')).length;
	return tagged === 0 ? true : `${tagged} samples are tagged — roadmap claim is stale`;
});

check('train_sft.jsonl has exactly 11 rows (as the roadmap states)', () => {
	const p = path.join(DS, 'train_sft.jsonl');
	const rows = read(p).split(/\r?\n/).filter(l => l.trim());
	return rows.length === 11 ? true : `${rows.length} rows, roadmap says 11`;
});

check('the BE model appears 0 times in the training data', () => {
	const p = path.join(DS, 'train_dpo.jsonl');
	if (!fs.existsSync(p)) return 'train_dpo.jsonl not found';
	const rows = read(p).split(/\r?\n/).filter(l => l.trim());
	const n = rows.filter(l => l.includes('qwen-be')).length;
	return n === 0 ? true : `${n} BE references — roadmap claim is stale`;
});

check('the DPO set really contains 7 qwen-fe-v4-q4_k_m rejections', () => {
	const p = path.join(DS, 'train_dpo.jsonl');
	const rows = read(p).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
	const n = rows.filter((r: any) =>
		String(r?.provenance?.rejected_model ?? '').includes('qwen-fe-v4-q4_k_m')).length;
	return n === 7 ? true : `${n} rejections, roadmap says 7`;
});

check('TRUNCATED is a recorded rejection reason', () => {
	const p = path.join(DS, 'train_dpo.jsonl');
	const rows = read(p).split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
	return rows.some((r: any) => String(r.rejection_reason ?? '').toUpperCase().includes('TRUNC'))
		? true
		: 'no TRUNCATED rejection reason found';
});

console.log('\n=== 5. the verification scripts the roadmap advertises exist ===');

// The safety net lives in router/test/ (it is CODE, so it is committed
// and travels with the router). The one-off probes live in router/scratch/
// (they are FINDINGS, so they are not committed).
for (const s of ['verify-supervisor.ts', 'check-undefined-symbol.ts', 'check-chaining-defect.ts']) {
	check(`router/test/${s} exists`, () =>
		fs.existsSync(path.join(ROUTER, 'test', s)) ? true : 'missing');
}

for (const s of ['repro-dashboard.ts', 'be-probe.ts']) {
	check(`router/scratch/${s} exists`, () =>
		fs.existsSync(path.join(ROUTER, 'scratch', s)) ? true : 'missing');
}

// The suite itself must be runnable.
check('router/test/run-tests.ts exists', () =>
	fs.existsSync(path.join(ROUTER, 'test', 'run-tests.ts')) ? true : 'missing');

check('package.json has a test script', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROUTER, 'package.json'), 'utf8'));
	return pkg.scripts?.test ? true : 'package.json has no "test" script';
});

check('the golden fixtures exist', () => {
	const dir = path.join(ROUTER, 'test', 'fixtures');
	if (!fs.existsSync(dir)) return 'router/test/fixtures does not exist';
	const n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
	return n > 0 ? true : 'no golden fixtures were captured';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('All roadmap references and claims verified.');
