/**
 * Capture golden fixtures.
 *
 * A golden fixture is a REAL model response, saved to disk, together with
 * the extraction result it must produce. It is the artifact that makes a
 * refactor of `src/index.ts` safe: if the extraction path changes
 * behaviour, the fixture test fails.
 *
 * WHY REAL RESPONSES
 * Invented inputs test the code against your assumptions. Real inputs
 * test it against reality — including the weird shapes the model
 * actually produces (truncated mid-word, prose before the code, a
 * missing closing tag, a stray ``` fence).
 *
 * HOW TO CAPTURE
 *   1. Start the router:      npm start
 *   2. Send a prompt to it and keep the raw response.
 *   3. Run:  tsx scratch/capture-fixture.ts <name> <file>
 *      or pipe it:  ... | tsx scratch/capture-fixture.ts <name> -
 *
 * The script extracts the response with the LIVE extractor, records the
 * result, and writes it to router/scratch/fixtures/.
 *
 * A fixture is only trustworthy if it came from a real model. Hand-made
 * fixtures are allowed but must be labelled `synthetic: true` so nobody
 * mistakes them for evidence.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures');

const indexPath = path.join(ROUTER, 'src', 'index.ts');
const toolEnginePath = path.join(ROUTER, 'src', 'tools', 'toolEngine.ts');
const pipelineHelpersPath = path.join(ROUTER, 'src', 'generation', 'pipelineHelpers.ts');

// ══════════════════════════════════════════════════════════════════════
// Lexical scanning
// ══════════════════════════════════════════════════════════════════════

/**
 * Find the end of a function body, by brace matching that understands the
 * lexical contexts where a brace does NOT count:
 *
 *   - a string literal:      'a { b'
 *   - a template literal:    `a { b`  (and its ${} interpolation)
 *   - a regex literal:       /a{2,3}/
 *   - a line comment:        // a {
 *   - a block comment:       /* a { * /
 *
 * A naive counter gets this wrong: `inferFilePath` contains regexes with
 * braces, so the counter never reaches the function's closing brace and
 * the extract silently runs to the end of the file.
 *
 * Returns the index just past the closing brace, or -1.
 */
function findFunctionEnd(src: string, openBraceIndex: number): number {
	let depth = 0;
	let i = openBraceIndex;
	let prev = '';

	const regexMayStart = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

	while (i < src.length) {
		const c = src[i]!;
		const next = src[i + 1] ?? '';

		if (c === '/' && next === '/') {
			const nl = src.indexOf('\n', i);
			if (nl < 0) return -1;
			i = nl + 1;
			continue;
		}
		if (c === '/' && next === '*') {
			const end = src.indexOf('*/', i + 2);
			if (end < 0) return -1;
			i = end + 2;
			prev = ' ';
			continue;
		}
		if (c === "'" || c === '"') {
			const quote = c;
			i++;
			while (i < src.length) {
				if (src[i] === '\\') { i += 2; continue; }
				if (src[i] === quote) { i++; break; }
				i++;
			}
			prev = 'x';
			continue;
		}
		if (c === '`') {
			i++;
			while (i < src.length) {
				if (src[i] === '\\') { i += 2; continue; }
				if (src[i] === '`') { i++; break; }
				if (src[i] === '$' && src[i + 1] === '{') {
					const inner = findFunctionEnd(src, i + 1);
					if (inner < 0) return -1;
					i = inner;
					continue;
				}
				i++;
			}
			prev = 'x';
			continue;
		}
		if (c === '/' && regexMayStart.has(prev)) {
			let j = i + 1;
			let inClass = false;
			let ok = false;
			while (j < src.length) {
				const r = src[j]!;
				if (r === '\\') { j += 2; continue; }
				if (r === '\n') break;
				if (r === '[') inClass = true;
				else if (r === ']') inClass = false;
				else if (r === '/' && !inClass) { ok = true; j++; break; }
				j++;
			}
			if (ok) {
				while (j < src.length && /[a-z]/.test(src[j]!)) j++;
				i = j;
				prev = 'x';
				continue;
			}
		}

		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return i + 1;
		}

		if (!/\s/.test(c)) prev = c;
		i++;
	}
	return -1;
}

/**
 * Strip the TypeScript-only syntax so the function can be evaluated as
 * plain JavaScript.
 */
