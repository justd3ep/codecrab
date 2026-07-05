/**
 * Shared type definitions used across all subsystems.
 * No runtime dependencies — pure type declarations.
 */

// ---------------------------------------------------------------------------
// Job system
// ---------------------------------------------------------------------------

export type JobStatus =
	| 'pending'
	| 'planning'
	| 'running'
	| 'generating'
	| 'validating'
	| 'repairing'
	| 'completing'
	| 'completed'
	| 'failed'
	| 'cancelled';

export type NodeStatus =
	| 'pending'
	| 'ready'
	| 'generating'
	| 'validating'
	| 'repairing'
	| 'committed'
	| 'failed'
	| 'skipped';

export type ModelIntent = 'frontend' | 'backend' | 'general' | 'advisor';

export type ArchitectureType = 'repository' | 'mvc' | 'clean' | 'flat' | 'unknown';

export type ScopeType = 'backend' | 'frontend' | 'fullstack' | 'unknown';

export type LanguageType = 'typescript' | 'javascript';

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GeneratedFile {
	path:    string;
	content: string;
}

export interface TempFile extends GeneratedFile {
	/** Absolute path in temp workspace */
	absolutePath: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning';

export type IssueKind =
	| 'scope_violation'
	| 'missing_import'
	| 'missing_architecture'
	| 'missing_coverage'
	| 'layer_boundary'
	| 'business_logic_leak'
	| 'route_too_large'
	| 'undefined_symbol'
	| 'dead_code'
	| 'workspace_collision'
	| 'security'
	| 'typescript_quality'
	| 'compile_error'
	| 'completeness';

export interface ValidationIssue {
	kind:     IssueKind;
	file?:    string;   // optional — some issues are project-level
	message:  string;
	severity: IssueSeverity;
}

export interface ValidationResult {
	passed:        boolean;
	files:         GeneratedFile[];
	issues:        ValidationIssue[];
	coverageScore: number;
	coverageMax:   number;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type DependencyType = 'runtime' | 'type' | 'config';

export interface DependencyEdge {
	path: string;
	type: DependencyType;
}

export interface FileNode {
	path:         string;
	module:       string;
	layer:        string;
	status:       NodeStatus;
	dependencies: DependencyEdge[];
	dependents:   string[];
}

export interface ExecutionGraph {
	nodes:           FileNode[];
	generationOrder: string[][];  // stages (topo levels)
	architecture:    ArchitectureType;
	framework:       string;
	language:        LanguageType;
	modules:         string[];
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface AttemptRecord {
	node:             string;
	timestamp:        string;
	attempt:          number;
	promptHash:       string;
	inputTokens:      number;
	outputTokens:     number;
	durationMs:       number;
	validationResult: 'passed' | 'failed' | 'skipped';
	repairPerformed:  boolean;
	failureReason:    string | null;
}

export interface JobManifest {
	jobId:         string;
	status:        JobStatus;
	createdAt:     string;
	updatedAt:     string;
	completedAt:   string | null;
	workspaceRoot: string;
	userRequest:   string;

	model: {
		key:         string;
		path:        string;
		adapter:     string | null;
		contextSize: number;
		temperature: number;
		seed:        number | null;
	};

	plan: {
		architecture:  ArchitectureType;
		framework:     string;
		language:      LanguageType;
		expectedFiles: number;
		graph:         ExecutionGraph;
	};

	progress: {
		generated:   string[];
		validated:   string[];
		committed:   string[];
		failed:      string[];
		skipped:     string[];
		currentNode: string | null;
	};

	attempts: AttemptRecord[];

	resumePoint: {
		phase:             string;
		lastCommittedNode: string | null;
	};
}

// ---------------------------------------------------------------------------
// Events (notifications only — never drive execution)
// ---------------------------------------------------------------------------

export interface JobEvent {
	jobId:     string;
	timestamp: string;
	type:      string;
	data:      Record<string, unknown>;
}

export interface PipelineProgressEvent {
	type:     'progress' | 'success' | 'warning' | 'error' | 'info';
	stage:    'read' | 'plan' | 'generate' | 'write' | 'validate' | 'repair' | 'complete';
	message:  string;
	file?:    string;
	jobId?:   string;
}

// ---------------------------------------------------------------------------
// Validation contract (passed to validator)
// ---------------------------------------------------------------------------

export interface ValidationContract {
	scope:            ScopeType;
	architecture:     ArchitectureType;
	framework:        string;
	language:         LanguageType;
	requiredFeatures: string[];
	requiredFolders:  string[];
	expectedFiles:    string[];
	estimatedFiles:   number;
}
