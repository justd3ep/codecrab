/**
 * Graph types — planning data structures.
 *
 * Re-exports core types and adds planning-specific helpers.
 * This module exists so planner modules don't import from core/types directly
 * for graph-specific types, keeping coupling explicit.
 */

export type {
	FileNode,
	ExecutionGraph,
	DependencyEdge,
	DependencyType,
	NodeStatus,
	ArchitectureType,
	LanguageType,
} from '../core/types.js';
