/**
 * WorkspaceInspector
 * ==================
 * Scans the workspace BEFORE planning begins.
 * Detects existing modules, layers, and conflicts.
 * Informs the ExecutionGraph builder so it can prefer MODIFY over GENERATE.
 *
 * No LLM calls. Pure synchronous filesystem scan.
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExistingModule {
	name: string;         // e.g. "auth", "users"
	layer: string;        // e.g. "service", "controller", "repository"
	relPath: string;      // relative to workspaceRoot
}

export interface WorkspaceInspection {
	existingModules: Map<string, ExistingModule[]>; // moduleName → implementations
	existingControllers: string[];
	existingRepositories: string[];
	existingServices: string[];
	existingRoutes: string[];
	existingModels: string[];
	missingFiles: string[];                         // from advisorResult.modules vs actual
	duplicateImplementations: string[];             // same module in same layer twice
	dependencyConflicts: string[];                  // e.g. imports that cross layer boundaries
	backendFileCount: number;
	frontendFileCount: number;
	hasTypeConfig: boolean;                         // tsconfig.json exists
	hasPackageJson: boolean;
	recommendedStrategy: 'CREATE' | 'MODIFY' | 'MIXED';
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
	'node_modules', 'dist', 'build', 'out',
	'.git', '.next', '.cache', '__pycache__', '.svelte-kit',
]);

const LAYER_SUFFIX_RE =
	/\.(service|controller|repository|router|routes?|middleware|guard|module|dto|entity|model|schema)\.[tj]sx?$/i;

const LAYER_DIR_RE =
	/\/(services?|controllers?|repositor(?:y|ies)?|routes?|middleware|models?|dto|guards?)\//i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyLayer(relPath: string): string {
	const p = relPath.toLowerCase();
	if (/\/(routes?|router)\/|\.routes?\.|\.router\./i.test(p)) return 'route';
	if (/\/controllers?\/|\.controller\./i.test(p))             return 'controller';
	if (/\/services?\/|\.service\./i.test(p))                   return 'service';
	if (/\/repositor|\.repository\.|\.repo\./i.test(p))         return 'repository';
	if (/\/models?\/|\.model\.|\.entity\.|\.schema\./i.test(p)) return 'model';
	if (/\/middleware\/|\.middleware\./i.test(p))                return 'middleware';
	if (/\/dto\/|\.dto\./i.test(p))                             return 'dto';
	if (/\/(guards?|interceptors?)\/|\.guard\./i.test(p))       return 'guard';
	return 'other';
}

function extractModuleName(relPath: string): string | null {
	const base = path.basename(relPath, path.extname(relPath))
		.replace(/\.(service|controller|repository|router|route|routes|middleware|guard|module|dto|entity|model|schema)$/i, '')
		.toLowerCase()
		.trim();
	return base.length > 1 ? base : null;
}

function isBackendFile(relPath: string): boolean {
	return /\b(?:server|app|routes?|controller|service|repository|middleware|prisma|typeorm|mongoose|schema\.prisma)\b/i.test(relPath);
}

function isFrontendFile(relPath: string): boolean {
	return /\.(tsx|jsx)$/.test(relPath) || /\b(?:pages?|components?|hooks?|stores?|layouts?|public)\b/i.test(relPath);
}

// ---------------------------------------------------------------------------
// Filesystem scanner
// ---------------------------------------------------------------------------

function scanDirectory(
	dir: string,
	workspaceRoot: string,
	results: string[],
	depth = 0,
): void {
	if (depth > 6) return;
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			if (SKIP_DIRS.has(e.name)) continue;
			if (e.isDirectory()) {
				scanDirectory(path.join(dir, e.name), workspaceRoot, results, depth + 1);
			} else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) {
				results.push(path.relative(workspaceRoot, path.join(dir, e.name)));
			}
		}
	} catch { /* unreadable — skip */ }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Inspect the workspace synchronously before planning.
 *
 * @param workspaceRoot  Absolute path to workspace.
 * @param plannedModules Module names the advisor intends to generate (e.g. ["auth","users"]).
 *                       Pass [] if advisor did not provide them — inspection still runs.
 */
