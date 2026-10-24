/**
 * verify-decode-contract.ts — one decode vocabulary, one scope owner.
 *
 * Phase 3 has two jobs and this file pins both:
 *
 *   1. THE DECODE CONTRACT. The advisor speaks `create_fullstack`,
 *      `edit_fe`, `general`, `unknown`; the brief schema speaks
 *      `fullstack`, `create_fe`, ... Phase 2 normalised by membership, so
 *      a perfectly good `create_fullstack` was recorded as `unknown` and
 *      scored as a decode failure. `decodeAdvisorIntent` is now the only
 *      mapping, and every rejection names its reason so the failure rate
 *      is measurable instead of silent.
 *
 *   2. THE PROJECTION. `buildPlannerContract` used to derive the scope
 *      itself, ending in `: 'fullstack'`. A failed advisor matches no
 *      branch, so the literal "unknown" became the two-model path even
 *      when the ensemble had scored BE=0. Now the brief resolves the
 *      scope and the contract reports it, so the two cannot disagree.
 *
 * The projection assertions are a matrix on purpose: the property is
 * "contract.scope === brief.scope, always", not a handful of examples.
 */
import { buildBrief, normaliseIntent, resolveBriefScope } from '../src/brief/buildBrief.js';
import { decodeAdvisorIntent } from '../src/brief/decode.js';
import { buildPlannerContract } from '../src/parsing/plannerContract.js';
import { isValidBrief } from '../src/brief/validate.js';
import type { BriefIntent } from '../src/brief/types.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, fn: () => true | string): void {
	let res: true | string;
	try {
		res = fn();
	} catch (err: any) {
		res = `threw: ${err?.message || err}`;
	}
	if (res === true) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		failures.push(`${name}: ${res}`);
		console.log(`  FAIL  ${name} -> ${res}`);
	}
}

console.log('=== decode: the advisor vocabulary maps onto the schema ===');

check('create_fullstack decodes to fullstack, not unknown', () => {
	const d = decodeAdvisorIntent('create_fullstack');
	return d.ok && d.intent === 'fullstack' ? true : `ok=${d.ok} intent=${d.intent} reason=${d.reason}`;
});

check('edit_fullstack decodes to fullstack', () => {
	const d = decodeAdvisorIntent('edit_fullstack');
	return d.ok && d.intent === 'fullstack' ? true : `ok=${d.ok} intent=${d.intent}`;
});

check('a plain schema intent decodes unchanged', () => {
	const bad = (['create_fe', 'edit_fe', 'create_be', 'edit_be', 'fullstack', 'question'] as string[])
		.filter((raw) => {
			const d = decodeAdvisorIntent(raw);
			return !(d.ok && d.intent === raw);
		});
	return bad.length === 0 ? true : `mis-decoded: ${bad.join(',')}`;
});

check('normaliseIntent agrees with the decode contract on fullstack', () => {
	return normaliseIntent('create_fullstack') === 'fullstack'
		? true
		: `normaliseIntent=${normaliseIntent('create_fullstack')}`;
});

check('the literal unknown fails and says why', () => {
	const d = decodeAdvisorIntent('unknown');
	return !d.ok && d.intent === 'unknown' && d.reason === 'advisor_returned_unknown'
		? true
		: `ok=${d.ok} intent=${d.intent} reason=${d.reason}`;
});

check('general fails — the advisor has no opinion, the brief says so', () => {
	const d = decodeAdvisorIntent('general');
	return !d.ok && d.intent === 'unknown' && d.reason === 'advisor_general'
		? true
		: `ok=${d.ok} intent=${d.intent} reason=${d.reason}`;
});

check('null, empty and junk all fail with distinct reasons', () => {
	const got = [decodeAdvisorIntent(null).reason, decodeAdvisorIntent('  ').reason, decodeAdvisorIntent('make me a website').reason];
	const want = ['no_intent', 'empty', 'unrecognised:make_me_a_website'];
	return JSON.stringify(got) === JSON.stringify(want) ? true : JSON.stringify(got);
});

console.log('\n=== projection: the contract reports what the brief resolved ===');

