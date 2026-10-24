/**
 * verify-brief-schema.ts — the TurnBrief contract admits good briefs and
 * refuses the exact briefs that caused production misroutes.
 *
 * A schema that only accepts well-formed input is worthless: everything
 * well-formed is already fine. These checks are written against the
 * MEASURED failures, so the schema is a regression lock, not decoration:
 *
 *   - the ensemble said FE=8/BE=0 and the contract still said fullstack
 *     (R2: fullstack needs backend evidence)
 *   - a failed advisor returned "unknown" and still steered the route
 *     (R3: a failed decode cannot route, and cannot yield fullstack)
 *   - a patch target with no hash cannot be verified against disk (R4)
 *   - specialist and phases disagreeing means two places decide (R1)
 *
 * Every rejection assertion is paired with a valid brief that differs by
 * exactly the one field under test, so a validator that rejects
 * everything cannot pass this file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { TurnBrief } from '../src/brief/types.js';
import { BRIEF_VERSION } from '../src/brief/types.js';
import { buildBrief, normaliseIntent } from '../src/brief/buildBrief.js';
import { isValidBrief, validateBrief } from '../src/brief/validate.js';
import { routeFromBrief } from '../src/brief/routeFromBrief.js';
import { serializeBrief, writeBrief } from '../src/brief/serialize.js';

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
		failures.push(`${name} -> ${res}`);
		console.log(`  FAIL  ${name} -> ${res}`);
	}
}

/** A valid brief. Tests break exactly one field from here. */
function validBrief(): TurnBrief {
	return {
		version: BRIEF_VERSION,
		requestId: 'req-1',
		decode: {
			model: 'qwen-advisor-v1',
			ms: 941,
			promptTokens: 0,
			ok: true,
			failed: false,
			raw: '{"intent":"create_fe","framework":"react"}',
		},
		intent: 'create_fe',
		scope: 'frontend',
		stack: { framework: 'react', language: 'typescript', singleFile: false },
		modules: ['dashboard', 'sidebar'],
		features: ['form_validation'],
		fileKnowledge: { indexedAt: '2026-10-24T00:00:00.000Z', fileCount: 14, edges: 41, files: [], retrieved: [] },
		targets: [],
		route: {
			specialist: 'fe',
			phases: ['fe'],
			scores: { fe: 8, be: 0 },
			reason: 'create_fe:decoded fe=8 be=0',
			confidence: 0.86,
		},
	};
}

/** Deep clone with one field replaced, without mutating the original. */
function withField(mutate: (b: any) => void): TurnBrief {
	const b: any = JSON.parse(JSON.stringify(validBrief()));
	mutate(b);
	return b as TurnBrief;
}

console.log('=== the schema accepts a well-formed brief ===');

check('a hand-built valid brief passes', () => {
	const v = validateBrief(validBrief());
	return v.length === 0 ? true : v.join('; ');
});

check('a built brief passes (build -> validate round trip)', () => {
	const b = buildBrief({
		requestId: 'req-round',
		lastUserMsg: 'build a react dashboard with a sidebar',
		ensembleIntent: 'frontend',
		rawAdvisorIntent: 'create_fe',
		scores: { fe: 8, be: 0 },
		decode: { ms: 900, raw: '{"intent":"create_fe"}', ok: true },
		stack: { framework: 'react', language: 'typescript', singleFile: false },
		features: ['form_validation'],
		now: '2026-10-24T00:00:00.000Z',
	});
	const v = validateBrief(b);
	return v.length === 0 ? true : v.join('; ');
});

console.log('\n=== R2: fullstack requires backend evidence ===');

