/**
 * OutputParser — extract <file path="...">...</file> blocks from raw model output.
 * Extracted from incrementalEngine.ts extractFileBlocks().
 */

import type { GeneratedFile } from '../core/types.js';

export function extractFileBlocks(text: string): GeneratedFile[] {
	const results: GeneratedFile[] = [];
	const seen    = new Set<string>();
	const openRe  = /<file\s+path=["']([^"']+)["']\s*>/gi;
	const opens: { path: string; tagEnd: number }[] = [];
	let m: RegExpExecArray | null;

	while ((m = openRe.exec(text)) !== null) {
		opens.push({ path: m[1]!.trim(), tagEnd: m.index + m[0].length });
	}

	for (let i = 0; i < opens.length; i++) {
		const { path: filePath, tagEnd } = opens[i]!;
		const nextOpen = opens[i + 1]?.tagEnd ?? Infinity;
		const closeTag = '</file>';
		const closeIdx = text.indexOf(closeTag, tagEnd);
		if (closeIdx < 0 || closeIdx > nextOpen) continue;
		const content = text.slice(tagEnd, closeIdx).trim();
		if (!content || seen.has(filePath)) continue;
		seen.add(filePath);
		results.push({ path: filePath, content: cleanCodeBlock(content) });
	}
	return results;
}

function cleanCodeBlock(content: string): string {
	content = content.trim();
	const m = content.match(/^```\w*\r?\n([\s\S]*?)\r?\n```$/);
	return m ? m[1]!.trim() : content;
}

/** Detect repetition loops in streaming output */
export function detectRepetitionLoop(text: string): { detected: boolean; reason?: string } {
	if (text.length < 200) return { detected: false };
	const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
	if (lines.length < 8) return { detected: false };
	for (const size of [50, 30]) {
		const tail = text.slice(-size * 4);
		const chunk = tail.slice(-size);
		if (chunk.length < size) continue;
		let count = 0;
		let pos = 0;
		while ((pos = tail.indexOf(chunk, pos)) !== -1 && pos < tail.length - size) { count++; pos++; }
		if (count >= 4) return { detected: true, reason: `Repeated pattern (${size}chars x${count})` };
	}
	return { detected: false };
}
