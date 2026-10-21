// ---------------------------------------------------------------------------
// Advisor JSON Parsing (tolerant)
//
// The Advisor model is small (0.6B) and its output is sometimes cut off
// mid-array. A strict parse cannot read that, and a regex that requires a
// closing `}` cannot either — so the whole advisor pass was discarded and
// routing fell back to keyword scores alone.
//
// A pure function, in its own module, so it can be unit-tested without
// starting the router.
// ---------------------------------------------------------------------------

export function parseAdvisorJson(raw: string): Record<string, any> | null {
	const stripped = raw.replace(/```json?\s*/gi, '').replace(/```\s*/g, '').trim();

	// 1. The normal case: a complete object.
	const match = stripped.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			return JSON.parse(match[0]);
		} catch { /* truncated or malformed — fall through */ }
	}

	// 2. The truncated case: read the fields individually. No closing
	//    braces needed.
	const out: Record<string, any> = {};

	// A plain string field: "key": "value"
	const strRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = strRe.exec(stripped)) !== null) {
		if (out[m[1]!] === undefined) out[m[1]!] = m[2]!;
	}

	// A number field: "key": 12.5
	const numRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*(-?\d+(?:\.\d+)?)/g;
	while ((m = numRe.exec(stripped)) !== null) {
		if (out[m[1]!] === undefined) out[m[1]!] = Number(m[2]!);
	}

	// An array field: "key": ["a", "b", "c"   (the closing bracket may be
	// missing — take the strings that ARE there).
	const arrRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*\[([^\]]*)\]?/g;
	while ((m = arrRe.exec(stripped)) !== null) {
		if (out[m[1]!] !== undefined) continue;
		const items = [...m[2]!.matchAll(/"([^"]*)"/g)].map(x => x[1]!);
		if (items.length > 0) out[m[1]!] = items;
	}

	return Object.keys(out).length > 0 ? out : null;
}