check('fullstack with be=0 is rejected', () => {
	const b = withField((x) => {
		x.scope = 'fullstack';
		x.route.phases = ['be', 'fe'];
		x.route.specialist = 'be';
	});
	const v = validateBrief(b);
	return v.some((s) => s.includes('without backend evidence')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

check('fullstack with be>=3 is accepted', () => {
	const b = withField((x) => {
		x.scope = 'fullstack';
		x.route.phases = ['be', 'fe'];
		x.route.specialist = 'be';
		x.route.scores = { fe: 4, be: 5 };
	});
	const v = validateBrief(b);
	return v.length === 0 ? true : v.join('; ');
});

check('fullstack with a backend target but be=0 is accepted', () => {
	const b = withField((x) => {
		x.scope = 'fullstack';
		x.route.phases = ['be', 'fe'];
		x.route.specialist = 'be';
		x.targets = [{ path: 'server/routes/users.ts', mode: 'create' }];
	});
	const v = validateBrief(b);
	return v.length === 0 ? true : v.join('; ');
});

console.log('\n=== R3: a failed decode cannot route or claim fullstack ===');

check('decode.failed + scope fullstack is rejected', () => {
	const b = withField((x) => {
		x.scope = 'fullstack';
		x.route.phases = ['be', 'fe'];
		x.route.specialist = 'be';
		x.route.scores = { fe: 0, be: 0 };
		x.decode.ok = false;
		x.decode.failed = true;
	});
	const v = validateBrief(b);
	return v.some((s) => s.includes('failed decode')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

check('decode.failed without a decode_failed: reason is rejected', () => {
	const b = withField((x) => {
		x.decode.ok = false;
		x.decode.failed = true;
		x.route.reason = 'create_fe:decoded';
	});
	const v = validateBrief(b);
	return v.some((s) => s.includes('decode_failed:')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

check('ok and failed both true is rejected', () => {
	const v = validateBrief(withField((x) => { x.decode.failed = true; }));
	return v.some((s) => s.includes('cannot both be true')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

console.log('\n=== R1: one owner for the specialist ===');

check('a missing route.specialist is rejected', () => {
	const v = validateBrief(withField((x) => { delete x.route.specialist; }));
	return v.some((s) => s.includes('route.specialist')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

check('specialist fe with phases ["be"] is rejected', () => {
	const v = validateBrief(withField((x) => { x.route.phases = ['be']; }));
	return v.some((s) => s.includes('not in route.phases')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

check('specialist none with phases is rejected', () => {
	const b = withField((x) => {
		x.route.specialist = 'none';
		x.route.phases = ['fe'];
	});
	const v = validateBrief(b);
	return v.some((s) => s.includes('none cannot have phases')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

console.log('\n=== R4: a patch target must carry its hash ===');

check('a patch target with no hash is rejected', () => {
	const v = validateBrief(withField((x) => { x.targets = [{ path: 'src/App.tsx', mode: 'patch' }]; }));
	return v.some((s) => s.includes('no hash')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

check('a patch target with a hash is accepted', () => {
	const v = validateBrief(validBrief());
	const b = withField((x) => { x.targets = [{ path: 'src/App.tsx', mode: 'patch', hash: '59f2889406ab' }]; });
	const v2 = validateBrief(b);
	return v.length === 0 && v2.length === 0 ? true : `valid=${v.join(';')} patched=${v2.join(';')}`;
});

console.log('\n=== schema integrity ===');

check('a wrong version is rejected', () => {
	const v = validateBrief(withField((x) => { x.version = 2; }));
	return v.some((s) => s.includes('version must be')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

check('a non-object is rejected', () => {
	const v = validateBrief(null);
	return v.length > 0 ? true : 'null passed validation';
});

console.log('\n=== the measured production case, built and validated ===');

check('failed decode + contract fullstack records frontend, not fullstack', () => {
	// Exactly what the log showed: advisor returned "unknown", ensemble had
	// FE=8/BE=0, and plannerContract fell through to scope=fullstack est=10.
	const b = buildBrief({
		requestId: 'req-prod',
		lastUserMsg: 'build a react dashboard with a sidebar dark violet theme and form validation',
		ensembleIntent: 'frontend',
		rawAdvisorIntent: 'unknown',
		scores: { fe: 8, be: 0 },
		decode: { ms: 12, raw: '"unknown"', ok: false },
		stack: { framework: 'react', language: 'typescript', singleFile: false },
		userScope: 'UNSPECIFIED',
		now: '2026-10-24T00:00:00.000Z',
	});
	if (b.scope !== 'frontend') return `scope=${b.scope}, expected frontend`;
	if (b.route.specialist !== 'fe') return `specialist=${b.route.specialist}, expected fe`;
	if (!b.route.reason.startsWith('decode_failed:')) return `reason=${b.route.reason}`;
	const v = validateBrief(b);
	return v.length === 0 ? true : `invalid: ${v.join('; ')}`;
});

check('a valid decode is obeyed over the ensemble', () => {
	const b = buildBrief({
		requestId: 'req-be',
		lastUserMsg: 'add a users table and CRUD endpoints',
		ensembleIntent: 'backend',
		rawAdvisorIntent: 'create_be',
		scores: { fe: 0, be: 7 },
		decode: { ms: 800, raw: '{"intent":"create_be"}', ok: true },
		stack: { framework: 'none', language: 'typescript' },
		now: '2026-10-24T00:00:00.000Z',
	});
	return b.scope === 'backend' && b.route.specialist === 'be' && isValidBrief(b)
		? true
		: `scope=${b.scope} specialist=${b.route.specialist} valid=${isValidBrief(b)}`;
});

check('fullstack intent without backend evidence is downgraded', () => {
	const b = buildBrief({
		requestId: 'req-fs',
		lastUserMsg: 'add a contact form',
		ensembleIntent: 'frontend',
		rawAdvisorIntent: 'fullstack',
		scores: { fe: 6, be: 0 },
		decode: { ms: 700, raw: '{"intent":"fullstack"}', ok: true },
		stack: { framework: 'react', language: 'typescript' },
		now: '2026-10-24T00:00:00.000Z',
	});
	return b.route.phases.length === 1 && b.route.specialist === 'fe' && isValidBrief(b)
		? true
		: `phases=${JSON.stringify(b.route.phases)} scope=${b.scope} specialist=${b.route.specialist}`;
});

check('fullstack intent WITH backend evidence keeps two phases', () => {
	const b = buildBrief({
		requestId: 'req-fs2',
		lastUserMsg: 'full stack app with api and ui',
		ensembleIntent: 'backend',
		rawAdvisorIntent: 'fullstack',
		scores: { fe: 5, be: 5 },
		decode: { ms: 700, raw: '{"intent":"fullstack"}', ok: true },
		stack: { framework: 'react', language: 'typescript' },
		now: '2026-10-24T00:00:00.000Z',
	});
	const phases = JSON.stringify(b.route.phases);
	return phases === '["be","fe"]' && isValidBrief(b) ? true : `phases=${phases} valid=${isValidBrief(b)}`;
});

check('a question routes to no specialist', () => {
	const b = buildBrief({
		requestId: 'req-q',
		lastUserMsg: 'what does this codebase do?',
		ensembleIntent: 'general',
		rawAdvisorIntent: 'question',
		scores: { fe: 0, be: 0 },
		decode: { ms: 400, raw: '{"intent":"question"}', ok: true },
		stack: null,
		now: '2026-10-24T00:00:00.000Z',
	});
	return b.route.specialist === 'none' && b.route.phases.length === 0 && isValidBrief(b)
		? true
		: `specialist=${b.route.specialist} phases=${JSON.stringify(b.route.phases)}`;
});

check('the user scope mask beats a fullstack contract', () => {
	const b = buildBrief({
		requestId: 'req-mask',
		lastUserMsg: 'build the whole thing',
		ensembleIntent: 'backend',
		rawAdvisorIntent: 'fullstack',
		scores: { fe: 5, be: 5 },
		decode: { ms: 700, raw: '{}', ok: true },
		stack: { framework: 'react', language: 'typescript' },
		userScope: 'FRONTEND_ONLY',
		now: '2026-10-24T00:00:00.000Z',
	});
	return b.scope === 'frontend' && b.route.specialist === 'fe' ? true : `scope=${b.scope} specialist=${b.route.specialist}`;
});

check('the user scope mask beats the scores too', () => {
	// The user said backend only; keywords point at the frontend. The
	// instruction wins, and the route says so in its reason.
	const b = buildBrief({
		requestId: 'req-mask2',
		lastUserMsg: 'add a styled settings page',
		ensembleIntent: 'frontend',
		rawAdvisorIntent: 'create_fe',
		scores: { fe: 9, be: 0 },
		decode: { ms: 700, raw: '{}', ok: true },
		stack: { framework: 'react', language: 'typescript' },
		userScope: 'BACKEND_ONLY',
		now: '2026-10-24T00:00:00.000Z',
	});
	if (b.scope !== 'backend' || b.route.specialist !== 'be') {
		return `scope=${b.scope} specialist=${b.route.specialist}`;
	}
	// The decode is recorded as it happened, not rewritten to match.
	if (b.intent !== 'create_fe') return `intent was rewritten to ${b.intent}`;
	return isValidBrief(b) ? true : validateBrief(b).join('; ');
});

check('a scope that contradicts its specialist is rejected', () => {
	// phases are fixed up too, so ONLY the scope/specialist contradiction
	// remains — otherwise this assertion would pass on an unrelated rule.
	const v = validateBrief(withField((x) => { x.route.specialist = 'be'; x.route.phases = ['be']; }));
	return v.some((s) => s.includes('contradicts')) ? true : `not rejected: ${JSON.stringify(v)}`;
});

console.log('\n=== routeFromBrief: never fullstack by default ===');

check('a zero/zero tie routes to fe, not fullstack', () => {
	const r = routeFromBrief({
		intent: 'unknown',
		scope: 'frontend',
		scores: { fe: 0, be: 0 },
		decode: { ok: false, failed: true },
	});
	return r.specialist === 'fe' && r.phases.length === 1 ? true : `${r.specialist} ${JSON.stringify(r.phases)}`;
});

check('be > fe without a decode routes to be', () => {
	const r = routeFromBrief({ intent: 'unknown', scope: 'backend', scores: { fe: 1, be: 6 }, decode: { ok: false, failed: true } });
	return r.specialist === 'be' && r.phases.length === 1 ? true : `${r.specialist} ${JSON.stringify(r.phases)}`;
});

check('normaliseIntent coerces junk to unknown', () => {
	const cases: Array<[string | null, string]> = [
		['create_fe', 'create_fe'],
		['UNKNOWN', 'unknown'],
		['', 'unknown'],
		[null, 'unknown'],
		['make me a website', 'unknown'],
	];
	const bad = cases.filter(([input, want]) => normaliseIntent(input) !== want);
	return bad.length === 0 ? true : JSON.stringify(bad);
});

console.log('\n=== serialization: written when valid, refused when not ===');

check('a valid brief is written and round-trips', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-brief-'));
	try {
		const b = validBrief();
		const file = writeBrief(b, dir);
		if (!file) return 'writeBrief returned null for a valid brief';
		if (!fs.existsSync(file)) return `no file at ${file}`;
		const back = JSON.parse(fs.readFileSync(file, 'utf8')) as TurnBrief;
		if (!isValidBrief(back)) return `written brief is invalid: ${validateBrief(back).join('; ')}`;
		if (serializeBrief(back) !== fs.readFileSync(file, 'utf8')) return 'serialize is not stable';
		return true;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

check('an invalid brief is NOT written', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-brief-bad-'));
	try {
		const bad = withField((x) => { delete x.route.specialist; });
		const file = writeBrief(bad, dir);
		if (file !== null) return `wrote an invalid brief to ${file}`;
		const stray = fs.existsSync(path.join(dir, '.crabcode'))
			? fs.readdirSync(path.join(dir, '.crabcode', 'briefs'))
			: [];
		return stray.length === 0 ? true : `stray files: ${stray.join(', ')}`;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

check('a request id cannot escape the briefs directory', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-brief-id-'));
	try {
		const b = validBrief();
		b.requestId = '../../etc/passwd';
		const file = writeBrief(b, dir);
		if (!file) return 'write returned null';
		return path.dirname(file) === path.join(dir, '.crabcode', 'briefs')
			? true
			: `escaped to ${file}`;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (failures.length > 0) {
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
