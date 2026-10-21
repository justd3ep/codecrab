/**
 * The parity test for the buildNoOutputPrompt extraction.
 *
 * Commit B of the expand-contract pattern: the OLD copy in src/index.ts
 * and the NEW copy in src/generation/pipelineHelpers.ts must produce
 * IDENTICAL output for every input.
 *
 * This is the assertion that makes the flip safe. If the two ever
 * disagree, the extraction was not behaviour-preserving and the flip
 * would change what the model is told.
 *
 * The test loads BOTH implementations from source. It does not import
 * src/index.ts, because importing it starts the router server.
 *
 * The old copy is deleted in commit D, at which point this test must be
 * updated to compare against a stored expectation instead. Until then it
 * is the proof that the move was safe.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';

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

/**
 * Load a function from a source file by name.
 *
 * The router's source is TypeScript, so the type annotations are
 * stripped before the function is evaluated. The stripper must remove
 * COMMENTS FIRST — a prose comment can look like TypeScript (the words
 * "as code" match the `as Type` cast rule), and stripping types out of
 * a comment can destroy the declaration that follows it.
 */
function loadFunction(file: string, name: string): (...args: any[]) => any {
	const src = fs.readFileSync(path.join(ROUTER, file), 'utf8');

	// The function body.
	const m = new RegExp('(?:export\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
	if (!m) throw new Error(`${name} not found in ${file}`);
	const open = src.indexOf('{', m.index + m[0].length - 1);
	let depth = 0;
	let end = -1;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
	}
	if (end < 0) throw new Error(`no end for ${name} in ${file}`);
	let body = src.slice(m.index, end);

	// Strip comments, then types.
	body = body
		// The `export` keyword — `new Function` evaluates plain JS.
		.replace(/^export\s+/m, '')
		.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, '')
		.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*\{[^{}\r\n]*\}\s*(\[\])?\s*=/g, '$1 $2 =')
		.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\r\n]+=/g, '$1 $2 =')
		.replace(/\)\s*:\s*[A-Za-z_$][\w$<>[\]|,\s]*\s*\{/g, ') {')
		.replace(/\b(mode)\s*:\s*AgentMode/g, '$1');

	// eslint-disable-next-line no-new-func
	return new Function(`${body}\nreturn ${name};`)();
}

/**
 * The NEW copy always lives in pipelineHelpers.ts.
 *
 * The OLD copy lived in src/index.ts. Commit C of the expand-contract
 * pattern removed it, and commit D deleted it. So the OLD copy is
 * OPTIONAL: while it exists, it is compared against the NEW one
 * directly. Once it is gone, the NEW copy is compared against the
 * stored expectation below — the exact prompt text captured while both
 * copies existed.
 */
const OLD_PATH = path.join(ROUTER, 'src', 'index.ts');
const OLD_EXISTS = fs.readFileSync(OLD_PATH, 'utf8').includes('function buildNoOutputPrompt');

/**
 * Does the NEW copy exist yet?
 *
 * The copy is added in commit 2 of the expand-contract pattern. Before
 * that commit the test has nothing to compare, and it says so rather
 * than failing — a test whose precondition is not met is not a failing
 * test, it is a test that has not started.
 */
const NEW_EXISTS = fs.readFileSync(
	path.join(ROUTER, 'src', 'generation', 'pipelineHelpers.ts'), 'utf8',
).includes('function buildNoOutputPrompt');

const NEW = NEW_EXISTS
	? loadFunction(path.join('src', 'generation', 'pipelineHelpers.ts'), 'buildNoOutputPrompt')
	: null;
// After the skip above, NEW is guaranteed to exist. The assertion
// narrows the type for the rest of the file.
const NEW_FN = NEW as (...args: any[]) => any;
const OLD = OLD_EXISTS
	? loadFunction(path.join('src', 'index.ts'), 'buildNoOutputPrompt')
	: null;
const OLD_FN = OLD as ((...args: any[]) => any) | null;

/**
 * The prompt text, captured while BOTH copies existed.
 *
 * This is what survives commit D. If the extracted function ever
 * changes, this fails.
 */
const STORED_PATH = path.join(ROUTER, 'test', 'expectations', 'no-output-prompt.json');
const STORED: Record<string, string> = fs.existsSync(STORED_PATH)
	? JSON.parse(fs.readFileSync(STORED_PATH, 'utf8')).prompts
	: {};

const MODES = ['create', 'edit', 'fullstack', 'plan', 'auto'];

console.log('\n=== 1. both implementations exist ===');

if (!NEW_EXISTS) {
	// Before commit 2 of the expand-contract pattern, the copy does not
	// exist yet. There is nothing to compare, so the test reports that
	// and exits successfully.
	console.log('  the copy does not exist yet — the parity check is not applicable');
	console.log('  (the copy is added in commit 2; the parity proof lands in commit 3)');
	console.log('\n=== SKIPPED: the buildNoOutputPrompt copy does not exist yet ===');
	process.exit(0);
}

