/**
 * Remove the unused imports from index.ts — using the AST.
 *
 * WHY THE AST
 *
 * The text-based version was wrong twice.
 *
 * The first version computed the "body" by blanking the import
 * block as it walked, and the block detection stopped at the first
 * blank line — so for a file with an import in the middle, the body
 * included the imports ABOVE it, and a name that appeared in another
 * import line counted as a use. It found 2 of the 47.
 *
 * The second version used "everything after the LAST import" as the
 * body. But index.ts has imports in the MIDDLE — the shadow mount
 * and the lifecycle import are near the bottom — so a name used
 * ABOVE the last import was counted as unused. It removed 47
 * names, 8 of which were live, and five checks failed.
 *
 * The compiler already knows which identifiers are used. This uses
 * its answer.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';
const TARGET = path.join(ROUTER, 'src', 'index.ts');

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

const raw = fs.readFileSync(TARGET, 'utf8');
const crlf = (raw.match(/\r\n/g) ?? []).length;
const text = raw.replace(/\r\n/g, '\n');

const source = ts.createSourceFile(
	TARGET, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS,
);

// The identifiers the file actually uses, EXCLUDING the import
// declarations themselves.
const used = new Set<string>();
{
	const visit = (n: ts.Node): void => {
		if (ts.isImportDeclaration(n)) {
			// Do NOT descend. The import's own names are not uses —
			// and descending would add them, which would make every
			// import look used.
			return;
		}
		if (ts.isIdentifier(n)) used.add(n.text);
		n.forEachChild(visit);
	};
	visit(source);
}

// The import declarations.
const imports: {
	node: ts.ImportDeclaration;
	names: string[];
	clause: ts.NamedImports;
}[] = [];

for (const stmt of source.statements) {
	if (!ts.isImportDeclaration(stmt)) continue;
	const clause = stmt.importClause;
	if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
	imports.push({
		node: stmt,
		names: clause.namedBindings.elements.map(e => e.name.text),
		clause: clause.namedBindings,
	});
}

console.log(`=== ${imports.length} import declaration(s) ===`);
console.log();

let removed = 0;
const edits: { start: number; end: number; text: string; what: string }[] = [];

for (const imp of imports) {
	const unused = imp.names.filter(n => !used.has(n));
	if (unused.length === 0) continue;

	const keep = imp.names.filter(n => used.has(n));
	removed += unused.length;

	if (keep.length === 0) {
		// The whole import goes.
		const start = imp.node.getStart(source);
		let end = imp.node.getEnd();
		// Take the trailing newline with it.
		while (end < text.length && (text[end] === '\r' || text[end] === '\n')) end++;
		edits.push({ start, end, text: '', what: `dropped ${imp.names.join(', ')}` });
		console.log(`  dropped: ${imp.names.join(', ')}`);
		continue;
	}

	// Rewrite the named bindings.
	const specifiers = imp.clause.elements
		.filter(e => used.has(e.name.text))
		.map(e => {
			// Preserve a renamed import.
			const local = e.propertyName?.text;
			// And preserve the `type` modifier — `import { type X }`
			// and `import type { X }` are different, and dropping the
			// modifier changes the meaning.
			const prefix = e.isTypeOnly ? 'type ' : '';
			return local && local !== e.name.text
				? `${prefix}${local} as ${e.name.text}`
				: `${prefix}${e.name.text}`;
		});

	// The module specifier's getText() ALREADY INCLUDES the quotes,
	// so it must not be quoted again.
	const moduleSpec = imp.node.moduleSpecifier.getText(source);
	// An `import type { ... }` stays a type import.
	const isTypeOnly = imp.node.importClause?.isTypeOnly === true;
	const typePrefix = isTypeOnly ? 'type ' : '';

	const oneLine = `import ${typePrefix}{ ${specifiers.join(', ')} } from ${moduleSpec};`;
	console.log(`  ${moduleSpec}: dropped ${unused.join(', ')}`);

	if (oneLine.length < 110) {
		edits.push({
			start: imp.node.getStart(source),
			end: imp.node.getEnd(),
			text: oneLine,
			what: 'rewritten',
		});
	} else {
		const block = `import ${typePrefix}{\n${specifiers.map(s => `	${s},\n`).join('')}} from ${moduleSpec};`;
		edits.push({
			start: imp.node.getStart(source),
			end: imp.node.getEnd(),
			text: block,
			what: 'rewritten',
		});
	}
}

console.log();
console.log(`=== ${removed} unused import(s) ===`);

// Apply the edits, from the end backwards.
let out = text;
for (const e of [...edits].sort((a, b) => b.start - a.start)) {
	out = out.slice(0, e.start) + e.text + out.slice(e.end);
}

fs.writeFileSync(
	TARGET,
	crlf > 0 ? out.replace(/\n/g, '\r\n') : out,
	'utf-8',
);

console.log('  the file was rewritten');
console.log('done');
