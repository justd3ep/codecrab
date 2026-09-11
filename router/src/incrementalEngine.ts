/**
 * IncrementalEngine V2 — Three-Phase Compiler Pipeline
 * =====================================================
 * Phase 1: Incremental loop — generate + LOCAL validate (no project checks) + commit
 * Phase 2: Project validation (once, after queue exhausted) — DependencyStatus-aware
 * Phase 3: Project repair — budget-bounded, planner authority enforced
 */

import fs                        from 'fs';
import path                      from 'path';
import { exec }                  from 'child_process';
import util                      from 'util'
import type { LlamaModel }       from 'node-llama-cpp';
import { LlamaChatSession }      from 'node-llama-cpp';
import type express              from 'express';

import type { ExecutionGraph, FileNode, DependencyEdge } from './planner.js';
import { nextPendingNode, markNodeFailed, isGraphComplete, graphSummary, verifyGraph } from './planner.js';
import { buildDepContext, runRepairLoop, classifyRepairDecision }   from './repairEngine.js';
import { runPostGenerationValidator, runLocalFileValidator }        from './validator.js';
import type { ValidationContract, GeneratedFile }                   from './validator.js';
import { patchTier2Caches }                                        from './rag/index.js';
import { SymbolIndex, PromptCache }                                 from './symbolIndex.js';
import { ManifestManager }                                         from './generationManifest.js';
import { SnapshotManager }                                         from './workspaceSnapshot.js';
import { MetricsCollector }                                        from './pipelineMetrics.js';
import { PipelineStateMachine, PipelineState, DEFAULT_REPAIR_BUDGET } from './pipelineState.js';
import type { RepairBudget }                                       from './pipelineState.js';
import { updateContextUsage }                                      from './telemetry/contextUsage.js';

const execPromise = util.promisify(exec);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IncrementalEngineOptions {
	graph:              ExecutionGraph;
	workspaceRoot:      string;
	model:              LlamaModel;
	systemPrompt:       string;
	userRequest:        string;
	validationContract: ValidationContract;
	res:                express.Response;
	signal:             AbortSignal;
	contextSize?:       number;
	maxTokensPerFile:   number;
	repairBudget?:      RepairBudget;
	onFileCommitted?:   (node: FileNode, content: string) => void;
}

export interface IncrementalEngineResult {
	committedFiles:  string[];
	failedFiles:     string[];
	skippedFiles:    string[];
	totalNodes:      number;
	usedFallback:    false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function streamChunk(res: express.Response, content: string): void {
	res.write(JSON.stringify({ message: { content } }) + '\n');
}

interface PipelineEvent {
	type:  'progress' | 'success' | 'warning' | 'error' | 'info' | 'context_usage';
	stage?: 'read' | 'plan' | 'generate' | 'write' | 'validate' | 'repair' | 'complete';
	message?: string;
	file?:   string;
	used?:   number;
	total?:  number;
	percent?: number;
	model?:  string;
}

function streamEvent(res: express.Response, evt: PipelineEvent): void {
	if (evt.type === 'context_usage') {
		res.write(JSON.stringify({
			type: 'context_usage',
			used: evt.used,
			total: evt.total,
			percent: evt.percent,
			model: evt.model || 'backend'
		}) + '\n');
		return;
	}
	const icon =
		evt.type === 'success'   ? '✓'
		: evt.type === 'error'   ? '✗'
		: evt.type === 'warning' ? '!'
		: '•';
	res.write(JSON.stringify({ message: { content: `${icon} ${evt.message}\n` }, event: evt }) + '\n');
}

function cleanCodeBlock(content: string): string {
	content = content.trim();
	const match = content.match(/^```\w*\r?\n([\s\S]*?)\r?\n```$/);
	return match ? match[1]!.trim() : content;
}

function extractFileBlocks(text: string): GeneratedFile[] {
	const results: GeneratedFile[] = [];
	const seen    = new Set<string>();
	const openTagRe = /<file\s+path=["']([^"']+)["']\s*>/gi;
	const openTags: { path: string; tagEnd: number; startIndex: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = openTagRe.exec(text)) !== null) {
		openTags.push({ path: m[1]!.trim(), tagEnd: m.index + m[0].length, startIndex: m.index });
	}
	for (let i = 0; i < openTags.length; i++) {
		const tag       = openTags[i]!;
		const afterTag  = tag.tagEnd;
		const remaining = text.substring(afterTag);
		const closeMatch    = remaining.match(/<\/file>/i);
		const nextOpenStart = i + 1 < openTags.length ? openTags[i + 1]!.startIndex : text.length;
		let endIndex = closeMatch && (afterTag + closeMatch.index!) < nextOpenStart
			? afterTag + closeMatch.index!
			: nextOpenStart;
		let content = text.substring(afterTag, endIndex).trim().replace(/<\/file>\s*$/i, '').trim();
		content = cleanCodeBlock(content);
		if (tag.path && content && content.length > 5 && !seen.has(tag.path)) {
			seen.add(tag.path);
			results.push({ path: tag.path, content });
		}
	}
	return results;
}