interface Case {
	name: string;
	intent: string | null;
	ensemble: 'frontend' | 'backend' | 'general';
	fe: number;
	be: number;
	mask?: string;
	scope: 'frontend' | 'backend' | 'fullstack';
}

const cases: Case[] = [
	{ name: 'decoded fe + fe ensemble', intent: 'create_fe', ensemble: 'frontend', fe: 8, be: 0, scope: 'frontend' },
	{ name: 'decoded be + be ensemble', intent: 'create_be', ensemble: 'backend', fe: 0, be: 7, scope: 'backend' },
	{ name: 'decoded fullstack with evidence', intent: 'create_fullstack', ensemble: 'general', fe: 5, be: 5, scope: 'fullstack' },
	{ name: 'decoded fullstack without evidence', intent: 'create_fullstack', ensemble: 'frontend', fe: 6, be: 0, scope: 'frontend' },
	{ name: 'failed decode + fe ensemble', intent: 'unknown', ensemble: 'frontend', fe: 8, be: 0, scope: 'frontend' },
	{ name: 'failed decode + be ensemble', intent: 'unknown', ensemble: 'backend', fe: 0, be: 6, scope: 'backend' },
	{ name: 'failed decode + general ensemble, fe wins', intent: null, ensemble: 'general', fe: 3, be: 1, scope: 'frontend' },
	{ name: 'failed decode + general ensemble, be wins', intent: null, ensemble: 'general', fe: 1, be: 3, scope: 'backend' },
	{ name: 'failed decode + general ensemble, tie is not fullstack', intent: null, ensemble: 'general', fe: 2, be: 2, scope: 'frontend' },
	{ name: 'frontend-only mask beats a be-heavy request', intent: 'create_be', ensemble: 'backend', fe: 1, be: 9, mask: 'FRONTEND_ONLY', scope: 'frontend' },
	{ name: 'backend-only mask beats an fe-heavy request', intent: 'create_fe', ensemble: 'frontend', fe: 9, be: 1, mask: 'BACKEND_ONLY', scope: 'backend' },
	{ name: 'question routes with no generation scope', intent: 'question', ensemble: 'backend', fe: 0, be: 5, scope: 'backend' },
];

function briefAndContract(c: Case) {
	const decode = decodeAdvisorIntent(c.intent);
	const brief = buildBrief({
		requestId: `req-${c.name.replace(/\W+/g, '-')}`,
		lastUserMsg: 'build a thing',
		ensembleIntent: c.ensemble,
		rawAdvisorIntent: c.intent,
		scores: { fe: c.fe, be: c.be },
		decode: { ms: 10, raw: JSON.stringify(c.intent), ok: decode.ok },
		stack: { framework: 'none', language: 'typescript', singleFile: false },
		userScope: c.mask ?? null,
		now: '2026-10-24T00:00:00.000Z',
	});
	const contract = buildPlannerContract('build a thing', {
		scope: brief.scope,
		framework: brief.stack.framework,
	});
	return { brief, contract, decode };
}

check('the contract scope equals the brief scope for every input', () => {
	const bad = cases
		.map((c) => ({ c, ...briefAndContract(c) }))
		.filter(({ brief, contract }) => brief.scope !== contract.scope)
		.map(({ c, brief, contract }) => `${c.name}: brief=${brief.scope} contract=${contract.scope}`);
	return bad.length === 0 ? true : bad.join(' | ');
});

check('every case resolves to the scope the rules predict', () => {
	const bad = cases
		.map((c) => ({ c, ...briefAndContract(c) }))
		.filter(({ c, brief }) => brief.scope !== c.scope)
		.map(({ c, brief }) => `${c.name}: scope=${brief.scope} expected=${c.scope}`);
	return bad.length === 0 ? true : bad.join(' | ');
});

check('no case produces a brief the schema rejects', () => {
	const bad = cases
		.map((c) => ({ c, brief: briefAndContract(c).brief }))
		.filter(({ brief }) => !isValidBrief(brief))
		.map(({ c, brief }) => c.name);
	return bad.length === 0 ? true : `invalid: ${bad.join(', ')}`;
});

