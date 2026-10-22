/**
 * Every Phase 0/1 fix must be in BOTH routes.
 *
 * WHY
 *
 * There are two chat routes:
 *
 *   index.ts (LIVE)             the monolith the editor talks to
 *   router/chatRoutes.ts        the newer architecture, UNMOUNTED
 *
 * chatRoutes.ts predates Phase 0/1, so it was missing six fixes
 * that made the live route trustworthy. Until they are ported,
 * mounting it raw would produce WORSE results than the live route —
 * and any comparison would be meaningless, because the difference
 * would be the fixes rather than the architecture.
 *
 * WHERE A FIX LIVES MATTERS
 *
 * Some fixes are in the route's own code:
 *
 *   P0.2  the truncation diagnosis       the route calls diagnoseResponse
 *   P0.3  the scaffold/generated split   the route keeps a scaffolded set
 *   P0.4  the empty-set check            the route looks for the no_output kind
 *   P1.8  the stuck-repair termination   the route throws "Repair stalled"
 *
 * And some live in a MODULE that the route calls:
 *
 *   P1.4  the advisor JSON recovery      routing/advisorJson.ts
 *   P1.7  the scaffold guard             tools/scaffoldGuard.ts
 *
 * For those, the check is that the route reaches the module — not
 * that the route contains the module's code. The scaffold guard is
 * the clearest case: it is enforced inside tools/toolEngine.ts's
 * executeToolCall, so BOTH routes get it by calling that function.
 *
 * This check proves each fix is reachable from BOTH routes.
 *
 * Run: tsx <this file>
 */
import fs from 'fs';
import path from 'path';

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

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const live = read('index.ts');
const chat = read('router/chatRoutes.ts');

/** The code, not the comments. */
function code(text: string): string {
	return text
		.split('\n')
		.filter(l => {
			const t = l.trim();
			return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
		})
		.join('\n');
}

const liveCode = code(live);
const chatCode = code(chat);

/** The fixes that live in the route's own code. */
const IN_ROUTE: { phase: string; name: string; needle: string }[] = [
	{ phase: 'P0.2', name: 'the truncation diagnosis', needle: 'diagnoseResponse(' },
	{ phase: 'P0.2', name: 'the truncation continuation prompt', needle: 'buildTruncationContinuationPrompt(' },
	{ phase: 'P0.2', name: 'the prose output prompt', needle: 'buildProseOutputPrompt(' },
	{ phase: 'P0.3', name: 'the scaffold/generated split', needle: 'scaffoldedFiles' },
	{ phase: 'P0.4', name: 'the empty-set check', needle: "kind === 'no_output'" },
	{ phase: 'P0.4', name: 'the no-output prompt', needle: 'buildNoOutputPrompt(' },
	{ phase: 'P1.8', name: 'the stuck-repair termination', needle: 'Repair stalled' },
];

/**
 * The fixes that live in a MODULE the route must reach.
 *
 *   the module   the route must
 */
const IN_MODULE: { phase: string; name: string; module: string; routeNeeds: string }[] = [
	{
		phase: 'P1.4',
		name: 'the advisor JSON recovery',
		module: 'routing/advisorJson.ts',
		routeNeeds: 'runAdvisor',
	},
	{
		phase: 'P1.7',
		name: 'the scaffold guard',
		module: 'tools/scaffoldGuard.ts',
		routeNeeds: 'executeToolCall',
	},
];

console.log('\n=== the fixes that live in the route\'s own code ===');
console.log();
for (const f of IN_ROUTE) {
	const inLive = liveCode.includes(f.needle);
	const inChat = chatCode.includes(f.needle);
	const mark = inLive && inChat ? 'OK  ' : inLive ? 'LIVE' : inChat ? 'CHAT' : 'NONE';
	console.log(`  ${mark}  ${f.phase}  ${f.name}`);
}
console.log();
for (const f of IN_ROUTE) {
	check(`${f.phase} ${f.name}: both routes have it`, () => {
		const inLive = liveCode.includes(f.needle);
		const inChat = chatCode.includes(f.needle);
		return inLive && inChat
			? true
			: `the live route: ${inLive ? 'yes' : 'NO'}, chatRoutes.ts: ${inChat ? 'yes' : 'NO'}`;
	});
}

console.log('\n=== the fixes that live in a module the route must reach ===');
console.log();
for (const f of IN_MODULE) {
	const inLive = liveCode.includes(f.routeNeeds);
	const inChat = chatCode.includes(f.routeNeeds);
	const mark = inLive && inChat ? 'OK  ' : inLive ? 'LIVE' : inChat ? 'CHAT' : 'NONE';
	console.log(`  ${mark}  ${f.phase}  ${f.name}  (via ${f.routeNeeds})`);
}
console.log();
for (const f of IN_MODULE) {
	check(`${f.phase} ${f.name}: both routes reach ${f.routeNeeds}`, () => {
		const inLive = liveCode.includes(f.routeNeeds);
		const inChat = chatCode.includes(f.routeNeeds);
		return inLive && inChat
			? true
			: `the live route: ${inLive ? 'yes' : 'NO'}, chatRoutes.ts: ${inChat ? 'yes' : 'NO'}`;
	});

	// And the module itself must hold the fix.
	check(`${f.phase} ${f.name}: the module holds the fix`, () => {
		const mod = read(f.module);
		const modCode = code(mod);
		// The advisor parser must be USED, and the guard must be
		// ENFORCED.
		if (f.phase === 'P1.4') {
			return modCode.includes('parseAdvisorJson(')
				? true
				: 'routing/advisorJson.ts does not export the tolerant parser';
		}
		return modCode.includes('export function wouldClobberScaffold')
			? true
			: 'tools/scaffoldGuard.ts does not export the guard';
	});
}

// The guard must be ENFORCED, not merely exported.
console.log('\n=== the scaffold guard is enforced, not merely exported ===');
check('tools/toolEngine.ts calls the guard', () => {
	const te = code(read('tools/toolEngine.ts'));
	return te.includes('wouldClobberScaffold(')
		? true
		: 'executeToolCall does not call the guard';
});

console.log('\n=== neither route imports from the other ===');

check('chatRoutes.ts does not import from ../index.js', () =>
	!/from\s+'\.\.\/index\.js'/.test(chat)
		? true
		: 'it does — that is a circular import waiting to happen');

check('index.ts does not import chatRoutes.ts', () =>
	!/from\s+'\.\/router\/chatRoutes\.js'/.test(live)
		? true
		: 'it does — that is a circular import');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('Both routes carry the same Phase 0/1 fixes.');
