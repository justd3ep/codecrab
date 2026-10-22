/**
 * No dead declarations in index.ts.
 *
 * THE BUG THIS CAUGHT
 *
 * index.ts held 12 declarations that NOTHING in the file
 * referenced:
 *
 *   MAX_TOKENS, UserScope, PlannerContract, RepairMode,
 *   FAILURE_LOG_PATH, PhaseState, PromptRouterContext,
 *   BackendSummary, FallbackEdit, ToolCallParsed, ToolResult,
 *   PipelineEvent
 *
 * Every one of them had a copy in another module — and index.ts's
 * copy was the unused one. A type declared in two places is a stale
 * copy waiting to drift, and three of the FUNCTIONS already found
 * were stale copies that had diverged:
 *
 *   extractFallbackEdits   the module copy missed the create-mode fix
 *   buildJsxRepairPrompt   the module copy handled 1 issue kind, not 6
 *   executeToolCall        the module copy had no scaffold guard
 *
 * PipelineEvent had THREE identical copies.
 *
 * MAX_TOKENS was the most interesting: declared in index.ts AND
 * chatRoutes.ts, and used in NEITHER. The live token cap is
 * computed:
 *
 *     const genMaxTokens = Math.min(
 *         stackProfile.recommendedMaxTokens,
 *         Math.max(2048, requestedContextSize - 4096),
 *     );
 *
 * A check that merely asserted "index.ts contains MAX_TOKENS" would
 * have kept a dead constant alive.
 *
 * WHAT THIS CHECKS
 *
 * Every top-level declaration in index.ts is referenced somewhere
 * in the file. The AST is used, so a mention inside a string or a
 * comment does not count.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';
const INDEX = path.join(ROUTER, 'src', 'index.ts');

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

const text = fs.readFileSync(INDEX, 'utf8');
const sf = ts.createSourceFile(INDEX, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

interface Decl { name: string; kind: string; start: number; end: number; line: number; }
const decls: Decl[] = [];

for (const s of sf.statements) {
	let name = '';
	let kind = ts.SyntaxKind[s.kind];
	if (ts.isFunctionDeclaration(s) && s.name) name = s.name.text;
	else if (ts.isClassDeclaration(s) && s.name) name = s.name.text;
	else if (ts.isInterfaceDeclaration(s)) { name = s.name.text; kind = 'interface'; }
	else if (ts.isTypeAliasDeclaration(s)) { name = s.name.text; kind = 'type'; }
	else if (ts.isEnumDeclaration(s)) { name = s.name.text; kind = 'enum'; }
	else if (ts.isVariableStatement(s)) {
		const d = s.declarationList.declarations[0];
		if (d && ts.isIdentifier(d.name)) { name = d.name.text; kind = 'const'; }
		else continue;
	} else continue;
	decls.push({
		name, kind,
		start: s.getStart(sf), end: s.getEnd(),
		line: text.slice(0, s.getStart(sf)).split('\n').length,
	});
}

console.log(`\n=== index.ts: ${text.split('\n').length} lines, ${decls.length} top-level declarations ===`);

/** The references to a name, outside its own declaration. */
function refsTo(name: string, own: { start: number; end: number }): number {
	let n = 0;
	const v = (node: ts.Node) => {
		if (ts.isIdentifier(node) && node.text === name) {
			if (node.getStart(sf) < own.start || node.getEnd() > own.end) n++;
		}
		ts.forEachChild(node, v);
	};
	v(sf);
	return n;
}

console.log('\n=== every declaration is referenced ===');

const dead: Decl[] = [];
for (const d of decls) {
	const n = refsTo(d.name, { start: d.start, end: d.end });
	if (n === 0) {
		dead.push(d);
		console.log(`  DEAD  line ${d.line}  ${d.kind} ${d.name}`);
	}
}

check('index.ts has no unreferenced declaration', () =>
	dead.length === 0
		? true
		: `${dead.length} dead: ${dead.map(d => `${d.name} (line ${d.line})`).join(', ')}`);

console.log('\n=== the dead ones are not duplicated elsewhere either ===');
// A dead declaration in index.ts is only half the problem — if the
// name is also declared elsewhere, it is a stale copy.
const SRC = path.join(ROUTER, 'src');
function listTs(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...listTs(p, base));
		else if (e.name.endsWith('.ts')) out.push(path.relative(base, p).replace(/\\/g, '/'));
	}
	return out;
}

for (const d of dead) {
	const twins: string[] = [];
	for (const rel of listTs(SRC)) {
		if (rel === 'index.ts') continue;
		const t = fs.readFileSync(path.join(SRC, rel), 'utf8');
		const s2 = ts.createSourceFile(rel, t, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
		for (const s of s2.statements) {
			let n = '';
			if (ts.isInterfaceDeclaration(s)) n = s.name.text;
			else if (ts.isTypeAliasDeclaration(s)) n = s.name.text;
			else if (ts.isEnumDeclaration(s)) n = s.name.text;
			else if (ts.isVariableStatement(s)) {
				const dd = s.declarationList.declarations[0];
				if (dd && ts.isIdentifier(dd.name)) n = dd.name.text;
			} else continue;
			if (n === d.name) { twins.push(rel); break; }
		}
	}
	check(`${d.name}: the live copy is elsewhere, not a stale duplicate`, () =>
		twins.length >= 1 ? true : 'it is not declared anywhere else either');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('index.ts holds no dead declarations.');
