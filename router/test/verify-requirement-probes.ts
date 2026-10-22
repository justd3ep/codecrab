/**
 * The requirement probes must run for the React path.
 *
 * THE BUG
 *
 * Pass 19b probes the user's OWN WORDS against the generated code —
 * drag and drop, localStorage, dark mode, ARIA, Alt+Arrow, keyboard,
 * responsive, animation, inline edit, delete.
 *
 * The probes are good. But the gate was:
 *
 *     const plain = stack.kind === 'vanilla' || stack.kind === 'single-file';
 *     if (!plain) return;
 *
 * So they ran ONLY for vanilla and single-file. A React request —
 * which is what the frontend model is asked for most of the time —
 * got NO requirement coverage at all.
 *
 * And the coverage SCORE was 0/0, because FEATURE_DETECTION is
 * eighteen of eighteen BACKEND patterns (jwt, uploads, payments,
 * rbac, ...). A frontend request matches none of them, so the
 * contract's requiredFeatures was empty.
 *
 * The result: a React generation that silently dropped the
 * drag-and-drop the user asked for PASSED validation.
 *
 * WHAT THIS PROVES
 *
 * The probe fires for a React deliverable — it is a REAL call into
 * the validator, with a React stack profile, on code that has the
 * evidence, and on code that does not.
 *
 * Run: tsx <this file>
 */
import path from 'path';
import { pathToFileURL } from 'url';

const ROUTER = process.env.CODECRAB_ROUTER_ROOT
	? path.resolve(process.env.CODECRAB_ROUTER_ROOT)
	: 'D:/fedora backup/crab-kode/router';

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

// The validator is imported for its types; the probe itself is not
// exported, so the check drives the FULL validator.
const validatorPath = path.join(ROUTER, 'src', 'validator.ts');
const { runPostGenerationValidator } = await import(
	pathToFileURL(validatorPath).href
) as any;

// The REAL stack profile builder — a hand-built one misses fields
// like forbiddenLibraries, and the validator crashes on them.
const { detectStackProfile } = await import(
	pathToFileURL(path.join(ROUTER, 'src', 'routing', 'stackProfile.ts')).href
) as any;

/** A stack profile for the request. */
function stackFor(request: string) {
	return detectStackProfile(request);
}

/** A validation contract shaped the way the validator wants it. */
function contract(request: string) {
	return {
		scope: 'frontend' as const,
		architecture: 'unknown' as const,
		framework: 'react' as const,
		language: 'typescript' as const,
		requiredFeatures: [],
		requiredFolders: [],
		expectedFiles: [],
		estimatedFiles: 3,
		stack: stackFor(request),
	};
}

/** The React code that has the evidence. */
const WITH_DRAG = [{
	path: 'src/App.tsx',
	content: `import { useState } from 'react';
export default function App() {
	const [items, setItems] = useState<string[]>([]);
	return (
		<div>
			{items.map(i => (
				<div key={i} draggable="true"
					onDragStart={e => e.dataTransfer.setData('text/plain', i)}
					onDragOver={e => e.preventDefault()}
					onDrop={e => setItems(v => v.filter(x => x !== i))}>
					{i}
				</div>
			))}
		</div>
	);
}
`,
}];

/** The React code that silently dropped it. */
const WITHOUT_DRAG = [{
	path: 'src/App.tsx',
	content: `import { useState } from 'react';
export default function App() {
	const [items, setItems] = useState<string[]>([]);
	return <div>{items.map(i => <div key={i}>{i}</div>)}</div>;
}
`,
}];

const REQUEST = 'build a kanban board with drag and drop between columns';

console.log('\n=== a React deliverable that dropped the drag-and-drop ===');

const missing = await runPostGenerationValidator(
	WITHOUT_DRAG as any,
	process.env.TMPDIR || process.env.TEMP || '.',
	contract(REQUEST) as any,
	false,
);

check('the missing drag-and-drop is reported', () => {
	const probes = (missing.issues ?? []).filter(
		(i: any) => i.kind === 'missing_coverage' && /drag/i.test(i.message ?? ''),
	);
	return probes.length > 0
		? true
		: `no drag-and-drop issue — the issues were: ${(missing.issues ?? []).map((i: any) => i.kind).join(', ') || 'none'}`;
});

console.log('\n=== a React deliverable that HAS the drag-and-drop ===');

const present = await runPostGenerationValidator(
	WITH_DRAG as any,
	process.env.TMPDIR || process.env.TEMP || '.',
	contract(REQUEST) as any,
	false,
);

check('the drag-and-drop is NOT reported when it is there', () => {
	const probes = (present.issues ?? []).filter(
		(i: any) => i.kind === 'missing_coverage' && /drag/i.test(i.message ?? ''),
	);
	return probes.length === 0
		? true
		: `it was reported anyway: ${probes[0]!.message}`;
});

console.log('\n=== a vanilla deliverable still works ===');

const vanilla = await runPostGenerationValidator(
	WITHOUT_DRAG as any,
	process.env.TMPDIR || process.env.TEMP || '.',
	{ ...contract(REQUEST), stack: { ...stackFor(REQUEST), kind: 'vanilla' as const } } as any,
	false,
);

check('the vanilla path still reports it', () => {
	const probes = (vanilla.issues ?? []).filter(
		(i: any) => i.kind === 'missing_coverage' && /drag/i.test(i.message ?? ''),
	);
	return probes.length > 0
		? true
		: 'the vanilla path stopped reporting it — the gate is wrong';
});

console.log('\n=== a backend deliverable is not probed ===');

const backend = await runPostGenerationValidator(
	WITHOUT_DRAG as any,
	process.env.TMPDIR || process.env.TEMP || '.',
	{ ...contract(REQUEST), stack: undefined } as any,
	false,
);

check('the backend path is not probed for frontend requirements', () => {
	const probes = (backend.issues ?? []).filter(
		(i: any) => i.kind === 'missing_coverage' && /drag/i.test(i.message ?? ''),
	);
	return probes.length === 0
		? true
		: 'a backend deliverable was probed for frontend requirements';
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('The React path is covered.');
