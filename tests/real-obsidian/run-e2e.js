'use strict';

// 插件加速商店 — 真机 E2E。
// 真 Obsidian（Xvfb）装本插件 + qa-bridge，开商店（拉线上 relay-1 清单）截图，
// 再 eval installById('dataview') 走真实 relay-1 /gh 下载链路安装 dataview，截图。
//
//   node tests/real-obsidian/run-e2e.js [--display=110] [--out=<dir>]
//
// 产出 shot-*.png 到 out 目录；推企微由 push-shots.py 单独做。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const launcher = require('/home/work/gate/obsidian-plug/tests/real-obsidian/lib/obsidian-launcher.js');

const REPO = path.resolve(__dirname, '..', '..');
const BRIDGE_DIR = path.join(__dirname, 'bridge-plugin');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
	const a = {};
	for (const s of argv.slice(2)) {
		const m = s.match(/^--([^=]+)=(.*)$/);
		if (m) a[m[1]] = m[2];
		else if (s.startsWith('--')) a[s.slice(2)] = true;
	}
	return a;
}

function requireTools() {
	for (const t of ['Xvfb', 'ffmpeg', 'xdotool']) {
		try { execSync(`command -v ${t}`, { stdio: 'ignore' }); }
		catch { throw new Error(`缺少工具 ${t}（真机 E2E 需要）`); }
	}
}

function screenshot(display, outPath, w = 1400, h = 900) {
	execSync(
		`ffmpeg -y -f x11grab -video_size ${w}x${h} -i :${display}.0 -vframes 1 "${outPath}" 2>/dev/null`,
		{ stdio: 'ignore' },
	);
}

function buildVault(vaultDir) {
	const dot = path.join(vaultDir, '.obsidian');
	fs.mkdirSync(path.join(dot, 'plugins', 'plugin-market-cn'), { recursive: true });
	fs.mkdirSync(path.join(dot, 'plugins', 'qa-bridge'), { recursive: true });

	for (const f of ['main.js', 'manifest.json', 'styles.css']) {
		const src = path.join(REPO, f);
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dot, 'plugins', 'plugin-market-cn', f));
	}
	for (const f of ['main.js', 'manifest.json']) {
		fs.copyFileSync(path.join(BRIDGE_DIR, f), path.join(dot, 'plugins', 'qa-bridge', f));
	}
	fs.writeFileSync(path.join(dot, 'community-plugins.json'), JSON.stringify(['plugin-market-cn', 'qa-bridge']));
	fs.writeFileSync(path.join(dot, 'core-plugins.json'), JSON.stringify([]));
	fs.writeFileSync(path.join(dot, 'app.json'), JSON.stringify({ legacyEditor: false }));
	fs.writeFileSync(path.join(vaultDir, 'Welcome.md'), '# 插件加速商店 E2E\n');
}

async function trigger(vaultDir, req, timeoutMs = 90000) {
	const trg = path.join(vaultDir, 'qa-trigger.json');
	const rsl = path.join(vaultDir, 'qa-result.json');
	const id = 'r' + Date.now();
	try { fs.unlinkSync(rsl); } catch {}
	fs.writeFileSync(trg, JSON.stringify({ id, ...req }));
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = JSON.parse(fs.readFileSync(rsl, 'utf8'));
			if (r.id === id) return r;
		} catch {}
		await sleep(300);
	}
	throw new Error('trigger timeout: ' + JSON.stringify(req).slice(0, 80));
}

async function waitReady(vaultDir, timeoutMs = 70000) {
	const ready = path.join(vaultDir, 'qa-bridge-ready.json');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(ready)) return JSON.parse(fs.readFileSync(ready, 'utf8'));
		await sleep(300);
	}
	throw new Error('qa-bridge ready 超时');
}

