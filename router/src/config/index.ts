import type { AppConfig } from './types.js';
import { validateConfig } from './validator.js';

let config: AppConfig;

try {
	// Dynamically import to catch missing file gracefully
	// We use require or static import here. Given NodeNext, static import is cleaner
	// but might fail fast if the file is missing. Let's rely on standard imports
	// and if it fails, Node will crash, but we can't catch a missing static import.
	// Wait, we can catch it by checking if it exists before importing.
} catch (e) {
	// Ignored here
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localConfigPath = path.join(__dirname, 'config.local.ts');
const localConfigJsPath = path.join(__dirname, 'config.local.js');

if (!fs.existsSync(localConfigPath) && !fs.existsSync(localConfigJsPath)) {
	// We mock a call to validateConfig with undefined to trigger the formatted error
	validateConfig(undefined);
}

// Since it exists, we can safely import it (TypeScript will resolve it if built)
import localConfig from './config.local.js';

validateConfig(localConfig);

export default localConfig;