function stripTypes(src: string): string {
	return src
		// An optional parameter: `openFiles?: string[]` -> `openFiles`.
		.replace(/([A-Za-z_$][\w$]*)\?\s*:\s*[A-Za-z_$][\w$<>[\]|,\s]*?(?=\s*[,)=])/g, '$1')
		.replace(/([(,]\s*)([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>[\]|,\s]*?(?=\s*[,)=])/g, '$1$2')
		// The non-null assertion: `foo!` — but not `!==`, `!=` or a leading `!`.
		.replace(/\]!/g, ']')
		.replace(/\)(!)(?=[.\s,;)\]}])/g, ')')
		.replace(/([A-Za-z_$][\w$]*)!(?=[.\s,;)\]}=])/g, '$1')
		// The cast: `x as string`.
		.replace(/\s+as\s+[A-Za-z_$][\w$<>[\]|,\s]*/g, '')
		// A generic type argument: `new Set<string>()`.
		.replace(/<[A-Za-z_$][\w$<>[\]|,\s]*?>\s*\(/g, '(')
		// A local with an OBJECT type: `const t: { path: string }[] = []`.
		.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*\{[^{}]*\}\s*(\[\])?\s*=/g, '$1 $2 =')
		// A local annotation: `const s: string =` / `let n: number =`.
		.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;]+=/g, '$1 $2 =')
		// A trailing return annotation: `): string {`.
		.replace(/\)\s*:\s*[A-Za-z_$][\w$<>\[\]|,\s]*\s*\{/g, ') {');
}

// ══════════════════════════════════════════════════════════════════════
// Loading the live functions
// ══════════════════════════════════════════════════════════════════════

/**
 * Load a function from SEVERAL modules, resolving its dependencies.
 *
 * `extractFallbackEdits` (index.ts) calls `cleanCodeBlock`
 * (generation/pipelineHelpers.ts) and `inferFilePath`
 * (tools/toolEngine.ts). Each module is scanned for the function and its
 * in-module dependencies, and the bodies are concatenated so the
 * cross-module references resolve.
 */
function loadFunctions(
	modules: Record<string, string>,
	entryName: string,
): (...args: any[]) => any {
	const bodies: string[] = [];
	const seen = new Set<string>();

	const owners = new Map<string, string>();
	for (const [modulePath, moduleSrc] of Object.entries(modules)) {
		for (const m of moduleSrc.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
			if (!owners.has(m[1]!)) owners.set(m[1]!, modulePath);
		}
	}

	const extractByName = (moduleSrc: string, name: string): string | null => {
		const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(moduleSrc);
		if (!m) return null;
		const openBrace = moduleSrc.indexOf('{', m.index + m[0].length - 1);
		const end = findFunctionEnd(moduleSrc, openBrace);
		if (end < 0) return null;
		return moduleSrc.slice(m.index, end);
	};

	const KEYWORDS = new Set([
		'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new',
		'function', 'await', 'async', 'require', 'console', 'do', 'else',
		'try', 'finally', 'export', 'import', 'throw', 'delete', 'void',
		'instanceof', 'this', 'super', 'of', 'in', 'case', 'break', 'continue',
	]);

	const needed = new Set<string>([entryName]);
	for (let round = 0; round < 12; round++) {
		let added = false;
		for (const name of [...needed]) {
			if (seen.has(name)) continue;
			const ownerPath = owners.get(name);
			if (!ownerPath) continue;
			const body = extractByName(modules[ownerPath]!, name);
			if (!body) continue;
			seen.add(name);
			added = true;
			bodies.push(stripTypes(body).replace('export function', 'function'));

			const defined = new Set<string>();
			for (const d of body.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) defined.add(d[1]!);
			for (const p of body.matchAll(/\(([^)]*)\)/g)) {
				for (const part of (p[1] ?? '').split(',')) {
					const n = part.trim().split(/[:?=]/)[0]?.trim();
					if (n && /^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
				}
			}
			for (const c of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
				const n = c[1]!;
				if (defined.has(n)) continue;
				if (KEYWORDS.has(n)) continue;
				if (owners.has(n)) { needed.add(n); added = true; }
			}
		}
		if (!added) break;
	}

	const combined = bodies.join('\n');
	// The extracted code references Node's `path` and `fs`, and the
	// console. They are injected as parameters so the evaluated function
	// has the same environment it would have inside the router.
	// eslint-disable-next-line no-new-func
	return new Function(
		'path', 'fs', 'crypto', 'console',
		`${combined}\nreturn ${entryName};`,
	)(path, fs, crypto, console);
}

