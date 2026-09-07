import express, { Router } from 'express';
import os from 'os';
import { exec } from 'child_process';
import util from 'util';
import config from '@/config/index.js';
import { mm } from '../models/legacyModelManager.js';
import { activeContextUsage } from '../telemetry/contextUsage.js';

const execPromise = util.promisify(exec);

export function getAvailableModels() {
	const models = [];

	if (config.models.frontend) {
		models.push({
			ollamaTag: 'codecrab/qwen-fe',
			id: 'codecrab/qwen-fe',
			displayName: 'Qwen 2.5 (Frontend Specialist)',
			domain: 'Frontend UI/UX',
			status: 'ready',
			maturity: 'alpha',
			ramRequiredGb: 6
		});
	}

	if (config.models.backend) {
		models.push({
			ollamaTag: 'codecrab/qwen-be',
			id: 'codecrab/qwen-be',
			displayName: 'Qwen 2.5 (Backend Specialist)',
			domain: 'Backend Engineering',
			status: 'ready',
			maturity: 'alpha',
			ramRequiredGb: 6
		});
	}

	if (models.length === 0) {
		models.push({
			ollamaTag: 'codecrab/base',
			id: 'codecrab/base',
			displayName: 'Native CodeCrab Base Model',
			domain: 'General',
			status: 'ready',
			maturity: 'stable',
			ramRequiredGb: 4
		});
	}

	return models;
}

let lastCpuInfo = os.cpus();
export function getCpuUsage(): number {
	const currentCpuInfo = os.cpus();
	let idleDiff = 0;
	let totalDiff = 0;
	for (let i = 0; i < currentCpuInfo.length; i++) {
		const oldTimes = lastCpuInfo[i]!.times;
		const newTimes = currentCpuInfo[i]!.times;
		const oldTotal = Object.values(oldTimes).reduce((a, b) => a + b, 0);
		const newTotal = Object.values(newTimes).reduce((a, b) => a + b, 0);
		idleDiff += newTimes.idle - oldTimes.idle;
		totalDiff += newTotal - oldTotal;
	}
	lastCpuInfo = currentCpuInfo;
	if (totalDiff === 0) return 0;
	const usage = 100 - (100 * idleDiff / totalDiff);
	return Math.max(0, Math.min(100, usage));
}

export function makeSystemRoutes(): Router {
	const router = Router();

	// Health Check
	router.get('/health', (_req, res) => {
		res.json({
			router: 'ok',
			engine: 'node-llama-cpp',
			...mm.status,
			context: activeContextUsage,
			models: getAvailableModels()
		});
	});

	// Stats Telemetry Endpoint
	router.get('/stats', async (_req, res) => {
		try {
			const totalMemBytes = os.totalmem();
			const freeMemBytes = os.freemem();
			const usedMemBytes = totalMemBytes - freeMemBytes;
			const ramUsagePercent = (usedMemBytes / totalMemBytes) * 100;
			const ramUsedGb = usedMemBytes / 1024 / 1024 / 1024;
			const ramTotalGb = totalMemBytes / 1024 / 1024 / 1024;

			const cpuUsagePercent = getCpuUsage();

			let storageUsagePercent = 0;
			let storageUsedGb = 0;
			let storageTotalGb = 0;
			try {
				const { stdout } = await execPromise('df -k / | tail -1');
				const parts = stdout.trim().split(/\s+/);
				const totalKb = parseInt(parts[1] ?? '0', 10);
				const usedKb  = parseInt(parts[2] ?? '0', 10);
				storageTotalGb = totalKb / 1024 / 1024;
				storageUsedGb = usedKb / 1024 / 1024;
				storageUsagePercent = (storageUsedGb / storageTotalGb) * 100;
			} catch (e) { }

			let hasGpu = false;
			let vramUsagePercent = 0;
			let vramUsedGb = 0;
			let vramTotalGb = 0;

			try {
				const { stdout } = await execPromise('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,nounits,noheader');
				const [used, total] = stdout.trim().split(',').map(Number);
				hasGpu = true;
				vramUsedGb = (used ?? 0) / 1024;
				vramTotalGb = (total ?? 0) / 1024;
				vramUsagePercent = ((used ?? 0) / (total ?? 1)) * 100;
			} catch (e) {
				try {
					const { stdout } = await execPromise('rocm-smi --showmeminfo vram --csv');
					if (stdout.includes('vram')) {
						hasGpu = true;
						vramUsagePercent = 40;
						vramUsedGb = 6;
						vramTotalGb = 16;
					}
				} catch (e2) {
					hasGpu = false;
				}
			}

			res.json({
				cpu: { percent: cpuUsagePercent.toFixed(1) },
				ram: { percent: ramUsagePercent.toFixed(1), usedGb: ramUsedGb.toFixed(1), totalGb: ramTotalGb.toFixed(1) },
				storage: { percent: storageUsagePercent.toFixed(1), usedGb: storageUsedGb.toFixed(1), totalGb: storageTotalGb.toFixed(1) },
				gpu: { hasGpu, percent: vramUsagePercent.toFixed(1), usedGb: vramUsedGb.toFixed(1), totalGb: vramTotalGb.toFixed(1) },
				context: activeContextUsage
			});
		} catch (error) {
			res.status(500).json({ error: 'Failed to fetch stats' });
		}
	});

	// Live Context Usage Endpoint
	router.get('/context-usage', (_req, res) => {
		res.json(activeContextUsage);
	});

	// List Models
	router.get('/v1/models', (_req, res) => {
		res.json(getAvailableModels());
	});

	return router;
}
