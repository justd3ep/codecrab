/**
 * The structure map — a permanent tool for the refactor.
 *
 * WHAT IT DOES
 *
 * It reports the internal structure of a file, so the extraction can
 * be planned from FACTS rather than from a text search:
 *
 *   - the top-level declarations, with their exact extents
 *   - the nested functions inside a function
 *   - the route handlers, with their extents
 *   - for a chosen function: the closure variables it reads and
 *     writes, and the block boundaries inside it
 *
 * WHY IT EXISTS
 *
 * The chat handler is one 1,923-line function with 31 closure
 * variables written inside it. It cannot be moved whole. But it has
 * THREE big blocks, and their shapes decide whether each can be
 * extracted:
 *
 *   line  917   216 lines   writes 2, reads 2   <- the clean seam
 *   line 1286   711 lines   writes 14, reads 3
 *   line 2015   505 lines   writes 16, reads 1
 *
 * The first one is a candidate. The other two are entangled with the
 * closure state and are not.
 *
 * A text search cannot produce that. The AST can.
 *
 * USAGE
 *
 *   tsx test/map-structure.ts <file>              the declarations
 *   tsx test/map-structure.ts <file> --routes     the route handlers
 *   tsx test/map-structure.ts <file> <fn>         a function's internals
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';

export interface BlockInfo {
	line: number;
	lines: number;
	kind: string;
	label: string;
	writes: string[];
	reads: string[];
}

/** The label from the comment above a node. */
function labelOf(text: string, sf: ts.SourceFile, node: ts.Node): string {
	const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
	if (!ranges.length) return '';
	const c = text.slice(ranges[ranges.length - 1]!.pos, ranges[ranges.length - 1]!.end);
	const m = c.match(/\/\/\s*(?:[-=]{2,})?\s*(.+)/);
	return m ? m[1]!.trim().slice(0, 64) : '';
}

/** The identifiers a node mentions. */
function varsOf(node: ts.Node): Set<string> {
	const out = new Set<string>();
	const v = (n: ts.Node) => {
		if (ts.isIdentifier(n)) out.add(n.text);
		ts.forEachChild(n, v);
	};
	v(node);
	return out;
}

/** The variables a node ASSIGNS. */
function assignedIn(node: ts.Node): Set<string> {
	const out = new Set<string>();
	const v = (n: ts.Node) => {
		if (ts.isBinaryExpression(n) &&
			n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isIdentifier(n.left)) {
			out.add(n.left.text);
		}
		ts.forEachChild(n, v);
	};
	v(node);
	return out;
}

/** The top-level declarations of a file. */
export function topLevel(file: string): { name: string; kind: string; line: number; lines: number }[] {
	const text = fs.readFileSync(file, 'utf8');
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	const out: { name: string; kind: string; line: number; lines: number }[] = [];
	for (const s of sf.statements) {
		let name = '';
		let kind = ts.SyntaxKind[s.kind];
		if (ts.isFunctionDeclaration(s) && s.name) name = s.name.text;
		else if (ts.isClassDeclaration(s) && s.name) name = s.name.text;
		else if (ts.isInterfaceDeclaration(s)) name = s.name.text;
		else if (ts.isTypeAliasDeclaration(s)) name = s.name.text;
		else if (ts.isEnumDeclaration(s)) name = s.name.text;
		else if (ts.isVariableStatement(s)) {
			const d = s.declarationList.declarations[0];
			if (d && ts.isIdentifier(d.name)) name = d.name.text;
			kind = 'const';
		} else continue;
		out.push({
			name,
			kind,
			line: text.slice(0, s.getStart(sf)).split('\n').length,
			lines: text.slice(s.getStart(sf), s.getEnd()).split('\n').length,
		});
	}
	return out;
}

