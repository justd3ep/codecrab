import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const provider = new StatsViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(StatsViewProvider.viewType, provider)
	);
}

class StatsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'codecrab-stats-view';

	constructor(
		private readonly _extensionUri: vscode.Uri,
	) { }

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		webviewView.webview.options = {
			enableScripts: true,
		};

		webviewView.webview.html = this._getHtmlForWebview();
	}

	private _getHtmlForWebview() {
		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>CodeCrab Stats</title>
				<style>
					body {
						font-family: var(--vscode-font-family);
						color: var(--vscode-editor-foreground);
						padding: 10px;
						margin: 0;
					}
					h2 {
						font-size: 14px;
						text-transform: uppercase;
						letter-spacing: 1px;
						margin-bottom: 20px;
						color: #FF653F;
					}
					.stat-block {
						margin-bottom: 15px;
					}
					.stat-header {
						display: flex;
						justify-content: space-between;
						font-size: 12px;
						margin-bottom: 5px;
						font-weight: bold;
					}
					.progress-bg {
						background: #111111;
						border-radius: 4px;
						height: 12px;
						width: 100%;
						overflow: hidden;
						border: 1px solid #333;
					}
					.progress-fill {
						background: #FF653F;
						height: 100%;
						width: 0%;
						transition: width 0.3s ease;
					}
					.subtext {
						font-size: 10px;
						color: #888;
						margin-top: 3px;
						text-align: right;
					}
				</style>
			</head>
			<body>
				<h2>Task Manager</h2>

				<div class="stat-block">
					<div class="stat-header">
						<span>CPU</span>
						<span id="cpu-percent">0%</span>
					</div>
					<div class="progress-bg">
						<div class="progress-fill" id="cpu-bar"></div>
					</div>
				</div>

				<div class="stat-block">
					<div class="stat-header">
						<span>RAM</span>
						<span id="ram-percent">0%</span>
					</div>
					<div class="progress-bg">
						<div class="progress-fill" id="ram-bar"></div>
					</div>
					<div class="subtext" id="ram-text">0.0 GB / 0.0 GB</div>
				</div>

				<div class="stat-block" id="vram-block" style="display: none;">
					<div class="stat-header">
						<span>VRAM</span>
						<span id="vram-percent">0%</span>
					</div>
					<div class="progress-bg">
						<div class="progress-fill" id="vram-bar"></div>
					</div>
					<div class="subtext" id="vram-text">0.0 GB / 0.0 GB</div>
				</div>

				<div class="stat-block">
					<div class="stat-header">
						<span>Storage</span>
						<span id="storage-percent">0%</span>
					</div>
					<div class="progress-bg">
						<div class="progress-fill" id="storage-bar"></div>
					</div>
					<div class="subtext" id="storage-text">0.0 GB / 0.0 GB</div>
				</div>

				<script>
					async function fetchStats() {
						try {
							const response = await fetch('http://localhost:3141/stats');
							if (!response.ok) return;
							const data = await response.json();
							
							document.getElementById('cpu-percent').innerText = data.cpu.percent + '%';
							document.getElementById('cpu-bar').style.width = data.cpu.percent + '%';
							
							document.getElementById('ram-percent').innerText = data.ram.percent + '%';
							document.getElementById('ram-bar').style.width = data.ram.percent + '%';
							document.getElementById('ram-text').innerText = data.ram.usedGb + ' GB / ' + data.ram.totalGb + ' GB';
							
							if (data.gpu.hasGpu) {
								document.getElementById('vram-block').style.display = 'block';
								document.getElementById('vram-percent').innerText = data.gpu.percent + '%';
								document.getElementById('vram-bar').style.width = data.gpu.percent + '%';
								document.getElementById('vram-text').innerText = data.gpu.usedGb + ' GB / ' + data.gpu.totalGb + ' GB';
							} else {
								document.getElementById('vram-block').style.display = 'none';
							}
							
							document.getElementById('storage-percent').innerText = data.storage.percent + '%';
							document.getElementById('storage-bar').style.width = data.storage.percent + '%';
							document.getElementById('storage-text').innerText = data.storage.usedGb + ' GB / ' + data.storage.totalGb + ' GB';
						} catch (e) {
							// Router might be offline
						}
					}

					// Poll every second
					setInterval(fetchStats, 1000);
					fetchStats();
				</script>
			</body>
			</html>`;
	}
}
