import type { AppConfig } from './types.js';

const config: AppConfig = {
	models: {
		advisor:   '/path/to/models/qwen-advisor.gguf',
		backend:   '/path/to/models/qwen-backend.gguf',
		frontend:  '/path/to/models/qwen-frontend.gguf',
		embedding: '/path/to/models/embedding.gguf',
	},
	workspace: {
		defaultRoot: '/path/to/default/workspace',
	},
	runtime: {
		root: '/tmp/crabcode',
	},
	cacheDirectory: './cache',
	server: {
		host: '0.0.0.0',
		port: 3141,
	},
	generation: {
		maxTokensPerFile:    4096,
		repeatPenalty:       1.15,
		repeatPenaltyTokens: 64,
		temperature:         0.7,
		maxRepairAttempts:   3,
		maxProjectRepairs:   5,
		requestTimeoutMs:    3600000,
		maxAgentIterations:  6,
	},
	logging: {
		level: 'info',
		structured: true,
	},
};

export default config;