async function compileCheck(filePath: string, workspaceRoot: string, hasTypeConfig: boolean): Promise<string[]> {
	if (!hasTypeConfig) return [];
	const absPath = path.join(workspaceRoot, filePath);
	if (!fs.existsSync(absPath)) return [];
	try {
		const cmd = `npx --no-install tsc --noEmit --isolatedModules --skipLibCheck --target ES2020 --module NodeNext --moduleResolution NodeNext "${absPath}" 2>&1 || true`;
		const { stdout } = await execPromise(cmd, { cwd: workspaceRoot, timeout: 15_000 });
		return stdout.split('\n').filter(l => l.includes('error TS') && l.includes(path.basename(filePath))).slice(0, 5);
	} catch { return []; }
}

// ---------------------------------------------------------------------------
// Per-file prompt builder (signature-based dep context)
// ---------------------------------------------------------------------------

function buildSingleFilePrompt(
	node:        FileNode,
	graph:       ExecutionGraph,
	symbolIndex: SymbolIndex,
	promptCache: PromptCache,
	userRequest: string,
): string {
	// Build dep signatures
	const depPaths = node.dependencies.map((d: DependencyEdge) => d.path);
	const depSig   = symbolIndex.getAllSignatures(depPaths);
	const cacheKey = depSig;

	const cached = promptCache.get(node.path, cacheKey);
	if (cached) return cached;

	const lines: string[] = [
		`You are generating ONE file for a ${graph.architecture} architecture ${graph.framework} project.`,
		``,
		`File to generate: ${node.path}`,
		`Module:           ${node.module}`,
		`Layer:            ${node.layer}`,
		`Language:         ${graph.language}`,
		``,
	];

	if (depSig) {
		lines.push('--- Dependency Signatures (import from these paths) ---');
		lines.push(depSig);
		lines.push('');
	}

	const committed = graph.nodes.filter(n => n.status === 'committed').map(n => n.path);
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

	const prompt = lines.join('\n');
	promptCache.set(node.path, cacheKey, prompt);
	return prompt;
}

// ---------------------------------------------------------------------------
// Link check (fast pre-tsc import graph verification)
// ---------------------------------------------------------------------------

interface LinkResult {
	passed: boolean;
	errors: Array<{ file: string; import: string; status: string }>;
}