/** The blocks inside a function, with what each reads and writes. */
export function blocksOf(file: string, fnName: string): BlockInfo[] {
	const text = fs.readFileSync(file, 'utf8');
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

	// Find the function.
	let fn: ts.FunctionDeclaration | null = null;
	for (const s of sf.statements) {
		if (ts.isFunctionDeclaration(s) && s.name?.text === fnName) { fn = s; break; }
	}
	if (!fn) return [];

	// The body: a function declaration, or the arrow inside a
	// returned expression.
	let body: ts.Block | null = fn.body ?? null;
	if (!body || !ts.isBlock(body)) {
		const find = (n: ts.Node): ts.Block | null => {
			let found: ts.Block | null = null;
			const v = (x: ts.Node) => {
				if (found) return;
				if (ts.isArrowFunction(x) && x.body && ts.isBlock(x.body)) {
					found = x.body as ts.Block;
					return;
				}
				ts.forEachChild(x, v);
			};
			v(n);
			return found;
		};
		body = find(fn) ?? null;
	}
	if (!body) return [];

	// The closure variables: the handler's locals.
	const locals = new Set<string>();
	for (const s of body.statements) {
		if (ts.isVariableStatement(s)) {
			for (const d of s.declarationList.declarations) {
				if (ts.isIdentifier(d.name)) locals.add(d.name.text);
			}
		}
	}
	// The written set, across the whole body.
	const written = assignedIn(body);

	const out: BlockInfo[] = [];
	for (const s of body.statements) {
		const start = s.getStart(sf);
		const all = varsOf(s);
		const w = [...all].filter(v => assignedIn(s).has(v) && locals.has(v));
		const r = [...all].filter(v => written.has(v) && locals.has(v) && !w.includes(v));
		out.push({
			line: text.slice(0, start).split('\n').length,
			lines: text.slice(start, s.getEnd()).split('\n').length,
			kind: ts.SyntaxKind[s.kind],
			label: labelOf(text, sf, s),
			writes: w,
			reads: r,
		});
	}
	return out;
}

/** The route handlers in a file, with their extents. */
export function routesOf(file: string): { verb: string; path: string; line: number; lines: number }[] {
	const text = fs.readFileSync(file, 'utf8');
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
	const hits: { pos: number; verb: string; path: string }[] = [];
	const v = (n: ts.Node) => {
		if (ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			['get', 'post', 'put', 'delete', 'patch'].includes(n.expression.name.text)) {
			const a = n.arguments[0];
			if (a && ts.isStringLiteral(a) && a.text.startsWith('/')) {
				hits.push({ pos: n.getStart(sf), verb: n.expression.name.text, path: a.text });
			}
		}
		ts.forEachChild(n, v);
	};
	v(sf);
	hits.sort((x, y) => x.pos - y.pos);
	return hits.map((h, i) => {
		const end = i + 1 < hits.length ? hits[i + 1]!.pos : text.length;
		return {
			verb: h.verb,
			path: h.path,
			line: text.slice(0, h.pos).split('\n').length,
			lines: text.slice(h.pos, end).split('\n').length,
		};
	});
}

// ── the CLI ──────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('map-structure.ts')) {
	const [, , fileArg, cmd, fnArg] = process.argv;
	if (!fileArg) {
		console.log('usage: tsx map-structure.ts <file> [--routes | <fnName>]');
		process.exit(1);
	}
	const file = path.resolve(fileArg);

	if (cmd === '--routes') {
		const r = routesOf(file);
		console.log(`=== ${r.length} route handlers in ${path.basename(file)} ===`);
		for (const h of r) {
			console.log(`  ${String(h.line).padStart(6)}  ${String(h.lines).padStart(5)}  ${h.verb.toUpperCase().padEnd(6)} ${h.path}`);
		}
	} else if (fnArg) {
		const b = blocksOf(file, fnArg);
		console.log(`=== the blocks inside ${fnArg} ===`);
		for (const x of b.sort((p, q) => q.lines - p.lines).slice(0, 20)) {
			console.log(`  ${String(x.line).padStart(6)}  ${String(x.lines).padStart(5)}  w=${String(x.writes.length).padStart(2)} r=${String(x.reads.length).padStart(2)}  ${x.label}`);
			if (x.writes.length && x.writes.length <= 5) {
				console.log(`         writes: ${x.writes.join(', ')}`);
			}
		}
	} else {
		const t = topLevel(file);
		console.log(`=== ${t.length} top-level declarations in ${path.basename(file)} ===`);
		for (const d of t) {
			console.log(`  ${String(d.line).padStart(6)}  ${String(d.lines).padStart(5)}  ${d.kind.padEnd(10)} ${d.name}`);
		}
	}
}
