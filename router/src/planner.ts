/**
 * Planner V2 — Dependency-Aware Execution Graph Builder
 * ======================================================
 * Converts an AdvisorV2 result into a topologically-sorted ExecutionGraph.
 * Every FileNode knows its dependencies, dependents, layer, and generation stage.
 *
 * Pure function — no I/O, no LLM calls.
 * Deterministic for identical inputs.
 */

import type { WorkspaceInspection } from './workspaceInspector.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Layer =
	| 'config'
	| 'database'
	| 'model'
	| 'repository'
	| 'service'
	| 'controller'
	| 'route'
	| 'middleware'
	| 'server'
	| 'other';

export type FileNodeStatus =
	| 'pending'
	| 'generating'
	| 'validated'
	| 'committed'
	| 'failed'
	| 'skipped';   // skipped because a dependency failed

/**
 * Typed dependency edge — carries both target path and semantic import type.
 *
 *   runtime — class/function import used in logic (default)
 *   type    — type/interface only, elided at compile time
 *   config  — configuration/env import
 */
export interface DependencyEdge {
	path: string;
	type: 'runtime' | 'type' | 'config';
}

export interface FileNode {
	/** Planned relative path in the workspace */
	path: string;
	/** Semantic module name, e.g. "auth", "users" */
	module: string;
	/** Architectural layer */
	layer: Layer;
	/**
	 * Generation stage (1 = first). Files within the same stage have no
	 * inter-dependencies and can theoretically be generated in any order.
	 */
	stage: number;
	/** Typed dependency edges — what this node imports from */
	dependencies: DependencyEdge[];
	/** Relative paths of files that depend on this node */
	dependents: string[];
	/** Order this node should be validated relative to others in the same stage */
	validationOrder: number;
	status: FileNodeStatus;
	/** Set when status === 'committed' */
	committedContent?: string;
}

export interface ExecutionGraph {
	/** All nodes in topological generation order */
	nodes: FileNode[];
	/** Module names extracted from the advisor result */
	modules: string[];
	architecture: string;
	language: 'typescript' | 'javascript';
	framework: string;
	/** Nodes grouped by stage (all nodes in stage N must complete before stage N+1 starts) */
	generationOrder: FileNode[][];
	/** Stage indices where a full-graph structural validation should run */
	validationCheckpoints: number[];
	/** True if graph was built from a complete advisor result */
	fromAdvisorV2: boolean;
}

// ---------------------------------------------------------------------------
// AdvisorV2 result type (matches the new planner.md schema)
// ---------------------------------------------------------------------------

export interface AdvisorV2Result {
	intent: string;
	projectType?: string;
	architecture?: 'repository' | 'mvc' | 'clean' | 'flat' | 'unknown';
	framework?: string;
	language?: 'typescript' | 'javascript';
	database?: string;
	orm?: string;
	authentication?: string;
	requiredFeatures?: string[];
	modules?: string[];
	estimatedFiles?: number;
	generationStrategy?: 'dependency_order' | 'flat';
	confidence?: number;
}

// ---------------------------------------------------------------------------
// Layer dependency ordering (sealed — never reorder without careful thought)
// ---------------------------------------------------------------------------

/**
 * Layer → generation stage.
 * Lower stage = generated first. Files at the same stage have no
 * inter-layer dependencies.
 */
const LAYER_STAGE: Record<Layer, number> = {
	config:     1,
	database:   2,
	model:      3,
	repository: 4,
	service:    5,
	controller: 6,
	route:      7,
	middleware: 7,   // middleware can be at the same stage as routes
	server:     8,
	other:      9,
};

/**
 * For each layer, which layers it directly imports from.
 * Used to wire dependency edges between FileNodes.
 */
const LAYER_IMPORTS: Partial<Record<Layer, Layer[]>> = {
	repository: ['model', 'database', 'config'],
	service:    ['repository', 'model', 'config'],
	controller: ['service'],
	route:      ['controller', 'middleware'],
	server:     ['route', 'middleware', 'config', 'database'],
	middleware: ['service', 'config'],
};

// ---------------------------------------------------------------------------
// File path templates per architecture + layer + module
// ---------------------------------------------------------------------------

type ArchKey = 'repository' | 'mvc' | 'clean' | 'flat' | 'unknown';

interface PathTemplate {
	layerDir: string;           // directory prefix
	suffix: string;             // file name suffix before extension
	include: Layer[];           // which layers this arch generates
}