async function main() {
	const args = parseArgs(process.argv);
	const display = parseInt(args.display || '110', 10);
	const outDir = args.out || path.join('/tmp', 'pmcn-e2e-' + Date.now());
	const W = 1400, H = 900;

	requireTools();
	if (!fs.existsSync(path.join(REPO, 'main.js'))) {
		throw new Error('main.js 不存在，请先 npm run build');
	}
	fs.mkdirSync(outDir, { recursive: true });
	const vaultDir = path.join(outDir, 'vault');
	const userDataDir = path.join(outDir, 'obsidian-userdata');
	buildVault(vaultDir);
	console.log('[e2e] vault =', vaultDir);
	console.log('[e2e] out   =', outDir);

	const handle = await launcher.launch({
		vaultPath: vaultDir,
		userDataDir,
		display,
		viewport: { w: W, h: H },
		logPath: path.join(outDir, 'obsidian.log'),
		launchTimeoutMs: 45000,
	});
	console.log('[e2e] obsidian up; winId =', handle.winId);

	try {
		await sleep(5000);
		screenshot(display, path.join(outDir, 'shot-00-boot.png'), W, H);
		console.log('[e2e] shot-00-boot.png (诊断)');
		// 这个 Obsidian 版本忽略 obsidian.json 的 trusted 标记，仍弹「信任作者」框 →
		// 点「Trust author and enable plugins」（屏幕 1400x900，按钮中心约 624,568）启用插件。
		try {
			execSync(`DISPLAY=:${display} xdotool mousemove 624 568 click 1`, { stdio: 'ignore' });
			console.log('[e2e] 已点信任作者按钮');
			await sleep(2000);
		} catch (e) { console.log('[e2e] 点信任按钮失败（可能无弹框）:', e.message); }
		let ready;
		try {
			ready = await waitReady(vaultDir, 110000);
		} catch (e) {
			screenshot(display, path.join(outDir, 'shot-fail.png'), W, H);
			console.log('[e2e] shot-fail.png (ready 超时时的屏幕)');
			throw e;
		}
		console.log('[e2e] bridge ready; loaded =', ready.loadedPlugins);
		if (ready.timedOut) throw new Error('插件/命令未注册: ' + JSON.stringify(ready));

		// 1) 打开商店（拉线上 relay-1 清单）
		await trigger(vaultDir, { command: 'plugin-market-cn:open-plugin-market' });
		console.log('[e2e] store opened; 等待清单加载（线上 relay-1）...');
		await sleep(14000); // community-plugins.json ~5-14s + 渲染
		screenshot(display, path.join(outDir, 'shot-01-store.png'), W, H);
		console.log('[e2e] shot-01-store.png');

		// 2) 过滤到 dataview（显示「安装」按钮）
		const locRes = await trigger(vaultDir, {
			action: 'eval',
			code: `
				const v = app.workspace.getLeavesOfType('plugin-market-cn-view')[0]?.view;
				if (v) v.locate('dataview');
				return { located: !!v, total: v ? v.entries?.length : 0 };
			`,
		});
		console.log('[e2e] locate dataview ->', JSON.stringify(locRes.evalResult));
		await sleep(2500);
		screenshot(display, path.join(outDir, 'shot-02-dataview-card.png'), W, H);
		console.log('[e2e] shot-02-dataview-card.png');

		// 3) 真实安装 dataview（走线上 relay-1 /gh 下载链路）
		const insRes = await trigger(vaultDir, {
			action: 'eval',
			timeoutMs: 90000,
			code: `
				const p = app.plugins.plugins['plugin-market-cn'];
				if (!p) return { error: 'plugin-market-cn 未加载' };
				await p.installById('dataview');
				const v = app.workspace.getLeavesOfType('plugin-market-cn-view')[0]?.view;
				if (v) v.locate('dataview');
				return {
					dataviewInstalled: !!app.plugins.manifests['dataview'],
					dataviewEnabled: app.plugins.enabledPlugins.has('dataview'),
					version: app.plugins.manifests['dataview']?.version,
				};
			`,
		}, 95000);
		console.log('[e2e] install dataview ->', JSON.stringify(insRes.evalResult));
		await sleep(3500);
		screenshot(display, path.join(outDir, 'shot-03-installed.png'), W, H);
		console.log('[e2e] shot-03-installed.png');

		// 结果落盘，给 push 脚本用
		fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
			ready: ready.loadedPlugins,
			locate: locRes.evalResult,
			install: insRes.evalResult,
		}, null, 2));

		console.log('[e2e] DONE. shots in', outDir);
		console.log('OUTDIR=' + outDir);
	} finally {
		await handle.cleanup();
	}
}

main().catch(e => { console.error('[e2e] fatal:', e.stack || e); process.exit(1); });
