'use strict';

// 插件加速商店 — 调起链接（obsidian:// 协议）真机 E2E。
//
// 用「OS 真实行为」触发：Obsidian 已运行时，再启动一个 obsidian 进程并把
// obsidian://... 作为 argv 传入；单实例机制把 URI 转发给运行中的实例 → 触发协议 handler。
// 这等价于浏览器里点 obsidian:// 链接（OS 用该 URI 启动 obsidian）。
//
// 覆盖三场景（各截一张）：
//   1. 白名单拒绝：op=special-import manifest=evil.com  → Notice「被拒绝」
//   2. 白名单放行：op=special-import manifest=产品自有域 → 弹「导入第三方插件」确认框
//   3. install：   op=install id=dataview              → 弹「安装插件」确认框 → 点确认 → 真实安装
//
//   node tests/real-obsidian/run-e2e-deeplink.js [--display=112] [--out=<dir>]

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const launcher = require('/home/work/gate/obsidian-plug/tests/real-obsidian/lib/obsidian-launcher.js');
const OBSIDIAN_BIN = process.env.OBSIDIAN_BIN || '/home/work/sdk/Obsidian/squashfs-root/obsidian';

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
		catch { throw new Error(`缺少工具 ${t}`); }
	}
}

function screenshot(display, outPath, w = 1400, h = 900) {
	execSync(`ffmpeg -y -f x11grab -video_size ${w}x${h} -i :${display}.0 -vframes 1 "${outPath}" 2>/dev/null`, { stdio: 'ignore' });
}

function buildVault(vaultDir) {
	const dot = path.join(vaultDir, '.obsidian');
	fs.mkdirSync(path.join(dot, 'plugins', 'china-speedup'), { recursive: true });
	fs.mkdirSync(path.join(dot, 'plugins', 'qa-bridge'), { recursive: true });
	for (const f of ['main.js', 'manifest.json', 'styles.css']) {
		const src = path.join(REPO, f);
		if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dot, 'plugins', 'china-speedup', f));
	}
	for (const f of ['main.js', 'manifest.json']) {
		fs.copyFileSync(path.join(BRIDGE_DIR, f), path.join(dot, 'plugins', 'qa-bridge', f));
	}
	fs.writeFileSync(path.join(dot, 'community-plugins.json'), JSON.stringify(['china-speedup', 'qa-bridge']));
	fs.writeFileSync(path.join(dot, 'core-plugins.json'), JSON.stringify([]));
	fs.writeFileSync(path.join(dot, 'app.json'), JSON.stringify({ legacyEditor: false }));
	fs.writeFileSync(path.join(vaultDir, 'Welcome.md'), '# 调起链接 E2E\n');
}

async function trigger(vaultDir, req, timeoutMs = 60000) {
	const trg = path.join(vaultDir, 'qa-trigger.json');
	const rsl = path.join(vaultDir, 'qa-result.json');
	const id = 'r' + Date.now() + Math.floor(Math.random() * 1000);
	try { fs.unlinkSync(rsl); } catch {}
	fs.writeFileSync(trg, JSON.stringify({ id, ...req }));
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try { const r = JSON.parse(fs.readFileSync(rsl, 'utf8')); if (r.id === id) return r; } catch {}
		await sleep(250);
	}
	throw new Error('trigger timeout');
}

async function waitReady(vaultDir, timeoutMs = 110000) {
	const ready = path.join(vaultDir, 'qa-bridge-ready.json');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(ready)) return JSON.parse(fs.readFileSync(ready, 'utf8'));
		await sleep(300);
	}
	throw new Error('qa-bridge ready 超时');
}

// 用 argv 把 obsidian:// 转发给运行中的实例（OS 真实行为）
function openUri(uri, userDataDir, display) {
	const p = spawn(OBSIDIAN_BIN, ['--no-sandbox', `--user-data-dir=${userDataDir}`, uri], {
		env: { ...process.env, DISPLAY: `:${display}` },
		detached: true,
		stdio: 'ignore',
	});
	p.unref();
	// 第二实例拿不到单实例锁会自己退出；3s 后兜底 kill 防残留
	setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} try { p.kill('SIGKILL'); } catch {} }, 3000);
}

// 关掉当前所有 modal（点关闭按钮 / 取消），防止场景间堆叠
async function closeModals(vaultDir) {
	await trigger(vaultDir, {
		action: 'eval',
		code: `
			let n = 0;
			document.querySelectorAll('.modal-container').forEach(m => {
				const cancel = [...m.querySelectorAll('button')].find(b => b.textContent.trim() === '取消');
				const close = m.querySelector('.modal-close-button');
				if (cancel) cancel.click(); else if (close) close.click();
				n++;
			});
			return { closed: n };
		`,
	});
}