const ARCH_TEMPLATES: Record<ArchKey, Partial<Record<Layer, PathTemplate>>> = {
	repository: {
		config:     { layerDir: 'src/config',         suffix: '',              include: ['config'] },
		database:   { layerDir: 'src/config',         suffix: '.db',           include: ['database'] },
		model:      { layerDir: 'src/models',          suffix: '',              include: ['model'] },
		repository: { layerDir: 'src/repositories',   suffix: '.repository',   include: ['repository'] },
		service:    { layerDir: 'src/services',        suffix: '.service',      include: ['service'] },
		controller: { layerDir: 'src/controllers',    suffix: '.controller',   include: ['controller'] },
		route:      { layerDir: 'src/routes',          suffix: '.routes',       include: ['route'] },
		middleware: { layerDir: 'src/middleware',      suffix: '',              include: ['middleware'] },
		server:     { layerDir: 'src',                 suffix: '',              include: ['server'] },
	},
	mvc: {
		config:     { layerDir: 'src/config',          suffix: '',              include: ['config'] },
		model:      { layerDir: 'src/models',           suffix: '',              include: ['model'] },
		controller: { layerDir: 'src/controllers',     suffix: '.controller',   include: ['controller'] },
		route:      { layerDir: 'src/routes',           suffix: '.routes',       include: ['route'] },
		middleware: { layerDir: 'src/middleware',       suffix: '',              include: ['middleware'] },
		server:     { layerDir: 'src',                  suffix: '',              include: ['server'] },
	},
	clean: {
		config:     { layerDir: 'src/config',           suffix: '',              include: ['config'] },
		model:      { layerDir: 'src/domain/entities',  suffix: '',              include: ['model'] },
		repository: { layerDir: 'src/infrastructure',  suffix: '.repository',   include: ['repository'] },
		service:    { layerDir: 'src/application',      suffix: '.service',      include: ['service'] },
		controller: { layerDir: 'src/interfaces',       suffix: '.controller',   include: ['controller'] },
		route:      { layerDir: 'src/interfaces',       suffix: '.routes',       include: ['route'] },
		server:     { layerDir: 'src',                  suffix: '',              include: ['server'] },
	},
	flat: {
		model:      { layerDir: 'src',                  suffix: '',              include: ['model'] },
		route:      { layerDir: 'src/routes',            suffix: '',              include: ['route'] },
		server:     { layerDir: 'src',                  suffix: '',              include: ['server'] },
	},
	unknown: {
		model:      { layerDir: 'src/models',            suffix: '',              include: ['model'] },
		service:    { layerDir: 'src/services',          suffix: '.service',      include: ['service'] },
		controller: { layerDir: 'src/controllers',       suffix: '.controller',   include: ['controller'] },
		route:      { layerDir: 'src/routes',            suffix: '.routes',       include: ['route'] },
		server:     { layerDir: 'src',                   suffix: '',              include: ['server'] },
	},
};