export function inspectWorkspace(
	workspaceRoot: string,
	plannedModules: string[] = [],
): WorkspaceInspection {
	const result: WorkspaceInspection = {
		existingModules:          new Map(),
		existingControllers:      [],
		existingRepositories:     [],
		existingServices:         [],
		existingRoutes:           [],
		existingModels:           [],
		missingFiles:             [],
		duplicateImplementations: [],
		dependencyConflicts:      [],
		backendFileCount:         0,
		frontendFileCount:        0,
		hasTypeConfig:            false,
		hasPackageJson:           false,
		recommendedStrategy:      'CREATE',
	};

	// ── Existence checks ───────────────────────────────────────────────────
	result.hasTypeConfig  = fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'));
	result.hasPackageJson = fs.existsSync(path.join(workspaceRoot, 'package.json'));

	// ── File scan ──────────────────────────────────────────────────────────
	const allFiles: string[] = [];
	scanDirectory(workspaceRoot, workspaceRoot, allFiles);

	for (const rel of allFiles) {
		const layer  = classifyLayer(rel);
		const modName = extractModuleName(rel);

		if (isBackendFile(rel))  result.backendFileCount++;
		if (isFrontendFile(rel)) result.frontendFileCount++;

		// Layer buckets
		if (layer === 'controller') result.existingControllers.push(rel);
		if (layer === 'repository') result.existingRepositories.push(rel);
		if (layer === 'service')    result.existingServices.push(rel);
		if (layer === 'route')      result.existingRoutes.push(rel);
		if (layer === 'model')      result.existingModels.push(rel);

		// Module map
		if (modName && layer !== 'other') {
			if (!result.existingModules.has(modName)) {
				result.existingModules.set(modName, []);
			}
			result.existingModules.get(modName)!.push({ name: modName, layer, relPath: rel });
		}
	}

	// ── Duplicate detection ────────────────────────────────────────────────
	for (const [modName, impls] of result.existingModules) {
		// Group by layer — duplicates = same module name + same layer twice
		const byLayer = new Map<string, string[]>();
		for (const impl of impls) {
			if (!byLayer.has(impl.layer)) byLayer.set(impl.layer, []);
			byLayer.get(impl.layer)!.push(impl.relPath);
		}
		for (const [layer, paths] of byLayer) {
			if (paths.length > 1) {
				const desc = `Duplicate ${layer} for module "${modName}": ${paths.join(', ')}`;
				result.duplicateImplementations.push(desc);
				console.log(`[WorkspaceInspector] WARN: ${desc}`);
			}
		}
	}

	// ── Missing files (from planned modules) ──────────────────────────────
	for (const mod of plannedModules) {
		const lower = mod.toLowerCase();
		if (!result.existingModules.has(lower)) {
			result.missingFiles.push(mod);
		}
	}

	// ── Strategy recommendation ────────────────────────────────────────────
	const totalExisting = result.existingModules.size;
	const totalPlanned  = plannedModules.length;
	if (totalExisting === 0) {
		result.recommendedStrategy = 'CREATE';
	} else if (totalPlanned > 0 && result.missingFiles.length < totalPlanned * 0.3) {
		// >70% of planned modules already exist → mostly modifying
		result.recommendedStrategy = 'MODIFY';
	} else {
		result.recommendedStrategy = 'MIXED';
	}

	console.log(
		`[WorkspaceInspector] BE=${result.backendFileCount} FE=${result.frontendFileCount}` +
		` modules=${result.existingModules.size} strategy=${result.recommendedStrategy}` +
		` missing=[${result.missingFiles.join(',')}]`,
	);

	return result;
}

/**
 * Returns true if the workspace already contains meaningful source files
 * for the given specialist domain.
 */
export function workspaceHasFiles(
	inspection: WorkspaceInspection,
	domain: 'backend' | 'frontend' | 'any',
): boolean {
	if (domain === 'backend')  return inspection.backendFileCount  > 0;
	if (domain === 'frontend') return inspection.frontendFileCount > 0;
	return inspection.backendFileCount + inspection.frontendFileCount > 0;
}
