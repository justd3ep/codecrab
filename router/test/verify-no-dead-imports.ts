/**
 * No dead imports in index.ts.
 *
 * THE BUG
 *
 * TypeScript does not error on an unused import. So 46 of them
 * accumulated silently through the refactor, one extraction at a
 * time.
 *
 * They are not harmless:
 *   - they hide the fact that the code MOVED, so a reader cannot
 *     tell which module owns what
 *   - they are a live duplicate: the module owns the implementation,
 *     and index.ts still claims to import it
 *   - a name that is imported but not used is a name that a future
 *     edit might "use" by accident
 *
 * THE TOOL
 *
 * The TypeScript compiler, not text. The compiler already knows
 * which identifiers are used.
 *
 * A text-based count got it wrong twice:
 *   - once it found 2 of the 46, because its "body" boundary
 *     stopped at the first blank line
 *   - once it removed 8 LIVE names, because it treated a name used
 *     above the last import as unused
 *
 * WHAT THIS PROVES
 *
 * Every import in index.ts names something the file uses. And the
 * check is proven to catch a dead import — the mutation at the end
 * adds one and confirms the check fails.
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

/** The unused import names in a source file. */
function unusedImports(text: string): string[] {
	const source = ts.createSourceFile(
		'index.ts', text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS,
	);

	// The identifiers the file uses, EXCLUDING the import
	// declarations themselves. Descending into an import would add
	// its own names, and every import would look used.
	const used = new Set<string>();
	const visit = (n: ts.Node): void => {
		if (ts.isImportDeclaration(n)) return;
		if (ts.isIdentifier(n)) used.add(n.text);
		n.forEachChild(visit);
	};
	visit(source);

	const dead: string[] = [];
	for (const stmt of source.statements) {
		if (!ts.isImportDeclaration(stmt)) continue;
		const clause = stmt.importClause;
		if (!clause || !clause.namedBindings) continue;
		const bindings = clause.namedBindings;
		if (ts.isNamedImports(bindings)) {
			for (const e of bindings.elements) {
				if (!used.has(e.name.text)) dead.push(e.name.text);
			}
		} else if (ts.isNamespaceImport(bindings)) {
			if (!used.has(bindings.name.text)) dead.push(bindings.name.text);
		}
	}
	return dead;
}

const raw = fs.readFileSync(TARGET, 'utf8');
const text = raw.replace(/\r\n/g, '\n');

console.log('\n=== index.ts has no dead imports ===');

const dead = unusedImports(text);
check('every import names something the file uses', () =>
	dead.length === 0
		? true
		: `${dead.length} unused: ${dead.join(', ')}`);

console.log('\n=== the check actually catches one ===');

// A copy of the file with a deliberately dead import.
//
// The name must NOT be used anywhere in index.ts, or it would be a
// live import and the check would be right to pass. The first
// version used readFileSync — which index.ts DOES use, so the
// mutation was not actually dead.
const deadImport = "import { createWriteStream } from 'fs';\n";
const mutated = deadImport + text;

const mutatedDead = unusedImports(mutated);
check('a dead import is detected', () =>
	mutatedDead.includes('createWriteStream')
		? true
		: `it was not detected — the check found: ${mutatedDead.join(', ') || 'nothing'}`);

check('the dead import was not there before', () =>
	!dead.includes('createWriteStream')
		? true
		: 'index.ts already imports it — the mutation is not dead');

console.log('\n=== the mutation does not break the real file ===');
check('the real file is untouched', () => {
	const after = fs.readFileSync(TARGET, 'utf8');
	return after === raw
		? true
		: 'the file changed — the check must not write';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('No dead imports.');