// Shared / non-module-specific files per architecture
const SHARED_FILES: Record<ArchKey, Array<{ layer: Layer; path: string; module: string }>> = {
	repository: [
		{ layer: 'config',   path: 'src/config/index.ts',     module: 'config'   },
		{ layer: 'database', path: 'src/config/database.ts',  module: 'database' },
		{ layer: 'server',   path: 'src/server.ts',           module: 'server'   },
		{ layer: 'server',   path: 'src/app.ts',              module: 'app'      },
	],
	mvc: [
		{ layer: 'config',   path: 'src/config/index.ts',     module: 'config'   },
		{ layer: 'server',   path: 'src/server.ts',           module: 'server'   },
		{ layer: 'server',   path: 'src/app.ts',              module: 'app'      },
	],
	clean: [
		{ layer: 'config',   path: 'src/config/index.ts',     module: 'config'   },
		{ layer: 'server',   path: 'src/server.ts',           module: 'server'   },
	],
	flat: [
		{ layer: 'server',   path: 'src/index.ts',            module: 'server'   },
	],
	unknown: [
		{ layer: 'server',   path: 'src/server.ts',           module: 'server'   },
		{ layer: 'server',   path: 'src/app.ts',              module: 'app'      },
	],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFilePath(
	moduleName: string,
	layer: Layer,
	arch: ArchKey,
	ext: string,
): string | null {
	const tmpl = ARCH_TEMPLATES[arch]?.[layer];
	if (!tmpl) return null;
	const suffix = tmpl.suffix || '';
	const fileName = suffix
		? `${moduleName}${suffix}.${ext}`
		: layer === 'server' || layer === 'config'
			? `${moduleName}.${ext}`
			: `${moduleName}.${ext}`;
	return `${tmpl.layerDir}/${fileName}`;
}

function getLayers(arch: ArchKey): Layer[] {
	const tmpl = ARCH_TEMPLATES[arch];
	if (!tmpl) return ['model', 'service', 'controller', 'route', 'server'];
	return Object.keys(tmpl) as Layer[];
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

/**
 * Build a complete ExecutionGraph from an AdvisorV2 result.
 *
 * @param advisor   Parsed AdvisorV2 result. May be partial.
 * @param inspection Pre-computed WorkspaceInspection (optional — pass null for empty workspaces).
 * @returns ExecutionGraph, or null if graph cannot be built.
 */
export function buildExecutionGraph(
	advisor: AdvisorV2Result,
	inspection: WorkspaceInspection | null,
): ExecutionGraph | null {
	try {
		return _buildGraph(advisor, inspection);
	} catch (e: any) {
		console.error(`[Planner] buildExecutionGraph failed: ${e.message}`);
		return null;
	}
}

function _buildGraph(
	advisor: AdvisorV2Result,
	inspection: WorkspaceInspection | null,
): ExecutionGraph {
	const arch     = (advisor.architecture ?? 'unknown') as ArchKey;
	const modules  = (advisor.modules && advisor.modules.length > 0)
		? advisor.modules
		: inferModulesFromIntent(advisor);
	const language = advisor.language ?? 'typescript';
	const ext      = language === 'typescript' ? 'ts' : 'js';

	console.log(`[Planner] Building graph: arch=${arch} modules=[${modules.join(',')}] lang=${language}`);

	// ── 1. Collect planned FileNodes ────────────────────────────────────────
	const nodeMap = new Map<string, FileNode>(); // path → node

	// Shared (non-module-specific) files
	const shared = SHARED_FILES[arch] ?? SHARED_FILES.unknown;
	for (const s of shared) {
		const node: FileNode = {
			path:            s.path,
			module:          s.module,
			layer:           s.layer,
			stage:           LAYER_STAGE[s.layer],
			dependencies:    [] as DependencyEdge[],
			dependents:      [],
			validationOrder: 0,
			status:          'pending',
		};
		nodeMap.set(s.path, node);
	}

	// Module-specific files
	const layers = getLayers(arch);
	for (const mod of modules) {
		for (const layer of layers) {
			if (layer === 'server' || layer === 'config' || layer === 'database') continue; // shared only
			const filePath = buildFilePath(mod.toLowerCase(), layer, arch, ext);
			if (!filePath || nodeMap.has(filePath)) continue;
			const node: FileNode = {
				path:            filePath,
				module:          mod.toLowerCase(),
				layer,
				stage:           LAYER_STAGE[layer],
				dependencies:    [] as DependencyEdge[],
				dependents:      [],
				validationOrder: 0,
				status:          'pending',
			};
			nodeMap.set(filePath, node);
		}
	}

	if (nodeMap.size === 0) {
		throw new Error('No file nodes generated — modules list may be empty or architecture unknown.');
	}

	// ── 2. Wire dependency edges ─────────────────────────────────────────────
	const nodes = Array.from(nodeMap.values());
	for (const node of nodes) {
		const importedLayers = LAYER_IMPORTS[node.layer] ?? [];
		for (const dep of nodes) {
			if (dep.path === node.path) continue;
			if (importedLayers.includes(dep.layer) && dep.module === node.module) {
				// Same module, dependency layer — classify edge type
				const edgeType: DependencyEdge['type'] =
					dep.layer === 'config'   ? 'config'
					: dep.layer === 'model'  ? 'type'
					: 'runtime';
				if (!node.dependencies.some(d => d.path === dep.path)) {
					node.dependencies.push({ path: dep.path, type: edgeType });
				}
				if (!dep.dependents.includes(node.path)) dep.dependents.push(node.path);
			}
		}

		// Shared files (config, database, server) are dependencies of everything
		for (const s of shared) {
			if (s.path === node.path) continue;
			const sLayer = s.layer;
			const importedByNode = importedLayers.includes(sLayer);
			if (importedByNode && !node.dependencies.some(d => d.path === s.path)) {
				const edgeType: DependencyEdge['type'] = sLayer === 'config' ? 'config' : 'runtime';
				node.dependencies.push({ path: s.path, type: edgeType });
				const sNode = nodeMap.get(s.path);
				if (sNode && !sNode.dependents.includes(node.path)) {
					sNode.dependents.push(node.path);
				}
			}
		}
	}

	// ── 3. Mark already-committed nodes (from workspace inspection) ──────────
	if (inspection) {
		for (const node of nodes) {
			const mod = node.module;
			const existing = inspection.existingModules.get(mod);
			if (existing?.some(e => e.layer === node.layer)) {
				// Module+layer already exists in workspace — mark as committed
				node.status = 'committed';
				console.log(`[Planner] node committed (exists): ${node.path}`);
			}
		}
	}

	// ── 4. Topological sort by stage ─────────────────────────────────────────
	nodes.sort((a, b) => {
		if (a.stage !== b.stage) return a.stage - b.stage;
		// Within same stage: sort by module name for determinism
		return a.module.localeCompare(b.module);
	});

	// Assign validationOrder within each stage
	let stageValidationCounter = 0;
	let lastStage = -1;
	for (const node of nodes) {
		if (node.stage !== lastStage) { stageValidationCounter = 0; lastStage = node.stage; }
		node.validationOrder = stageValidationCounter++;
	}

	// ── 5. Group by stage ────────────────────────────────────────────────────
	const stageMap = new Map<number, FileNode[]>();
	for (const node of nodes) {
		if (!stageMap.has(node.stage)) stageMap.set(node.stage, []);
		stageMap.get(node.stage)!.push(node);
	}
	const generationOrder = Array.from(stageMap.entries())
		.sort(([a], [b]) => a - b)
		.map(([, stageNodes]) => stageNodes);

	// ── 6. Validation checkpoints: after model, after service, final ─────────
	const checkpointStages = new Set([
		LAYER_STAGE['model'],
		LAYER_STAGE['service'],
		LAYER_STAGE['route'],
		LAYER_STAGE['server'],
	]);
	const validationCheckpoints = Array.from(checkpointStages).sort((a, b) => a - b);

	const graph: ExecutionGraph = {
		nodes,
		modules,
		architecture: arch,
		language,
		framework:    advisor.framework ?? 'unknown',
		generationOrder,
		validationCheckpoints,
		fromAdvisorV2: true,
	};

	console.log(
		`[Planner] Graph built: ${nodes.length} nodes, ${generationOrder.length} stages,` +
		` ${nodes.filter(n => n.status === 'committed').length} already committed`,
	);

	return graph;
}

// ---------------------------------------------------------------------------
// Module inference fallback (when advisor.modules is empty)
// ---------------------------------------------------------------------------

function inferModulesFromIntent(advisor: AdvisorV2Result): string[] {
	const intent = advisor.intent ?? '';
	if (intent.includes('auth')) return ['auth', 'users'];
	if (advisor.requiredFeatures?.includes('jwt')) return ['auth', 'users'];
	// Minimal default — let the model decide the rest
	return ['users'];
}

// ---------------------------------------------------------------------------
// Graph utilities
// ---------------------------------------------------------------------------

/**
 * Return the next node that is ready to generate:
 * - status === 'pending'
 * - all dependencies are 'committed'
 */
export function nextPendingNode(graph: ExecutionGraph): FileNode | null {
	for (const node of graph.nodes) {
		if (node.status !== 'pending') continue;
		const allDepsCommitted = node.dependencies.every(edge => {
			const dep = graph.nodes.find(n => n.path === edge.path);
			return !dep || dep.status === 'committed';
		});
		if (allDepsCommitted) return node;
	}
	return null;
}

/**
 * Mark a node and all its transitive dependents as 'skipped' when the node fails.
 */
export function markNodeFailed(graph: ExecutionGraph, node: FileNode): void {
	node.status = 'failed';
	const queue = [...node.dependents];
	const seen  = new Set<string>([node.path]);
	while (queue.length > 0) {
		const depPath = queue.shift()!;
		if (seen.has(depPath)) continue;
		seen.add(depPath);
		const depNode = graph.nodes.find(n => n.path === depPath);
		if (depNode && depNode.status === 'pending') {
			depNode.status = 'skipped';
			console.log(`[Planner] skipped (dep failed): ${depNode.path}`);
			queue.push(...depNode.dependents);
		}
	}
}

/**
 * Returns true if all nodes in the graph are in a terminal state
 * (committed, failed, or skipped).
 */
export function isGraphComplete(graph: ExecutionGraph): boolean {
	return graph.nodes.every(n =>
		n.status === 'committed' || n.status === 'failed' || n.status === 'skipped',
	);
}

/**
 * Summary string for logging.
 */
export function graphSummary(graph: ExecutionGraph): string {
	const counts = { pending: 0, generating: 0, validated: 0, committed: 0, failed: 0, skipped: 0 };
	for (const n of graph.nodes) counts[n.status]++;
	return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
}

// ---------------------------------------------------------------------------
// Planner Verification — pre-generation sanity checks
// ---------------------------------------------------------------------------

export interface PlannerVerificationResult {
	valid:             boolean;
	duplicatePaths:    string[];
	unreachableNodes:  string[];
	cycles:            string[][];
	invalidPaths:      string[];   // absolute paths, bad chars, missing extension
	warnings:          string[];
}

/**
 * Verify an ExecutionGraph before generation begins.
 * Non-fatal: returns issues for logging; does not throw.
 * Caller should filter out bad nodes rather than aborting.
 */
export function verifyGraph(graph: ExecutionGraph): PlannerVerificationResult {
	const result: PlannerVerificationResult = {
		valid:            true,
		duplicatePaths:   [],
		unreachableNodes: [],
		cycles:           [],
		invalidPaths:     [],
		warnings:         [],
	};

	// ── Duplicate paths ────────────────────────────────────────────────────
	const seen = new Set<string>();
	for (const node of graph.nodes) {
		if (seen.has(node.path)) {
			result.duplicatePaths.push(node.path);
		} else {
			seen.add(node.path);
		}
	}

	// ── Invalid paths ──────────────────────────────────────────────────────
	const BAD_PATH_RE = /[<>:"|?*\\]|^\//;  // absolute or Windows-illegal chars
	const NEEDS_EXT   = /\.(?:ts|tsx|js|jsx|json)$/;
	for (const node of graph.nodes) {
		if (BAD_PATH_RE.test(node.path) || !NEEDS_EXT.test(node.path)) {
			result.invalidPaths.push(node.path);
		}
	}

	// ── Cycle detection (DFS) ──────────────────────────────────────────────
	const pathSet    = new Set(graph.nodes.map(n => n.path));
	const visited    = new Set<string>();
	const inStack    = new Set<string>();
	const stackTrace: string[] = [];

	const dfs = (nodePath: string): void => {
		if (inStack.has(nodePath)) {
			const start = stackTrace.indexOf(nodePath);
			if (start >= 0) result.cycles.push([...stackTrace.slice(start), nodePath]);
			return;
		}
		if (visited.has(nodePath)) return;
		visited.add(nodePath);
		inStack.add(nodePath);
		stackTrace.push(nodePath);

		const node = graph.nodes.find(n => n.path === nodePath);
		if (node) {
			for (const edge of node.dependencies) {
				if (pathSet.has(edge.path)) dfs(edge.path);
			}
		}

		stackTrace.pop();
		inStack.delete(nodePath);
	};

	for (const node of graph.nodes) {
		if (!visited.has(node.path)) dfs(node.path);
	}

	// ── Unreachable nodes (no dependents and not a server/entry node) ──────
	const TERMINAL_LAYERS = new Set<Layer>(['server', 'route']);
	for (const node of graph.nodes) {
		if (!TERMINAL_LAYERS.has(node.layer) && node.dependents.length === 0) {
			result.warnings.push(`Node "${node.path}" has no dependents — may be unreachable`);
		}
	}

	// ── Final validity ─────────────────────────────────────────────────────
	if (
		result.duplicatePaths.length > 0 ||
		result.cycles.length > 0 ||
		result.invalidPaths.length > 0
	) {
		result.valid = false;
	}

	console.log(
		`[Planner] Graph verification: valid=${result.valid} ` +
		`duplicates=${result.duplicatePaths.length} ` +
		`cycles=${result.cycles.length} ` +
		`invalid=${result.invalidPaths.length} ` +
		`warnings=${result.warnings.length}`,
	);

	return result;
}
