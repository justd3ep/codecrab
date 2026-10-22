/**
 * A TypeScript-aware source tool, built on the compiler API.
 *
 * WHY THE AST
 *
 * Every text-based approach to "find where this declaration ends"
 * failed on this codebase. The reasons are all real TypeScript:
 *
 *   - a PARAMETER type can hold braces:   Array<{ path: string }>
 *   - a RETURN type can hold braces:        ): { intent: 'fe' } {
 *   - a REGEX LITERAL can hold quotes and braces: /['"]?[\w]+\{/
 *   - a TEMPLATE LITERAL can hold a // comment
 *   - an OVERLOAD SIGNATURE's type can hold braces
 *
 * The compiler already knows where every declaration starts and
 * ends. Asking it is exact.
 *
 * WHAT IT DOES
 *
 *   - find a top-level declaration by name, and report its exact
 *     span (start, end) plus the span of a doc comment above it
 *   - list the top-level declarations of a file
 *   - report a file's imports
 *
 * It is used by the extraction scripts and by the permanent checks.
 *
 * Run: tsx <this file> <command> [args]
 *   list   <file>                 the top-level declarations
 *   span   <file> <name>          the exact span of one declaration
 *   imports <file>                the imports
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface Span {
	name: string;
	start: number;
	end: number;
	kind: string;
	/** The doc comment above it, if any. */
	docStart: number;
	docEnd: number;
}

export interface FileInfo {
	text: string;
	sourceFile: ts.SourceFile;
	spans: Map<string, Span>;
	imports: { module: string; names: string[]; start: number; end: number }[];
}

/** Parse a file and index its top-level declarations. */
export function parse(file: string): FileInfo {
	const text = fs.readFileSync(file, 'utf8');
	const sourceFile = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.ESNext,
		true,
		file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);

	const spans = new Map<string, Span>();
	const imports: FileInfo['imports'] = [];

	for (const stmt of sourceFile.statements) {
		// The imports.
		if (ts.isImportDeclaration(stmt)) {
			const spec = stmt.moduleSpecifier.getText(sourceFile);
			const names: string[] = [];
			const nb = stmt.importClause?.namedBindings;
			if (nb && ts.isNamedImports(nb)) {
				for (const el of nb.elements) {
					names.push((el.propertyName ?? el.name).getText(sourceFile));
				}
			}
			imports.push({
				module: spec,
				names,
				start: stmt.getStart(sourceFile),
				end: stmt.getEnd(),
			});
			continue;
		}

		// The declarations.
		const name = declName(stmt);
		if (!name) continue;
		if (spans.has(name)) {
			// An overload: the LAST one has the body, so keep the
			// longest span.
			const prev = spans.get(name)!;
			if (stmt.getEnd() - stmt.getStart() > prev.end - prev.start) {
				spans.set(name, {
					name,
					start: stmt.getStart(sourceFile),
					end: stmt.getEnd(),
					kind: declKind(stmt),
					docStart: docStart(stmt, sourceFile),
					docEnd: stmt.getStart(sourceFile),
				});
			}
			continue;
		}
		spans.set(name, {
			name,
			start: stmt.getStart(sourceFile),
			end: stmt.getEnd(),
			kind: declKind(stmt),
			docStart: docStart(stmt, sourceFile),
			docEnd: stmt.getStart(sourceFile),
		});
	}

	return { text, sourceFile, spans, imports };
}

function declName(stmt: ts.Statement): string | null {
	if (ts.isFunctionDeclaration(stmt) && stmt.name) return stmt.name.text;
	if (ts.isClassDeclaration(stmt) && stmt.name) return stmt.name.text;
	if (ts.isInterfaceDeclaration(stmt)) return stmt.name.text;
	if (ts.isTypeAliasDeclaration(stmt)) return stmt.name.text;
	if (ts.isEnumDeclaration(stmt)) return stmt.name.text;
	if (ts.isVariableStatement(stmt)) {
		const decl = stmt.declarationList.declarations[0];
		if (decl && ts.isIdentifier(decl.name)) return decl.name.text;
	}
	return null;
}

function declKind(stmt: ts.Statement): string {
	if (ts.isFunctionDeclaration(stmt)) return 'function';
	if (ts.isClassDeclaration(stmt)) return 'class';
	if (ts.isInterfaceDeclaration(stmt)) return 'interface';
	if (ts.isTypeAliasDeclaration(stmt)) return 'type';
	if (ts.isEnumDeclaration(stmt)) return 'enum';
	if (ts.isVariableStatement(stmt)) return 'const';
	return 'other';
}

/** The start of the doc comment above a statement, if there is one. */
function docStart(stmt: ts.Statement, sf: ts.SourceFile): number {
	const ranges = ts.getLeadingCommentRanges(sf.text, stmt.getFullStart());
	if (!ranges || !ranges.length) return stmt.getStart(sf);
	const last = ranges[ranges.length - 1]!;
	const comment = sf.text.slice(last.pos, last.end);
	// Only a block comment counts as a doc comment.
	if (!comment.startsWith('/**')) return stmt.getStart(sf);
	return last.pos;
}

/** The exact text of a declaration. */
export function textOf(info: FileInfo, name: string): string | null {
	const s = info.spans.get(name);
	if (!s) return null;
	return info.text.slice(s.start, s.end);
}

/** The names a file imports from a module. */
export function importsFrom(info: FileInfo, module: string): string[] {
	for (const i of info.imports) {
		if (i.module === module) return i.names;
	}
	return [];
}

// ── the CLI ──────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('ts-source-tool.ts')) {
	const [, , cmd, fileArg, nameArg] = process.argv;
	if (!cmd || !fileArg) {
		console.log('usage: tsx ts-source-tool.ts <list|span|imports> <file> [name]');
		process.exit(1);
	}
	const file = path.resolve(fileArg);
	const info = parse(file);

	if (cmd === 'list') {
		const rows = [...info.spans.values()].sort((a, b) => a.start - b.start);
		for (const r of rows) {
			const line = info.text.slice(0, r.start).split('\n').length;
			console.log(
				`  ${String(line).padStart(6)}  ${String(r.end - r.start).padStart(6)}  ${r.kind.padEnd(10)} ${r.name}`,
			);
		}
		console.log(`  ${rows.length} top-level declarations`);
	} else if (cmd === 'span') {
		const s = info.spans.get(nameArg!);
		if (!s) {
			console.log(`  not found: ${nameArg}`);
			process.exit(1);
		}
		const line = info.text.slice(0, s.start).split('\n').length;
		console.log(`  ${nameArg}: lines ${line}..${info.text.slice(0, s.end).split('\n').length}`);
		console.log(`  span: ${s.start}..${s.end}  (${s.end - s.start} chars)`);
		console.log(`  kind: ${s.kind}`);
		console.log('  ---');
		console.log(info.text.slice(s.start, s.end));
	} else if (cmd === 'imports') {
		for (const i of info.imports) {
			console.log(`  ${i.module}  ->  ${i.names.join(', ') || '(default/namespace)'}`);
		}
	}
}
