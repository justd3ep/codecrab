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
	server: ServerConfig;
	generation: GenerationConfig;
	logging: LoggingConfig;
}
