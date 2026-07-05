/**
 * ExecutionGraphBuilder — build FileNode DAG from advisor result.
 *
 * Pure function — no I/O, no LLM calls. Deterministic for identical inputs.
 * Extracted from planner.ts (lines 108-430) with original logic preserved.
 */

import type { WorkspaceInspection }                   from '../workspaceInspector.js';
import type { FileNode, ExecutionGraph, DependencyEdge } from '../core/types.js';

// ---------------------------------------------------------------------------
// AdvisorV2 result (matches the planner schema)
// ---------------------------------------------------------------------------

export interface AdvisorV2Result {
	intent:             string;
	projectType?:       string;
	architecture?:      'repository' | 'mvc' | 'clean' | 'flat' | 'unknown';
	framework?:         string;
	language?:          'typescript' | 'javascript';
	database?:          string;
	orm?:               string;
	authentication?:    string;
	requiredFeatures?:  string[];
	modules?:           string[];
	estimatedFiles?:    number;
	generationStrategy?: 'dependency_order' | 'flat';
	confidence?:        number;
}

// ---------------------------------------------------------------------------
// Layer types and ordering
// ---------------------------------------------------------------------------

type Layer =
	| 'config' | 'database' | 'model' | 'repository'
	| 'service' | 'controller' | 'route' | 'middleware'
	| 'server' | 'other';

const LAYER_STAGE: Record<Layer, number> = {
	config:     1,
	database:   2,
	model:      3,
	repository: 4,
	service:    5,
	controller: 6,
	route:      7,
	middleware: 7,
	server:     8,
	other:      9,
};

const LAYER_IMPORTS: Partial<Record<Layer, Layer[]>> = {
	repository: ['model', 'database', 'config'],
	service:    ['repository', 'model', 'config'],
	controller: ['service'],
	route:      ['controller', 'middleware'],
	server:     ['route', 'middleware', 'config', 'database'],
	middleware: ['service', 'config'],
};

// ---------------------------------------------------------------------------
// Architecture templates
// ---------------------------------------------------------------------------

type ArchKey = 'repository' | 'mvc' | 'clean' | 'flat' | 'unknown';

interface PathTemplate {
	layerDir: string;
	suffix:   string;
	include:  Layer[];
}

const ARCH_TEMPLATES: Record<ArchKey, Partial<Record<Layer, PathTemplate>>> = {
	repository: {
		config:     { layerDir: 'src/config',       suffix: '',              include: ['config'] },
		database:   { layerDir: 'src/config',       suffix: '.db',           include: ['database'] },
		model:      { layerDir: 'src/models',        suffix: '',              include: ['model'] },
		repository: { layerDir: 'src/repositories', suffix: '.repository',   include: ['repository'] },
		service:    { layerDir: 'src/services',      suffix: '.service',      include: ['service'] },
		controller: { layerDir: 'src/controllers',  suffix: '.controller',   include: ['controller'] },
		route:      { layerDir: 'src/routes',        suffix: '.routes',       include: ['route'] },
		middleware: { layerDir: 'src/middleware',    suffix: '',              include: ['middleware'] },
		server:     { layerDir: 'src',               suffix: '',              include: ['server'] },
	},
	mvc: {
		config:     { layerDir: 'src/config',        suffix: '',              include: ['config'] },
		model:      { layerDir: 'src/models',         suffix: '',              include: ['model'] },
		controller: { layerDir: 'src/controllers',   suffix: '.controller',   include: ['controller'] },
		route:      { layerDir: 'src/routes',         suffix: '.routes',       include: ['route'] },
		middleware: { layerDir: 'src/middleware',     suffix: '',              include: ['middleware'] },
		server:     { layerDir: 'src',                suffix: '',              include: ['server'] },
	},
	clean: {
		config:     { layerDir: 'src/config',          suffix: '',              include: ['config'] },
		model:      { layerDir: 'src/domain/entities', suffix: '',              include: ['model'] },
		repository: { layerDir: 'src/infrastructure', suffix: '.repository',   include: ['repository'] },
		service:    { layerDir: 'src/application',     suffix: '.service',      include: ['service'] },
		controller: { layerDir: 'src/interfaces',      suffix: '.controller',   include: ['controller'] },
		route:      { layerDir: 'src/interfaces',      suffix: '.routes',       include: ['route'] },
		server:     { layerDir: 'src',                 suffix: '',              include: ['server'] },
	},
	flat: {
		model:      { layerDir: 'src',                 suffix: '',              include: ['model'] },
		route:      { layerDir: 'src/routes',           suffix: '',              include: ['route'] },
		server:     { layerDir: 'src',                 suffix: '',              include: ['server'] },
	},
	unknown: {
		model:      { layerDir: 'src/models',           suffix: '',              include: ['model'] },
		service:    { layerDir: 'src/services',         suffix: '.service',      include: ['service'] },
		controller: { layerDir: 'src/controllers',      suffix: '.controller',   include: ['controller'] },
		route:      { layerDir: 'src/routes',           suffix: '.routes',       include: ['route'] },
		server:     { layerDir: 'src',                  suffix: '',              include: ['server'] },
	},
};

