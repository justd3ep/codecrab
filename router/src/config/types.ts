export interface ServerConfig {
	port: number;
	host: string;
}

export interface ModelConfig {
	advisor: string;
	backend: string;
	frontend: string;
	embedding: string;
}

export interface GenerationConfig {
	maxTokensPerFile:    number;
	repeatPenalty:       number;
	repeatPenaltyTokens: number;
	temperature:         number;
	maxRepairAttempts:   number;
	maxProjectRepairs:   number;
	requestTimeoutMs:    number;
	maxAgentIterations:  number;
	contextSize?:        number;
}

export interface LoggingConfig {
	level:      'debug' | 'info' | 'warn' | 'error';
	structured: boolean;
}

export interface AppConfig {
	models: ModelConfig;
	workspace: {
		defaultRoot: string;
	};
	runtime: {
		root: string;
	};
	cacheDirectory: string;
	/**
	 * Which model file was actually resolved for each specialist, and
	 * whether the PREFERRED one was missing.
	 *
	 * A silent fallback meant the configured Q4 backend model was absent,
	 * the f16 build was used instead (~3x slower), and nothing in the logs
	 * or /health said so. This makes it visible.
	 */
	modelResolution?: {
		backend:  { path: string; usedFallback: boolean; preferredExists: boolean };
		frontend: { path: string; usedFallback: boolean; preferredExists: boolean };
	};
	server: ServerConfig;
	generation: GenerationConfig;
	logging: LoggingConfig;
}
