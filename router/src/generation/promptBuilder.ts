/**
 * PromptBuilder — construct per-file generation prompts.
 * Extracted from incrementalEngine.ts buildSingleFilePrompt().
 */

import path                               from 'path';
import type { FileNode, ExecutionGraph }  from '../core/types.js';

export interface PromptContext {
	graph:       ExecutionGraph;
	userRequest: string;
	depSignatures?: string;   // pre-built signature block from SymbolIndex
}

export function buildSingleFilePrompt(node: FileNode, ctx: PromptContext): string {
	const { graph, userRequest, depSignatures } = ctx;
	const committed = graph.nodes.filter(n => n.status === 'committed').map(n => n.path);

	const lines: string[] = [
		`You are generating ONE file for a ${graph.architecture} architecture ${graph.framework} project.`,
		``,
		`File to generate: ${node.path}`,
		`Module:           ${node.module}`,
		`Layer:            ${node.layer}`,
		`Language:         ${graph.language}`,
		``,
	];

	if (depSignatures) {
		lines.push('--- Dependency Signatures (import from these paths) ---', depSignatures, '');
	}

	if (committed.length > 0) {
		lines.push('--- Already Generated (do NOT re-generate) ---');
		for (const p of committed.slice(0, 20)) lines.push(`  ${p}`);
		lines.push('');
	}

	lines.push(
		'--- Layer Rules ---',
		'  Routes → Controllers → Services → Repositories → Models/Database',
		'  NEVER skip layers.',
		'',
		'--- User Request ---',
		userRequest,
		'',
		'--- Output Instruction ---',
		`Generate ONLY: ${node.path}`,
		`Use: <file path="${node.path}">`,
		`      ... complete file content ...`,
		`     </file>`,
		'Output the complete file. No truncation. No other files.',
	);

	return lines.join('\n');
}

/** Build repair prompt for a single file with specific issues */
export function buildRepairPrompt(
	filePath:    string,
	content:     string,
	issues:      Array<{ message: string; kind: string }>,
	depCtx:      string,
): string {
	const lines = [
		`Repair this file: ${filePath}`,
		``,
		`Issues to fix:`,
		...issues.map((i, idx) => `  ${idx + 1}. [${i.kind}] ${i.message}`),
		``,
	];
	if (depCtx) lines.push('--- Dependencies ---', depCtx, '');
	lines.push(
		'--- Current File Content ---',
		content,
		'',
		`Output the COMPLETE repaired file using: <file path="${filePath}">...</file>`,
	);
	return lines.join('\n');
}