function runLinkCheck(files: GeneratedFile[], symbolIndex: SymbolIndex): LinkResult {
	const errors: LinkResult['errors'] = [];
	const generatedPaths = new Set(files.map(f => f.path));
	const importRe = /^import\s+(?:[\w{}\s*,]+\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/gm;

	for (const f of files) {
		let m: RegExpExecArray | null;
		while ((m = importRe.exec(f.content)) !== null) {
			const spec    = m[1]!;
			const fromDir = path.dirname(f.path);
			const resolved = path.normalize(path.join(fromDir, spec));
			const exts = ['.ts', '.tsx', '.js', '.jsx', ''];
			const found = exts.some(e =>
				generatedPaths.has(resolved + e) || symbolIndex.has(resolved + e)
			);
			if (!found) {
				errors.push({ file: f.path, import: spec, status: 'Missing' });
			}
		}
	}

	return { passed: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export async function runIncrementalEngine(opts: IncrementalEngineOptions): Promise<IncrementalEngineResult> {
	const {
		graph, workspaceRoot, model, systemPrompt, userRequest,
		validationContract, res, signal, maxTokensPerFile,
		contextSize = 8192,
		repairBudget = DEFAULT_REPAIR_BUDGET,
		onFileCommitted,
	} = opts;

	// ── Infrastructure ────────────────────────────────────────────────────────
	const stateMachine  = new PipelineStateMachine();
	const symbolIndex   = new SymbolIndex();
	const promptCache   = new PromptCache();
	const metrics       = new MetricsCollector();
	const snapshots     = new SnapshotManager();
	const hasTypeConfig = fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'));

	// Pre-populate symbol index from already-committed nodes
	const committedContent = new Map<string, string>();
	for (const node of graph.nodes) {
		if (node.status === 'committed') {
			try {
				const content = fs.readFileSync(path.join(workspaceRoot, node.path), 'utf-8');
				committedContent.set(node.path, content);
				symbolIndex.add({ path: node.path, content });
			} catch { /* ignore */ }
		}
	}

	// Manifest
	const manifest = new ManifestManager(workspaceRoot, {
		expectedFiles:  graph.nodes.length,
		generatedFiles: committedContent.size,
		remaining:      graph.nodes.length - committedContent.size,
		failedFiles:    [],
		skippedFiles:   [],
		committedFiles: [...committedContent.keys()],
		architecture:   graph.architecture,
		framework:      graph.framework,
		modules:        graph.modules,
	});
	manifest.setStatus('running');

	// Planner verification (non-fatal)
	stateMachine.transition(PipelineState.BuildingGraph);
	const verification = verifyGraph(graph);
	if (!verification.valid) {
		console.warn(`[IncrementalEngine] Graph has issues — duplicates=${verification.duplicatePaths.length} cycles=${verification.cycles.length} invalid=${verification.invalidPaths.length}`);
	}
	for (const w of verification.warnings) console.log(`[IncrementalEngine] Graph warning: ${w}`);

	// Snapshot before generation
	snapshots.take(graph, symbolIndex.snapshot(), committedContent, manifest.current);

	const result: IncrementalEngineResult = {
		committedFiles: [],
		failedFiles:    [],
		skippedFiles:   [],
		totalNodes:     graph.nodes.length,
		usedFallback:   false,
	};

	const committedPaths = new Set<string>(committedContent.keys());
	const plannedPaths   = new Set<string>(graph.nodes.map(n => n.path));

	stateMachine.transition(PipelineState.Generating);
	manifest.setStatus('running');

	// ── PHASE 1: Incremental generation loop ─────────────────────────────────
	while (!isGraphComplete(graph)) {
		if (signal.aborted) { console.log('[IncrementalEngine] Aborted.'); break; }

		const node = nextPendingNode(graph);
		if (!node) {
			console.log('[IncrementalEngine] Deadlock — no pending nodes available.');
			for (const n of graph.nodes) {
				if (n.status === 'pending') { n.status = 'skipped'; result.skippedFiles.push(n.path); manifest.recordSkip(n.path); }
			}
			break;
		}

		node.status = 'generating';
		streamEvent(res, { type: 'progress', stage: 'generate', message: `Generating \`${node.path}\`...`, file: node.path });

		const ctxChars  = symbolIndex.getAllSignatures(node.dependencies.map((d: DependencyEdge) => d.path)).length;
		const cacheHit  = promptCache.get(node.path, symbolIndex.getAllSignatures(node.dependencies.map((d: DependencyEdge) => d.path))) !== null;
		metrics.startGenerate(node.path, ctxChars, cacheHit);

		let context: import('node-llama-cpp').LlamaContext | null = null;
		let generatedFile: GeneratedFile | null = null;

		try {
			context = await model.createContext({ contextSize });
			const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt });

			const filePrompt = buildSingleFilePrompt(node, graph, symbolIndex, promptCache, userRequest);
			let rawResponse  = '';
			let loopDetected = false;
			let chunkCount   = 0;

			try {
				const promptTokens = model ? model.tokenize(systemPrompt + '\n' + filePrompt).length : 0;
				const initialTokens = Math.max(session?.sequence?.nextTokenIndex || 0, promptTokens);
				updateContextUsage(initialTokens, contextSize, 'backend');
				streamEvent(res, {
					type: 'context_usage',
					used: initialTokens,
					total: contextSize,
					percent: Math.min(100, Math.round((initialTokens / contextSize) * 100)),
					model: 'backend'
				});
			} catch {}

			await session.prompt(filePrompt, {
				maxTokens:         maxTokensPerFile,
				signal,
				stopOnAbortSignal: true,
				onTextChunk(chunk) {
					rawResponse += chunk;
					chunkCount++;
					if (chunkCount % 12 === 0) {
						try {
							const liveTokens = session?.sequence?.nextTokenIndex || 0;
							if (liveTokens > 0) {
								updateContextUsage(liveTokens, contextSize, 'backend');
								streamEvent(res, {
									type: 'context_usage',
									used: liveTokens,
									total: contextSize,
									percent: Math.min(100, Math.round((liveTokens / contextSize) * 100)),
									model: 'backend'
								});
							}
						} catch {}
					}
					const lines = rawResponse.split('\n').map(l => l.trim()).filter(Boolean);
					if (lines.length >= 8) {
						const last = lines[lines.length - 1]!;
						if (last.length > 15) {
							let count = 0;
							for (let i = lines.length - 2; i >= Math.max(0, lines.length - 8); i--) {
								if (lines[i] === last) count++;
							}
							if (count >= 4) loopDetected = true;
						}
					}
				},
			});

			try {
				const currentTokens = session?.sequence?.nextTokenIndex || 0;
				if (currentTokens > 0) {
					updateContextUsage(currentTokens, contextSize, 'backend');
					streamEvent(res, {
						type: 'context_usage',
						used: currentTokens,
						total: contextSize,
						percent: Math.min(100, Math.round((currentTokens / contextSize) * 100)),
						model: 'backend'
					});
				}
			} catch {}

			metrics.endGenerate(node.path, filePrompt.length, rawResponse.length);

			if (loopDetected) {
				streamEvent(res, { type: 'warning', stage: 'generate', message: `Loop detected for \`${node.path}\`. Skipping.`, file: node.path });
				markNodeFailed(graph, node); result.failedFiles.push(node.path); manifest.recordFailure(node.path); continue;
			}

			const blocks = extractFileBlocks(rawResponse);
			const block  = blocks.find(b => b.path === node.path) ?? blocks[0] ?? null;

			if (!block) {
				streamEvent(res, { type: 'error', stage: 'generate', message: `No file block for \`${node.path}\`. Skipping.`, file: node.path });
				markNodeFailed(graph, node); result.failedFiles.push(node.path); manifest.recordFailure(node.path); continue;
			}

			generatedFile = block;
		} finally {
			if (context) { await context.dispose(); context = null; }
		}

		if (!generatedFile) { markNodeFailed(graph, node); result.failedFiles.push(node.path); manifest.recordFailure(node.path); continue; }

		// ── LOCAL VALIDATION (per-file, no project checks) ─────────────────
		stateMachine.safeTransition(PipelineState.LocalValidation);
		metrics.startValidate(node.path);
		streamEvent(res, { type: 'progress', stage: 'validate', message: `Validating \`${node.path}\`...`, file: node.path });

		const localResult = await runLocalFileValidator(generatedFile, workspaceRoot, validationContract, graph, committedPaths);
		metrics.endValidate(node.path);

		const compileErrors = await compileCheck(node.path, workspaceRoot, hasTypeConfig);

		const localIssues = [
			...localResult.issues.filter(i => i.severity === 'error' && (!i.file || i.file === node.path)),
			...compileErrors.map(e => ({ kind: 'compile_error' as const, file: node.path, message: e, severity: 'error' as const })),
		];

		let finalFile = localResult.files[0] ?? generatedFile;

		// ── LOCAL REPAIR (budget-bounded, no project checks) ───────────────
		if (localIssues.length > 0) {
			streamEvent(res, { type: 'warning', stage: 'repair', message: `${localIssues.length} issue(s). Repairing \`${node.path}\`...`, file: node.path });
			metrics.startRepair(node.path);

			let repairCtx: import('node-llama-cpp').LlamaContext | null = null;
			try {
				repairCtx = await model.createContext({ contextSize });
				const repairSession = new LlamaChatSession({ contextSequence: repairCtx.getSequence(), systemPrompt });
				const depCtx = node.dependencies.map((d: DependencyEdge) => symbolIndex.getSignature(d.path)).filter(Boolean);

				const repairOutcome = await runRepairLoop(
					localIssues, finalFile, depCtx, repairSession, maxTokensPerFile, signal,
					async (file) => {
						const vr = await runLocalFileValidator(file, workspaceRoot, validationContract, graph, committedPaths);
						return vr.issues.filter(i => i.severity === 'error');
					},
					repairBudget,
					plannedPaths,
					committedPaths,
				);
				finalFile = repairOutcome.file;
				streamEvent(res, {
					type: repairOutcome.resolvedCount > 0 ? 'success' : 'warning',
					stage: 'repair',
					message: `Repair: ${repairOutcome.resolvedCount} resolved, ${repairOutcome.skippedCount} skipped`,
					file: node.path,
				});
			} finally {
				if (repairCtx) { await repairCtx.dispose(); repairCtx = null; }
			}
			metrics.endRepair(node.path);
		}

		// ── COMMIT ─────────────────────────────────────────────────────────
		stateMachine.safeTransition(PipelineState.Committing);
		try {
			const absPath = path.join(workspaceRoot, finalFile.path);
			const dir     = path.dirname(absPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const oldContent = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : '';
			fs.writeFileSync(absPath, finalFile.content, 'utf-8');

			// Update indexes
			node.status           = 'committed';
			node.committedContent = finalFile.content;
			committedContent.set(finalFile.path, finalFile.content);
			committedPaths.add(finalFile.path);
			symbolIndex.add(finalFile);
			promptCache.invalidate(finalFile.path);
			manifest.recordCommit(finalFile.path);
			result.committedFiles.push(finalFile.path);

			const oldLines = oldContent ? oldContent.split('\n') : [];
			const newLines = finalFile.content.split('\n');
			const oldSet = new Set(oldLines); const newSet = new Set(newLines);
			let added = 0; let deleted = 0;
			for (const l of newLines) if (!oldSet.has(l)) added++;
			for (const l of oldLines) if (!newSet.has(l)) deleted++;

			streamEvent(res, { type: 'success', stage: 'write', message: `Written \`${finalFile.path}\``, file: finalFile.path });
			if (added > 0 || deleted > 0) streamChunk(res, `\n\`\`\`diff\n+ ${added} lines added\n- ${deleted} lines deleted\n\`\`\`\n`);
			console.log(`[Pipeline] {"phase":"commit","file":"${finalFile.path}","exports":${JSON.stringify([...new Set(symbolIndex.get(finalFile.path)?.exports ?? [])])}}`);

			try { patchTier2Caches(workspaceRoot, finalFile.path); } catch { /* non-fatal */ }
			onFileCommitted?.(node, finalFile.content);

		} catch (writeErr: any) {
			streamEvent(res, { type: 'error', stage: 'write', message: `Write failed for \`${node.path}\`: ${writeErr.message}`, file: node.path });
			markNodeFailed(graph, node); result.failedFiles.push(node.path); manifest.recordFailure(node.path); continue;
		}

		stateMachine.safeTransition(PipelineState.Generating);
		console.log(`[IncrementalEngine] graph: ${graphSummary(graph)}`);
	}

	// ── PHASE 2: Project validation (once) ────────────────────────────────────
	if (!signal.aborted && result.committedFiles.length > 0) {
		stateMachine.safeTransition(PipelineState.ProjectValidation);
		manifest.setStatus('validating');
		streamEvent(res, { type: 'progress', stage: 'validate', message: 'Running project validation...' });

		const allCommitted: GeneratedFile[] = [];
		for (const p of result.committedFiles) {
			try {
				const content = fs.readFileSync(path.join(workspaceRoot, p), 'utf-8');
				allCommitted.push({ path: p, content });
			} catch { /* ignore */ }
		}

		const pvStart = Date.now();
		const projectResult = await runPostGenerationValidator(allCommitted, workspaceRoot, validationContract, false, graph, committedPaths);
		metrics.recordProjectValidate(Date.now() - pvStart);

		// Filter to only genuinely missing (not Planned)
		const realErrors = projectResult.issues.filter(i => i.severity === 'error');

		// Save any synthesized files to disk before link check and compilation
		for (const f of projectResult.files) {
			const absPath = path.join(workspaceRoot, f.path);
			if (!fs.existsSync(absPath)) {
				try {
					fs.mkdirSync(path.dirname(absPath), { recursive: true });
					fs.writeFileSync(absPath, f.content, 'utf-8');
					console.log(`[IncrementalEngine] Written synthesized file: ${f.path}`);
					committedPaths.add(f.path);
					allCommitted.push(f);
				} catch { /* non-fatal */ }
			}
		}

		if (realErrors.length === 0) {
			streamEvent(res, { type: 'success', stage: 'validate', message: 'Project validation passed' });
		} else {
			streamEvent(res, { type: 'warning', stage: 'validate', message: `Project validation: ${realErrors.length} issue(s)` });
		}

		// ── Link check ────────────────────────────────────────────────────────
		stateMachine.safeTransition(PipelineState.Linking);
		const lStart = Date.now();
		const linkResult = runLinkCheck(allCommitted, symbolIndex);
		metrics.recordLink(Date.now() - lStart);

		if (!linkResult.passed) {
			console.log(`[IncrementalEngine] Link errors: ${linkResult.errors.length}`);
			for (const e of linkResult.errors.slice(0, 5)) {
				console.log(`  [Link] ${e.file} → "${e.import}" (${e.status})`);
			}
		}

		// ── Compile (only if link passed) ─────────────────────────────────────
		if (linkResult.passed && hasTypeConfig) {
			stateMachine.safeTransition(PipelineState.Compiling);
			streamEvent(res, { type: 'progress', stage: 'validate', message: 'Running tsc compile check...' });
			try {
				const cStart = Date.now();
				const { stdout } = await execPromise(
					`npx --no-install tsc --noEmit --skipLibCheck 2>&1 || true`,
					{ cwd: workspaceRoot, timeout: 60_000 },
				);
				metrics.recordCompile(Date.now() - cStart);
				const tscErrors = stdout.split('\n').filter(l => l.includes('error TS')).slice(0, 10);
				if (tscErrors.length > 0) {
					streamEvent(res, { type: 'warning', stage: 'validate', message: `tsc: ${tscErrors.length} error(s)` });
					for (const e of tscErrors) console.log(`  [tsc] ${e}`);
				} else {
					streamEvent(res, { type: 'success', stage: 'validate', message: 'tsc compile passed' });
				}
			} catch { /* non-fatal */ }
		}

		// ── Phase 3: Project repair (budget-bounded) ─────────────────────────
		if (realErrors.length > 0 && !signal.aborted) {
			stateMachine.safeTransition(PipelineState.ProjectRepair);
			manifest.setStatus('repairing');
			streamEvent(res, { type: 'progress', stage: 'repair', message: `Project repair: ${realErrors.length} issue(s)` });

			let repairsUsed = 0;
			for (const issue of realErrors) {
				if (signal.aborted || repairsUsed >= repairBudget.maxProjectRepairs) break;

				const decision = classifyRepairDecision(issue, committedPaths, plannedPaths);
				if (decision.action === 'skip_planned') {
					console.log(`[ProjectRepair] skip_planned: ${decision.reason}`); continue;
				}
				if (decision.action === 'planner_expansion') {
					console.log(`[ProjectRepair] planner_expansion: ${decision.suggestedPath} (skipped — planner authority)`); continue;
				}
				if (decision.action === 'skip') {
					console.log(`[ProjectRepair] skip: ${decision.reason}`); continue;
				}
				repairsUsed++;
				console.log(`[ProjectRepair] repair action=${decision.action} issue=[${issue.kind}] ${issue.message?.slice(0, 80)}`);
			}
			if (repairsUsed >= repairBudget.maxProjectRepairs) {
				console.warn(`[ProjectRepair] Budget exhausted (${repairBudget.maxProjectRepairs}).`);
			}
		}
	}

	// ── Finalize ─────────────────────────────────────────────────────────────
	const failedCount   = result.failedFiles.length;
	const skippedCount  = result.skippedFiles.length + graph.nodes.filter(n => n.status === 'skipped').length;
	manifest.setStatus(failedCount > 0 ? 'failed' : 'done');

	stateMachine.safeTransition(failedCount > 0 ? PipelineState.Failed : PipelineState.Completed);
	streamEvent(res, {
		type: failedCount > 0 ? 'warning' : 'success',
		stage: 'complete',
		message: `Incremental pipeline complete: ${result.committedFiles.length} written, ${failedCount} failed, ${skippedCount} skipped`,
	});

	// Persist metrics
	const finalMetrics = metrics.finalize(graph.nodes.length);
	metrics.persist(workspaceRoot, finalMetrics);
	console.log(`[Pipeline] {"phase":"complete","committed":${result.committedFiles.length},"failed":${failedCount},"skipped":${skippedCount},"modelCalls":${finalMetrics.modelCallCount}}`);

	for (const n of graph.nodes) {
		if (n.status === 'skipped' && !result.skippedFiles.includes(n.path)) result.skippedFiles.push(n.path);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Should we use incremental engine for this request?
// ---------------------------------------------------------------------------

export function shouldUseIncrementalEngine(opts: {
	intent:    string;
	isCreate:  boolean;
	graph:     ExecutionGraph | null;
	minNodes?: number;
}): boolean {
	const { intent, graph, minNodes = 3 } = opts;
	if (intent === 'frontend') return false;
	if (!graph || graph.nodes.length < minNodes) return false;
	return true;
}
