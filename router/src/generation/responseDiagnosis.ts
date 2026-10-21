// ---------------------------------------------------------------------------
// Response Diagnosis
//
// Classifies a model response so the router can tell a COMPLETE answer from
// a severed one or from prose. Pure functions — no I/O, no model access — so
// they can be unit-tested without starting the router.
// ---------------------------------------------------------------------------

import type { AgentMode } from '../routing/agentMode.js';

/**
 * Classify a model response so the router can tell a COMPLETE answer from
 * a severed or non-code one.
 *
 * Two failure modes were invisible before:
 *
 *  1. TRUNCATION — the response hit the token cap and was cut off
 *     mid-attribute. The tokens were counted and logged but never compared
 *     against the cap, so a severed file looked exactly like a complete
 *     one and was written to disk.
 *
 *  2. PROSE-AS-CODE — the model answered in English ("To build a REST API
 *     backend, we'll implement the following components..."). Nothing
 *     could be parsed from it, but it consumed a whole iteration.
 */
export interface ResponseDiagnosis {
	/** The response was cut off at the generation cap. */
	truncated: boolean;
	/** The response contains no code markers at all. */
	prose: boolean;
	/** A one-line explanation, for the log. */
	reason: string;
}

const CODE_MARKERS = [
	/<file\s+path=/i,          // the primary output protocol
	/^\s*import\s+/m,          // import statement
	/^\s*export\s+/m,          // export statement
	/^\s*(?:const|let|var)\s+\w+\s*=/m,
	/^\s*(?:function|class|interface|type|enum)\s+/m,
	/^\s*\/\*/,               // block comment
	/```/,                      // a fenced block
	/<\/?[A-Za-z][\w-]*/,      // JSX element
];

export function diagnoseResponse(response: string, tokenCount: number, maxTokens: number): ResponseDiagnosis {
	// 1. Truncation: the response consumed (essentially) the whole budget.
	//    A small tolerance avoids flagging a response that landed exactly on
	//    the cap by one token.
	const nearCap = maxTokens > 0 && tokenCount >= maxTokens * 0.98;
	if (nearCap) {
		return {
			truncated: true,
			prose: false,
			reason: `the response used ${tokenCount} of ${maxTokens} tokens — it was cut off mid-output`,
		};
	}

	// 2. Prose: no code markers anywhere.
	const hasCode = CODE_MARKERS.some(re => re.test(response));
	if (!hasCode) {
		return {
			truncated: false,
			prose: true,
			reason: 'the response contains no code — it is prose, not output',
		};
	}

	return { truncated: false, prose: false, reason: '' };
}

/**
 * The prompt used when a response was truncated: ask for the REMAINING
 * files, one or two at a time, so each response fits under the cap.
 */
export function buildTruncationContinuationPrompt(mode: AgentMode, lastUserMsg: string, alreadyEmitted: string[]): string {
	const done = alreadyEmitted.length
		? `You already emitted: ${alreadyEmitted.join(', ')}.\n\nDo NOT repeat those files.`
		: '';

	return `<validation_errors>
Your previous response was CUT OFF at the generation limit (${alreadyEmitted.length ? 'some files were emitted before the cut' : 'no file was completed'}), so the last file is incomplete and would not compile.

${done}

Emit the REMAINING files now, and emit FEWER files per response so each one fits completely.
Output each file as a complete block:
<file path="src/Component.tsx">
...complete file content...
</file>

Do not explain. Do not summarize. Only emit file blocks.
</validation_errors>`;
}

/**
 * The prompt used when the model answered in prose instead of code.
 */
export function buildProseOutputPrompt(mode: AgentMode, lastUserMsg: string): string {
	return `<validation_errors>
Your previous response was an EXPLANATION, not code. Nothing could be extracted from it.

Request:
"""
${lastUserMsg.slice(0, 500)}
"""

Output the actual files now. Each file as a complete block:
<file path="src/Component.tsx">
...complete file content...
</file>

Do not explain. Do not summarize. Only emit file blocks.
</validation_errors>`;
}

