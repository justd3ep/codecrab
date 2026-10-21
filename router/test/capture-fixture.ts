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
/**
 * Find the index AFTER the `)` that closes the parameter list starting
 * at `openParen`.
 *
 * Needed because a TypeScript signature can contain braces INSIDE the
 * parameter list:
 *
 *     function f(
 *         files: Array<{ path: string; content: string }>,
 *     ): Result[] {
 *
 * The first `{` after the signature belongs to the PARAMETER's type, not
 * to the body. So the parameter list must be closed first.
 *
 * Paren matching is lexical: strings, template literals, regular
 * expressions and comments are skipped.
 */
function findParamsEnd(src: string, openParen: number): number {
	let depth = 0;
	let i = openParen;
	let prev = '';
	const regexMayStart = new Set('(=,:[!&|?{;+-*%<>~^');
	while (i < src.length) {
		const c = src[i]!;
		const nxt = src[i + 1] ?? '';
		if (c === '/' && nxt === '/') {
			const nl = src.indexOf('\n', i);
			if (nl < 0) return -1;
			i = nl + 1;
			continue;
		}
		if (c === '/' && nxt === '*') {
			const e = src.indexOf('*/', i + 2);
			if (e < 0) return -1;
			i = e + 2;
			prev = ' ';
			continue;
		}
		if (c === "'" || c === '"') {
			const q = c;
			i++;
			while (i < src.length) {
				if (src[i] === '\\') { i += 2; continue; }
				if (src[i] === q) { i++; break; }
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
		if (c === '/' && (prev === '' || regexMayStart.has(prev))) {
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
				while (j < src.length && /[a-z]/i.test(src[j]!)) j++;
				i = j;
				prev = 'x';
				continue;
			}
		}
		if (c === '(') depth++;
		else if (c === ')') {
			depth--;
			if (depth === 0) return i + 1;
		}
		if (!/\s/.test(c)) prev = c;
		i++;
	}
	return -1;
}

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
/**
 * Remove comments from a function body, preserving the line structure.
 *
 * THE BUG THIS PREVENTS
 *
 * The type-stripper ran over COMMENTS. A comment can look like
 * TypeScript:
 *
 *     // If >60% of lines look like code, treat entire text as code
 *
 * The `as Type` cast rule matched the words " as code" and removed
 * them, which merged the comment with the next line and destroyed the
 * declaration that followed:
 *
 *     // ...treat entire text= codeLines.length / totalNonEmpty;
 *
 * The function then referenced an undefined variable at runtime.
 *
 * A comment can never change a function's behaviour, so removing it
 * first is safe — and it removes the whole class of "prose that looks
 * like code" bugs.
 *
 * Newlines are preserved, and a block comment's content is replaced
 * with spaces so it cannot join two tokens together.
 */
function stripComments(src: string): string {
	// A LEXICAL stripper. A regex-based one cannot tell a comment from
	// a comment-looking substring inside a string or a template
	// literal, and the router's source has both:
	//
	//     lines.push(`     <file path="${mf}">\n
	//          // Complete working React implementation\n
	//          </file>`);
	//
	// The `// Complete working...` is INSIDE a template literal. A
	// regex stripper deleted it, unbalanced the backtick, and the
	// evaluated function failed with "Unexpected end of input".
	//
	// So: one pass, tracking whether we are in code, in a string, in a
	// template, or in a comment.
	let out = '';
	let i = 0;
	const n = src.length;

	while (i < n) {
		const c = src[i]!;
		const next = i + 1 < n ? src[i + 1]! : '';

		// ── a line comment ──
		if (c === '/' && next === '/') {
			while (i < n && src[i] !== '\n') i++;
			continue;
		}

		// ── a block comment ──
		if (c === '/' && next === '*') {
			const end = src.indexOf('*/', i + 2);
			const stop = end < 0 ? n : end + 2;
			// Replace with spaces, keeping the newlines so the line
			// structure (and any statement separation) survives.
			for (let k = i; k < stop; k++) {
				out += src[k] === '\n' ? '\n' : ' ';
			}
			i = stop;
			continue;
		}

		// ── a string literal ──
		if (c === "'" || c === '"') {
			const q = c;
			out += c;
			i++;
			while (i < n) {
				out += src[i];
				if (src[i] === '\\') {
					if (i + 1 < n) out += src[i + 1];
					i += 2;
					continue;
				}
				if (src[i] === q) {
					i++;
					break;
				}
				i++;
			}
			continue;
		}

		// ── a template literal ──
		if (c === '`') {
			out += c;
			i++;
			while (i < n) {
				out += src[i];
				if (src[i] === '\\') {
					if (i + 1 < n) out += src[i + 1];
					i += 2;
					continue;
				}
				if (src[i] === '`') {
					i++;
					break;
				}
				if (src[i] === '$' && src[i + 1] === '{') {
					// The `$` has ALREADY been written by the
					// `out += src[i]` above, so this branch adds
					// only the `{` and the interpolation body.
					out += '{';
					i += 2;
					let depth = 1;
					while (i < n && depth > 0) {
						if (src[i] === '{') depth++;
						else if (src[i] === '}') {
							depth--;
							if (depth === 0) {
								out += src[i];
								i++;
								break;
							}
						}
						out += src[i];
						i++;
					}
					continue;
				}
				i++;
			}
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

function stripTypes(src: string): string {
	// Comments go FIRST. A comment can look like TypeScript (the words
	// " as code" in a prose comment match the cast rule), and stripping
	// types out of a comment can destroy the declaration that follows
	// it. See stripComments() for the full story.
	src = stripComments(src);

	// String and template literals are PROTECTED next. Their contents
	// are DATA, not code:
	//
	//   lines.push('... the files as valid <file path="...">...</file> ...');
	//
	// The `cast as` rule would match the "as valid" and delete it,
	// leaving `files="...">`. And a `${` interpolation can be eaten
	// whole by a rule that crosses a line boundary.
	//
	// So each literal is replaced with a placeholder, the type rules
	// run on the CODE only, and the literals are put back.
	const literals: string[] = [];
	// The characters after which a `/` starts a REGEX literal rather
	// than a division.
	const regexMayStart = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
	const protect = (text: string): string => {
		let out = '';
		let i = 0;
		const n = text.length;
		// The last significant character, used to tell a regex literal
		// from a division.
		let prevSignificant = '';
		while (i < n) {
			const c = text[i]!;
			const next = i + 1 < n ? text[i + 1]! : '';

			// A line comment or a block comment — stripComments()
			// already removed them, but be safe.
			if (c === '/' && next === '/') {
				while (i < n && text[i] !== '\n') i++;
				continue;
			}
			if (c === '/' && next === '*') {
				const e = text.indexOf('*/', i + 2);
				i = e < 0 ? n : e + 2;
				continue;
			}

			// A REGEX literal. The router's source has one with a
			// QUOTE in it:
			//
			//   /...['"]?([\w./\\-]+\.\w+)['"]?/i
			//
			// Without this, the `'` starts a fake string literal and
			// everything after it is protected from the type rules —
			// including the `!` in `fileMatch[1]!`, which then failed
			// to evaluate with "Unexpected token '!'".
			if (c === '/' && next !== '/' && next !== '*' && regexMayStart.has(prevSignificant)) {
				let j = i + 1;
				let inClass = false;
				let closed = false;
				while (j < n) {
					const r = text[j]!;
					if (r === '\\') { j += 2; continue; }
					if (r === '\n') break;
					if (r === '[') inClass = true;
					else if (r === ']') inClass = false;
					else if (r === '/' && !inClass) { j++; closed = true; break; }
					j++;
				}
				if (closed) {
					// Copy the regex and its flags verbatim.
					while (j < n && /[a-z]/i.test(text[j]!)) j++;
					literals.push(text.slice(i, j));
					out += `\u0000LIT${literals.length - 1}\u0000`;
					i = j;
					continue;
				}
			}

			// A string literal.
			if (c === "'" || c === '"') {
				const q = c;
				let j = i + 1;
				while (j < n) {
					if (text[j] === '\\') { j += 2; continue; }
					if (text[j] === q) { j++; break; }
					j++;
				}
				literals.push(text.slice(i, j));
				out += `\u0000LIT${literals.length - 1}\u0000`;
				prevSignificant = 'x';
				i = j;
				continue;
			}

			// A template literal.
			if (c === '`') {
				let j = i + 1;
				let depth = 0;
				while (j < n) {
					if (text[j] === '\\') { j += 2; continue; }
					if (text[j] === '$' && text[j + 1] === '{') {
						depth = 1;
						j += 2;
						while (j < n && depth > 0) {
							if (text[j] === '{') depth++;
							else if (text[j] === '}') depth--;
							j++;
						}
						continue;
					}
					if (text[j] === '`') { j++; break; }
					j++;
				}
				literals.push(text.slice(i, j));
				out += `\u0000LIT${literals.length - 1}\u0000`;
				i = j;
				continue;
			}

			out += c;
			if (!/\s/.test(c)) prevSignificant = c;
			i++;
		}
		return out;
	};

	const restore = (text: string): string =>
		text.replace(/\u0000LIT(\d+)\u0000/g, (_m, n) => literals[Number(n)] ?? '');

	const code = protect(src);

	const stripped = code
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
		.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*\{[^{}\r\n]*\}\s*(\[\])?\s*=/g, '$1 $2 =')
		// A local annotation: `const s: string =` / `let n: number =`.
		.replace(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\r\n]+=/g, '$1 $2 =')
		// A trailing return annotation: `): string {`.
		.replace(/\)\s*:\s*[A-Za-z_$][\w$<>\[\]|,\s]*\s*\{/g, ') {');

	// The literals go back in.
	return restore(stripped);
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
		// The body's opening brace is the first `{` AFTER the parameter
		// list. A signature can contain braces inside the parameter
		// list — `files: Array<{ path: string }>` — and taking that as
		// the body truncates the function.
		const openParen = moduleSrc.indexOf('(', m.index + m[0].length - 1);
		const paramsEnd = findParamsEnd(moduleSrc, openParen);
		if (paramsEnd < 0) return null;
		const openBrace = moduleSrc.indexOf('{', paramsEnd);
		if (openBrace < 0) return null;
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

/**
 * Load ONE function from ONE source file, with its dependencies.
 *
 * Exported so the other verification scripts use the SAME type-stripper
 * as the golden fixtures. There is only one stripper to maintain, and
 * no chance of two scripts disagreeing about how a piece of TypeScript
 * is stripped.
 *
 * @param file   a path relative to the router root, e.g.
 *               'src/generation/pipelineHelpers.ts'
 * @param name   the function to load
 */
export function loadFunction(file: string, name: string): (...args: any[]) => any {
	const abs = path.join(ROUTER, file);
	if (!fs.existsSync(abs)) {
		throw new Error(`${file} does not exist`);
	}
	const modules = { [abs]: fs.readFileSync(abs, 'utf8') };
	return loadFunctions(modules, name);
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