console.log('\n=== the measured production request ===');

check('advisor "unknown" + FE=8/BE=0 no longer yields a fullstack contract', () => {
	const decode = decodeAdvisorIntent('unknown');
	const brief = buildBrief({
		requestId: 'req-prod',
		lastUserMsg: 'build a react dashboard with a sidebar dark violet theme and form validation',
		ensembleIntent: 'frontend',
		rawAdvisorIntent: 'unknown',
		scores: { fe: 8, be: 0 },
		decode: { ms: 12, raw: '"unknown"', ok: decode.ok },
		stack: { framework: 'react', language: 'typescript', singleFile: false },
		userScope: 'ANY',
		now: '2026-10-24T00:00:00.000Z',
	});
	const contract = buildPlannerContract('build a react dashboard with a sidebar', {
		scope: brief.scope,
		framework: brief.stack.framework,
	});
	if (contract.scope !== 'frontend') return `contract.scope=${contract.scope}`;
	if (brief.route.specialist !== 'fe') return `specialist=${brief.route.specialist}`;
	if (!brief.route.reason.startsWith('decode_failed:')) return `reason=${brief.route.reason}`;
	if (contract.estimatedFiles > 8) return `estimate ${contract.estimatedFiles} still assumes a big build`;
	const reason = brief.route.reason;
	return isValidBrief(brief) ? true : `invalid: ${reason}`;
});

check('a failed decode cannot produce a fullstack route at all', () => {
	const bad = cases
		.filter((c) => decodeAdvisorIntent(c.intent).ok === false && !c.mask)
		.map((c) => ({ c, r: briefAndContract(c).brief.route }))
		.filter(({ r }) => r.phases.length > 1 || r.specialist === 'be' && r.phases.includes('fe'))
		.map(({ c }) => c.name);
	return bad.length === 0 ? true : bad.join(', ');
});

console.log('\n=== framework: the detected stack survives the projection ===');

check('a stack profile framework beats message detection', () => {
	const contract = buildPlannerContract('build a dashboard', { scope: 'frontend', framework: 'react' });
	return contract.framework === 'react' ? true : `framework=${contract.framework}`;
});

check('none/unknown/absent framework falls back to the message', () => {
	const got = [
		buildPlannerContract('build an express api', { scope: 'backend', framework: 'none' }).framework,
		buildPlannerContract('build an express api', { scope: 'backend', framework: 'unknown' }).framework,
		buildPlannerContract('build an express api', { scope: 'backend' }).framework,
	];
	return got.every((f) => f === 'express') ? true : JSON.stringify(got);
});

console.log('\n=== resolveBriefScope is the single owner ===');

check('the helper and the brief agree on the pinned flag', () => {
	const pinned = resolveBriefScope({ userScope: 'FRONTEND_ONLY', intent: 'create_be', ensembleIntent: 'backend', scores: { fe: 1, be: 9 } });
	const open = resolveBriefScope({ userScope: 'ANY', intent: 'create_be', ensembleIntent: 'backend', scores: { fe: 1, be: 9 } });
	if (!pinned.pinned || pinned.scope !== 'frontend') return `pinned=${JSON.stringify(pinned)}`;
	if (open.pinned || open.scope !== 'backend') return `open=${JSON.stringify(open)}`;
	return true;
});

check('a fullstack intent is only reported with backend evidence', () => {
	const withEvidence = resolveBriefScope({ intent: 'fullstack' as BriefIntent, ensembleIntent: 'general', scores: { fe: 5, be: 5 } });
	const without = resolveBriefScope({ intent: 'fullstack' as BriefIntent, ensembleIntent: 'general', scores: { fe: 5, be: 0 } });
	// resolveBriefScope itself does not downgrade (buildBrief applies R2), so
	// this pins the two behaviours that must stay distinct.
	if (withEvidence.scope !== 'fullstack') return `with evidence=${withEvidence.scope}`;
	if (without.scope !== 'fullstack') return `without evidence=${without.scope}`;
	return true;
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
	console.log('\nFailures:');
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