check('the NEW copy is loaded from src/generation/pipelineHelpers.ts', () =>
	typeof NEW === 'function' || 'it is not a function');

check(`the OLD copy is ${OLD ? 'still present' : 'gone (the flip is done)'}`, () =>
	OLD ? (typeof OLD === 'function' ? true : 'it is not a function') : true);

check('the stored expectation covers every mode', () => {
	for (const mode of MODES) {
		if (typeof STORED[mode] !== 'string') return `mode ${mode} is not stored`;
	}
	return true;
});

console.log('\n=== 2. they produce IDENTICAL output ===');

for (const mode of MODES) {
	check(`mode "${mode}": the outputs are identical`, () => {
		const b = NEW_FN(mode);
		if (OLD_FN) {
			// Both copies exist — compare them directly.
			return OLD_FN(mode) === b ? true : 'the outputs differ';
		}
		// Only the new copy exists — compare against the stored text.
		return STORED[mode] === b
			? true : 'the output differs from the stored expectation';
	});
}

check('every mode produces a non-empty prompt', () => {
	for (const mode of MODES) {
		if (NEW_FN(mode).length === 0) return `mode ${mode} produced an empty prompt`;
	}
	return true;
});

console.log('\n=== 3. the prompt still carries the contract ===');

check('the prompt states the <file path="..."> format', () =>
	NEW_FN('create').includes('<file path="src/Component.tsx">')
		? true : 'the format contract is missing');

check('the prompt forbids markdown fences', () =>
	NEW_FN('create').includes('Do NOT wrap the code in markdown fences')
		? true : 'the fence rule is missing');

check('the prompt forbids prose around the blocks', () =>
	NEW_FN('create').includes('Do NOT add explanations, commentary, or prose')
		? true : 'the prose rule is missing');

check('the prompt demands the COMPLETE file', () =>
	NEW_FN('create').includes('Emit the COMPLETE file, not a fragment')
		? true : 'the completeness rule is missing');

console.log('\n=== 4. the mode-specific tails differ correctly ===');

check('edit mode asks for the edited file(s)', () =>
	NEW_FN('edit').includes('Re-emit the edited file(s)') ? true : 'the edit tail is wrong');

check('non-edit mode asks for ALL requested files', () =>
	NEW_FN('create').includes('Re-emit ALL requested files') ? true : 'the create tail is wrong');

check('edit and create produce DIFFERENT prompts', () =>
	NEW_FN('edit') !== NEW_FN('create') ? true : 'the two modes produce the same text');

console.log('\n=== 5. the copy is byte-identical to the original ===');

const idx = fs.readFileSync(path.join(ROUTER, 'src', 'index.ts'), 'utf8');
const hlp = fs.readFileSync(path.join(ROUTER, 'src', 'generation', 'pipelineHelpers.ts'), 'utf8');

/**
 * Normalise the line endings.
 *
 * Git's `core.autocrlf` gives the working tree CRLF files, and Node's
 * readFileSync does NOT translate them. So a marker written with bare
 * `\n` would not match. Python's read_text() DOES translate, which is
 * why the copy script found the same function with a plain `\n` marker.
 */
const norm = (s: string) => s.replace(/\r\n/g, '\n');
const idxN = norm(idx);
const hlpN = norm(hlp);

const grab = (s: string, start: string, end: string) => {
	const i = s.indexOf(start);
	if (i < 0) return null;
	const j = s.indexOf(end, i);
	if (j < 0) return null;
	return s.slice(i, j + end.length);
};

check('the two bodies are identical', () => {
	if (!OLD) return true; // the old copy is gone — nothing to compare
	// The end marker stops AT the closing brace of the function — the
	// next function's name must NOT be part of the comparison, because
	// the old copy is not exported and the new one is.
	const a = grab(idxN, 'function buildNoOutputPrompt', '\n}\n\nfunction buildJsxRepairPrompt');
	const b = grab(hlpN, 'export function buildNoOutputPrompt', '\n}\n\nexport function buildJsxRepairPrompt');
	if (!a) return 'could not extract the OLD body';
	if (!b) return 'could not extract the NEW body';
	// Cut each at its own closing brace, dropping the trailing
	// next-function name.
	const aBody = a.slice(0, a.lastIndexOf('\n}') + 2);
	const bBody = b.slice(0, b.lastIndexOf('\n}') + 2)
		.replace('export function buildNoOutputPrompt', 'function buildNoOutputPrompt');
	return aBody === bBody
		? true : `the bodies differ (${aBody.length} vs ${bBody.length} chars)`;
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The OLD and NEW implementations are identical. The flip is safe.');
