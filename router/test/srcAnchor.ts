/**
 * Source anchoring for tests that must survive a refactor.
 *
 * THE PROBLEM
 *
 * The parity tests used to assert "index.ts imports X from module Y".
 * That pinned ONE file as the caller. When the caller moved — the loop
 * to chat/phaseRunner.ts, the preparation block to chat/preparation.ts,
 * the shadow route to router/chatRoutes.ts — every parity test went red
 * even though the property it protects still held.
 *
 * A test that fails when correct code is refactored is testing the
 * refactor, not the property.
 *
 * THE PROPERTY WORTH TESTING
 *
 *   1. exactly ONE definition of X exists in src/ — the module's
 *   2. every file that references X imports it from that module
 *
 * Both hold regardless of which file ends up calling it. A second local
 * copy is what caused the original drift (index.ts held a 10,465-char
 * validator, the module a 3,301-char stale one, and chatRoutes.ts
 * imported the stale one), so a re-introduced copy must still fail.
 *
 * Used by: verify-parity-jsx-pair.ts, verify-parity-targeted-repair.ts,
 * verify-parity-prompt-builders.ts.
 */

import fs from 'fs';
import path from 'path';

/** Every .ts file under src/, as posix-style paths relative to src/. */
export function listSrc(routerRoot: string): string[] {
	const src = path.join(routerRoot, 'src');
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith('.ts')) {
				out.push(path.relative(src, full).split(path.sep).join('/'));
			}
		}
	};
	walk(src);
	return out.sort();
}

export function readRel(routerRoot: string, rel: string): string {
	return fs.readFileSync(path.join(routerRoot, 'src', rel), 'utf8').replace(/\r\n/g, '\n');
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does this source DEFINE `name`?
 *
 * Matches function declarations, const/let/var bindings, interfaces,
 * type aliases and classes — with or without `export`. A call site or a
 * comment does not count.
 */
export function defines(src: string, name: string): boolean {
	const n = esc(name);
	return new RegExp(
		`^\\s*(?:export\\s+)?(?:` +
			`function\\s+${n}\\s*\\(` +
			`|(?:const|let|var)\\s+${n}\\s*(?::|=[^=])` +
			`|interface\\s+${n}\\b` +
			`|type\\s+${n}\\s*=` +
			`|class\\s+${n}\\b` +
		`)`,
		'm',
	).test(src);
}

/** Parse every named import: [{ names, from }]. */
export function namedImports(src: string): { names: string[]; from: string }[] {
	const out: { names: string[]; from: string }[] = [];
	const re = /import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		const names = m[1]!
			.split(',')
			.map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim())
			.filter(Boolean);
		out.push({ names, from: m[2]! });
	}
	return out;
}

/**
 * Does this source import `name` from the module at `moduleRel`
 * ('prompts/promptBuilder.ts')? The import specifier is resolved as a
 * suffix so './prompts/x.js', '../prompts/x.js' and 'prompts/x.ts' all
 * match — the caller's depth does not matter.
 */
export function importsFrom(src: string, name: string, moduleRel: string): boolean {
	const stem = moduleRel.replace(/\.ts$/, '');
	return namedImports(src).some(
		(i) =>
			i.names.includes(name) &&
			(i.from === stem || i.from === `${stem}.js` || i.from === `${stem}.ts` ||
				i.from.endsWith(`/${stem}`) || i.from.endsWith(`/${stem}.js`) || i.from.endsWith(`/${stem}.ts`)),
	);
}

/**
 * The single-source property. Returns [] when it holds, otherwise one
 * human-readable violation per broken file.
 *
 * `moduleRel` is the ONE file allowed to define `name`.
 */
export function singleSourceViolations(routerRoot: string, name: string, moduleRel: string): string[] {
	const violations: string[] = [];
	for (const rel of listSrc(routerRoot)) {
		if (rel === moduleRel) continue;
		const src = readRel(routerRoot, rel);
		const references = new RegExp(`\\b${esc(name)}\\b`).test(src);
		if (defines(src, name)) violations.push(`${rel} defines its own ${name} — the extraction was a COPY, not a MOVE`);
		else if (references && !importsFrom(src, name, moduleRel)) {
			violations.push(`${rel} uses ${name} but does not import it from ${moduleRel}`);
		}
	}
	if (!defines(readRel(routerRoot, moduleRel), name)) {
		violations.push(`${moduleRel} does not define ${name} — the module is the wrong home`);
	}
	return violations;
}