async function main() {
	const args = parseArgs(process.argv);
	const display = parseInt(args.display || '112', 10);
	const outDir = args.out || path.join('/tmp', 'pmcn-deeplink-' + Date.now());
	const W = 1400, H = 900;

	requireTools();
	if (!fs.existsSync(path.join(REPO, 'main.js'))) throw new Error('先 npm run build');
	fs.mkdirSync(outDir, { recursive: true });
	const vaultDir = path.join(outDir, 'vault');
	const userDataDir = path.join(outDir, 'obsidian-userdata');
	buildVault(vaultDir);
	console.log('[dl] out =', outDir);

	const handle = await launcher.launch({
		vaultPath: vaultDir, userDataDir, display,
		viewport: { w: W, h: H }, logPath: path.join(outDir, 'obsidian.log'), launchTimeoutMs: 45000,
	});
	console.log('[dl] obsidian up; winId =', handle.winId);

	try {
		await sleep(5000);
		try { execSync(`DISPLAY=:${display} xdotool mousemove 624 568 click 1`, { stdio: 'ignore' }); } catch {}
		await sleep(2000);
		const ready = await waitReady(vaultDir);
		if (ready.timedOut) throw new Error('插件未就绪: ' + JSON.stringify(ready));
		console.log('[dl] ready; loaded =', ready.loadedPlugins);

		// 清掉信任流/启动可能残留的任何 modal（含设置面板），保证场景从干净屏开始
		await closeModals(vaultDir);
		await trigger(vaultDir, { action: 'eval', code: `if (app.setting && app.setting.close) app.setting.close(); return true` });
		await sleep(1500);

		const result = {};

		// 场景 1：白名单拒绝（非产品域）→ 只应弹 Notice，不开商店/不弹确认框
		console.log('[dl] 场景1 白名单拒绝 evil.com');
		openUri('obsidian://plugin-market-cn?op=special-import&id=evil&name=Evil&manifest=https://evil.com/manifest.json&assetBase=https://evil.com/', userDataDir, display);
		await sleep(2200);
		screenshot(display, path.join(outDir, 'shot-01-reject.png'), W, H);
		result.reject = (await trigger(vaultDir, { action: 'eval', code: `return { modals: document.querySelectorAll('.modal-container').length, notices: [...document.querySelectorAll('.notice')].map(n=>n.textContent) }` })).evalResult;
		await closeModals(vaultDir);
		await sleep(1500);

		// 场景 2：白名单放行（产品自有域）→ 弹「导入第三方插件」确认框
		console.log('[dl] 场景2 白名单放行 产品域');
		openUri('obsidian://plugin-market-cn?op=special-import&id=demo&name=演示插件&author=Team&manifest=https://relay-1.bijitongbu.site/plugin-market/demo/manifest.json&assetBase=https://relay-1.bijitongbu.site/plugin-market/demo/', userDataDir, display);
		await sleep(4500);
		screenshot(display, path.join(outDir, 'shot-02-import-confirm.png'), W, H);
		result.importConfirm = (await trigger(vaultDir, { action: 'eval', code: `const m=document.querySelector('.modal-container'); return { hasModal: !!m, title: m? m.querySelector('h3')?.textContent : null }` })).evalResult;
		await closeModals(vaultDir);
		await sleep(1500);

		// 场景 3：install dataview → 弹确认框 → 点确认 → 真实安装
		console.log('[dl] 场景3 install dataview');
		openUri('obsidian://plugin-market-cn?op=install&id=dataview', userDataDir, display);
		await sleep(5000);
		screenshot(display, path.join(outDir, 'shot-03-install-confirm.png'), W, H);
		result.installConfirm = (await trigger(vaultDir, { action: 'eval', code: `const m=document.querySelector('.modal-container'); return { hasModal: !!m, title: m? m.querySelector('h3')?.textContent : null }` })).evalResult;
		// 点「确认」
		await trigger(vaultDir, { action: 'eval', code: `const b=[...document.querySelectorAll('.modal-container .mod-cta')].pop(); if(b) b.click(); return { clicked: !!b }` });
		console.log('[dl] 已点确认，等待真实安装（线上 relay）...');
		await sleep(12000);
		screenshot(display, path.join(outDir, 'shot-04-installed.png'), W, H);
		result.install = (await trigger(vaultDir, { action: 'eval', code: `return { dataviewInstalled: !!app.plugins.manifests['dataview'], version: app.plugins.manifests['dataview']?.version }` })).evalResult;

		fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
		console.log('[dl] result =', JSON.stringify(result));
		console.log('[dl] DONE; shots in', outDir);
		console.log('OUTDIR=' + outDir);
	} finally {
		await handle.cleanup();
	}
}

main().catch(e => { console.error('[dl] fatal:', e.stack || e); process.exit(1); });
