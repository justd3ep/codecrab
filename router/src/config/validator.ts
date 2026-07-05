import fs from 'fs';
import path from 'path';
import type { AppConfig } from './types.js';

class ConfigurationError extends Error {
	constructor(message: string) {
		super(`\n\n=== Configuration Error ===\n${message}\n===========================\n`);
		this.name = 'ConfigurationError';
	}
}

function checkReadable(filePath: string, name: string): void {
	if (!fs.existsSync(filePath)) {
		throw new ConfigurationError(`Missing ${name}\nPath: ${filePath}`);
	}
	try {
		fs.accessSync(filePath, fs.constants.R_OK);
	} catch (e) {
		throw new ConfigurationError(`Cannot read ${name} (Permission denied)\nPath: ${filePath}`);
	}
}

function ensureWritableDir(dirPath: string, name: string): void {
	if (!fs.existsSync(dirPath)) {
		try {
			fs.mkdirSync(dirPath, { recursive: true });
		} catch (e: any) {
			throw new ConfigurationError(`Failed to create ${name}\nPath: ${dirPath}\nError: ${e.message}`);
		}
	}
	try {
		fs.accessSync(dirPath, fs.constants.W_OK);
	} catch (e) {
		throw new ConfigurationError(`Cannot write to ${name} (Permission denied)\nPath: ${dirPath}`);
	}
}

export function validateConfig(config: AppConfig | undefined): asserts config is AppConfig {
	if (!config) {
		throw new ConfigurationError(
			`Missing config.local.ts\n\n` +
			`Please copy:\n` +
			`  src/config/config.example.ts\n` +
			`to:\n` +
			`  src/config/config.local.ts\n\n` +
			`and update the paths.`
		);
	}

	// 1. Validate Models (if they are explicitly set in the config, they must be valid)
	// If a user leaves them empty, it falls back to auto-discovery later in modelManager,
	// but if they provide a path, it MUST exist.
	if (config.models.advisor)   checkReadable(config.models.advisor,   'Advisor Model');
	if (config.models.backend)   checkReadable(config.models.backend,   'Backend Model');
	if (config.models.frontend)  checkReadable(config.models.frontend,  'Frontend Model');
	if (config.models.embedding) checkReadable(config.models.embedding, 'Embedding Model');

	// 2. Validate Runtime Directory
	if (!config.runtime?.root) throw new ConfigurationError('Missing runtime.root in configuration');
	ensureWritableDir(config.runtime.root, 'Runtime Directory');

	// 3. Validate Cache Directory
	if (!config.cacheDirectory) throw new ConfigurationError('Missing cacheDirectory in configuration');
	ensureWritableDir(config.cacheDirectory, 'Cache Directory');

	// 4. Validate Default Workspace
	if (!config.workspace?.defaultRoot) throw new ConfigurationError('Missing workspace.defaultRoot in configuration');
	ensureWritableDir(config.workspace.defaultRoot, 'Default Workspace');
}