/**
 * Load the live extraction path.
 *
 * Exported so the golden fixture test uses the SAME loader — if the two
 * disagreed, the fixture would assert against a different function than
 * the one the router actually runs.
 */
export function loadAll() {
	const modules = {
		[indexPath]: fs.readFileSync(indexPath, 'utf8'),
		[toolEnginePath]: fs.readFileSync(toolEnginePath, 'utf8'),
		[pipelineHelpersPath]: fs.readFileSync(pipelineHelpersPath, 'utf8'),
	};
	return {
		extractFallbackEdits: loadFunctions(modules, 'extractFallbackEdits') as (
			text: string, openFiles?: string[], workspaceRoot?: string, userPrompt?: string, mode?: string, onlyClosed?: boolean,
		) => Array<{ path: string; content: string }>,
	};
}

// ══════════════════════════════════════════════════════════════════════

async function main() {
	const name = process.argv[2];
	const source = process.argv[3];

	if (!name || !source) {
		console.error('usage: tsx scratch/capture-fixture.ts <name> <file|->');
		console.error('');
		console.error('  <file>  a file containing the raw model response');
		console.error('  -       read the response from stdin');
		console.error('');
		console.error('Example:');
		console.error('  tsx scratch/capture-fixture.ts dashboard-tagged response.txt');
		process.exit(2);
	}

	let response: string;
	if (source === '-') {
		const chunks: Buffer[] = [];
		for await (const c of process.stdin) chunks.push(Buffer.from(c));
		response = Buffer.concat(chunks).toString('utf8');
	} else {
		const p = path.resolve(source);
		if (!fs.existsSync(p)) {
			console.error(`FATAL: ${p} does not exist`);
			process.exit(2);
		}
		response = fs.readFileSync(p, 'utf8');
	}

	if (response.trim().length === 0) {
		console.error('FATAL: the response is empty — an empty fixture would assert nothing');
		process.exit(2);
	}

	const { extractFallbackEdits } = loadAll();

	// Extract under both modes, so the fixture pins the create/edit
	// distinction too, and under onlyClosed, which the compaction paths
	// use.
	const asCreate = extractFallbackEdits(response, undefined, undefined, undefined, 'create', false);
	const asEdit = extractFallbackEdits(response, undefined, undefined, undefined, 'edit', false);
	const onlyClosed = extractFallbackEdits(response, undefined, undefined, undefined, 'create', true);

	fs.mkdirSync(FIXTURES, { recursive: true });

	const fixture = {
		name,
		capturedAt: new Date().toISOString(),
		synthetic: false,
		note:
			'Captured from a real model response. The `expect` block is the ' +
			'extraction result at capture time; the fixture test asserts it ' +
			'does not change.',
		response,
		expect: {
			create: asCreate.map(e => ({ path: e.path, content: e.content })),
			edit: asEdit.map(e => ({ path: e.path, content: e.content })),
			onlyClosed: onlyClosed.map(e => ({ path: e.path, content: e.content })),
		},
	};

	const outPath = path.join(FIXTURES, `${name}.json`);
	fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2), 'utf8');
	fs.writeFileSync(path.join(FIXTURES, `${name}.response.txt`), response, 'utf8');

	console.log(`Captured "${name}"`);
	console.log(`  response:    ${response.length} chars`);
	console.log(`  create mode: ${asCreate.length} edit(s)`);
	for (const e of asCreate) console.log(`      ${e.path}  (${e.content.length} chars)`);
	console.log(`  edit mode:   ${asEdit.length} edit(s)`);
	console.log(`  onlyClosed:  ${onlyClosed.length} edit(s)`);
	console.log(`  written to:  ${outPath}`);
	console.log('');
	console.log('Review the result before committing it — the fixture now asserts this behaviour.');
}

// Only run the capture when this file is executed directly. When it is
// IMPORTED (by the golden fixture test), the loader is used and no
// capture happens.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main();
}