const SHARED_FILES: Record<ArchKey, Array<{ layer: Layer; path: string; module: string }>> = {
	repository: [
		{ layer: 'config',   path: 'src/config/index.ts',    module: 'config'   },
		{ layer: 'database', path: 'src/config/database.ts', module: 'database' },
		{ layer: 'server',   path: 'src/server.ts',          module: 'server'   },
		{ layer: 'server',   path: 'src/app.ts',             module: 'app'      },
	],
	mvc: [
		{ layer: 'config',   path: 'src/config/index.ts',    module: 'config'   },
		{ layer: 'server',   path: 'src/server.ts',          module: 'server'   },
		{ layer: 'server',   path: 'src/app.ts',             module: 'app'      },
	],
	clean: [
		{ layer: 'config',   path: 'src/config/index.ts',    module: 'config'   },
		{ layer: 'server',   path: 'src/server.ts',          module: 'server'   },
	],
	flat: [
		{ layer: 'server',   path: 'src/index.ts',           module: 'server'   },
	],
	unknown: [
		{ layer: 'server',   path: 'src/server.ts',          module: 'server'   },
		{ layer: 'server',   path: 'src/app.ts',             module: 'app'      },
	],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFilePath(moduleName: string, layer: Layer, arch: ArchKey, ext: string): string | null {
	const tmpl = ARCH_TEMPLATES[arch]?.[layer];
	if (!tmpl) return null;
	const suffix = tmpl.suffix || '';
	const fileName = suffix
		? `${moduleName}${suffix}.${ext}`
		: `${moduleName}.${ext}`;
	return `${tmpl.layerDir}/${fileName}`;
}

function getLayers(arch: ArchKey): Layer[] {
	const tmpl = ARCH_TEMPLATES[arch];
	if (!tmpl) return ['model', 'service', 'controller', 'route', 'server'];
	return Object.keys(tmpl) as Layer[];
}

function inferModulesFromIntent(advisor: AdvisorV2Result): string[] {
	const intent = advisor.intent ?? '';
	if (intent.includes('auth')) return ['auth', 'users'];
	if (advisor.requiredFeatures?.includes('jwt')) return ['auth', 'users'];
	return ['users'];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildExecutionGraph(
	advisor:    AdvisorV2Result,
	inspection: WorkspaceInspection | null,
): ExecutionGraph | null {
	try {
		return _buildGraph(advisor, inspection);
	} catch (e: any) {
		console.error(`[GraphBuilder] buildExecutionGraph failed: ${e.message}`);
		return null;
	}
}

function _buildGraph(
	advisor:    AdvisorV2Result,
	inspection: WorkspaceInspection | null,
): ExecutionGraph {
	const arch     = (advisor.architecture ?? 'unknown') as ArchKey;
	const modules  = (advisor.modules && advisor.modules.length > 0)
		? advisor.modules
		: inferModulesFromIntent(advisor);
	const language = advisor.language ?? 'typescript';
	const ext      = language === 'typescript' ? 'ts' : 'js';

	// ── 1. Collect FileNodes ────────────────────────────────────────────────
	const nodeMap = new Map<string, FileNode>();

	// Shared files
	const shared = SHARED_FILES[arch] ?? SHARED_FILES.unknown;
	for (const s of shared) {
		nodeMap.set(s.path, {
			path:         s.path,
			module:       s.module,
			layer:        s.layer,
			status:       'pending',
			dependencies: [] as DependencyEdge[],
			dependents:   [],
		});
	}

	// Module-specific files
	const layers = getLayers(arch);
	for (const mod of modules) {
		for (const layer of layers) {
			if (layer === 'server' || layer === 'config' || layer === 'database') continue;
			const filePath = buildFilePath(mod.toLowerCase(), layer, arch, ext);
			if (!filePath || nodeMap.has(filePath)) continue;
			nodeMap.set(filePath, {
				path:         filePath,
				module:       mod.toLowerCase(),
				layer,
				status:       'pending',
				dependencies: [] as DependencyEdge[],
				dependents:   [],
			});
		}
	}

	if (nodeMap.size === 0) {
		throw new Error('No file nodes generated — modules list may be empty');
	}

	// ── 2. Wire dependency edges ────────────────────────────────────────────
	const nodes = Array.from(nodeMap.values());
	for (const node of nodes) {
		const importedLayers = LAYER_IMPORTS[node.layer as Layer] ?? [];
		// Same module dependencies
		for (const dep of nodes) {
			if (dep.path === node.path) continue;
			if (importedLayers.includes(dep.layer as Layer) && dep.module === node.module) {
				const edgeType: DependencyEdge['type'] =
					dep.layer === 'config' ? 'config'
					: dep.layer === 'model' ? 'type'
					: 'runtime';
				if (!node.dependencies.some(d => d.path === dep.path)) {
					node.dependencies.push({ path: dep.path, type: edgeType });
				}
				if (!dep.dependents.includes(node.path)) dep.dependents.push(node.path);
			}
		}

		// Shared file dependencies
		for (const s of shared) {
			if (s.path === node.path) continue;
			if (importedLayers.includes(s.layer as Layer) && !node.dependencies.some(d => d.path === s.path)) {
				const edgeType: DependencyEdge['type'] = s.layer === 'config' ? 'config' : 'runtime';
				node.dependencies.push({ path: s.path, type: edgeType });
				const sNode = nodeMap.get(s.path);
				if (sNode && !sNode.dependents.includes(node.path)) {
					sNode.dependents.push(node.path);
				}
			}
		}
	}

	// ── 3. Mark already-committed nodes ─────────────────────────────────────
	if (inspection) {
		for (const node of nodes) {
			const existing = inspection.existingModules.get(node.module);
			if (existing?.some(e => e.layer === node.layer)) {
				node.status = 'committed';
			}
		}
	}

	// ── 4. Topological sort by stage ────────────────────────────────────────
	nodes.sort((a, b) => {
		const stageA = LAYER_STAGE[a.layer as Layer] ?? 9;
		const stageB = LAYER_STAGE[b.layer as Layer] ?? 9;
		if (stageA !== stageB) return stageA - stageB;
		return a.module.localeCompare(b.module);
	});

	// ── 5. Group by stage ───────────────────────────────────────────────────
	const stageMap = new Map<number, string[]>();
	for (const node of nodes) {
		const stage = LAYER_STAGE[node.layer as Layer] ?? 9;
		if (!stageMap.has(stage)) stageMap.set(stage, []);
		stageMap.get(stage)!.push(node.path);
	}
	const generationOrder = Array.from(stageMap.entries())
		.sort(([a], [b]) => a - b)
		.map(([, paths]) => paths);

	return {
		nodes,
		generationOrder,
		architecture: advisor.architecture ?? 'unknown',
		framework:    advisor.framework ?? 'unknown',
		language,
		modules,
	};
}
