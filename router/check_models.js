import { getLlama } from 'node-llama-cpp';
import config from './src/config/index.js';

async function runModelChecks() {
	console.log('=== Checking CodeCrab Models ===\n');
	console.log('1. Initializing Llama Engine...');
	const llama = await getLlama();
	console.log('✓ Llama engine initialized successfully\n');

	const modelsToCheck = [
		{ name: 'Advisor Model', path: config.models.advisor },
		{ name: 'Backend Model', path: config.models.backend },
		{ name: 'Frontend Model', path: config.models.frontend },
		{ name: 'Embedding Model', path: config.models.embedding },
	];

	for (const m of modelsToCheck) {
		console.log(`Checking [${m.name}] at:\n  ${m.path}`);
		const startTime = Date.now();
		try {
			const model = await llama.loadModel({ modelPath: m.path });
			const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
			console.log(`  ✓ Loaded in ${elapsed}s | Train Context: ${model.trainContextSize ?? 'N/A'}`);
			await model.dispose();
			console.log(`  ✓ Disposed successfully\n`);
		} catch (err) {
			console.error(`  ✗ Failed to load: ${err.message}\n`);
		}
	}

	console.log('=== All Model Checks Completed Successfully ===');
}

runModelChecks().catch(err => {
	console.error('Model check error:', err);
	process.exit(1);
});
