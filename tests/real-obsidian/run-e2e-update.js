'use strict';

// 插件加速商店 — 「更新已安装插件」真机 E2E。
//
// 真 Obsidian（Xvfb）里预置两个【故意做旧】的插件（manifest 写 0.0.1 + 桩 main.js）：
//   - obsidian-hider  → 启用状态
//   - dataview        → 已安装但【停用】状态
// 然后**走真实 UI 路径**（点「已安装」标签 → 点「全部更新」按钮，不是直接调方法）。
//
// ⚠️ 期望值是**运行时算出来的**，不写死：先读真 Obsidian 的 apiVersion + 各插件线上
// HEAD manifest 的 minAppVersion，再决定哪些该被更新、哪些该被兼容性闸挡下。
// （2026-08-04 实测：hider 1.7.0 要求 Obsidian 1.13.1，而本机 Obsidian 是 1.12.7 ——
//   把它装上去就是个加载不了的插件，闸门必须挡住。写死「都该更新」的旧版 E2E
//   反而会把这种伤害当成成功。）
//
// 断言：
//   1. 检查更新真的跑到了（走的是点标签这条真实路径）
//   2. 兼容的插件更新到线上真实最新版（走 relay /gh 下载链路）
//   3. 🔴 停用中的插件更新后【仍然停用】—— 更新不许替用户打开插件
//   4. 🔴 不兼容的新版【不提示、不安装】，磁盘上仍是旧版（绝不换成跑不起来的版本）
//
//   node tests/real-obsidian/run-e2e-update.js [--display=112] [--out=<dir>]
//
// 产出 shot-*.png + result.json 到 out 目录。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const launcher = require('/home/work/gate/obsidian-plug/tests/real-obsidian/lib/obsidian-launcher.js');

const REPO = path.resolve(__dirname, '..', '..');
const BRIDGE_DIR = path.join(__dirname, 'bridge-plugin');

/** 做旧的目标：id → 是否启用 */
const STALE = [
	{ id: 'obsidian-hider', name: 'Hider', repo: 'kepano/obsidian-hider', enabled: true },
	{ id: 'dataview', name: 'Dataview', repo: 'blacksmithgu/obsidian-dataview', enabled: false },
];
const STALE_VERSION = '0.0.1';
/** 线上取 HEAD manifest 用的加速线路（与插件同一条链路） */
const RELAY_BASES = ['https://relay-1.bijitongbu.site', 'https://gh.clipfx.app'];

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

/** 桩插件：可被 Obsidian 正常加载，onload 什么都不做 */
const STUB_MAIN_JS = `'use strict';
const obsidian = require('obsidian');
module.exports = class StaleStub extends obsidian.Plugin {
	async onload() { console.log('[e2e] stale stub loaded'); }
};
`;

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

	// 预置「做旧」的已安装插件
	for (const s of STALE) {
		const dir = path.join(dot, 'plugins', s.id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
			id: s.id,
			name: s.name,
			version: STALE_VERSION,
			minAppVersion: '0.15.0',
			author: 'e2e',
			description: '故意做旧的桩，等着被更新',
		}, null, 2));
		fs.writeFileSync(path.join(dir, 'main.js'), STUB_MAIN_JS);
	}

	const enabled = ['china-speedup', 'qa-bridge', ...STALE.filter(s => s.enabled).map(s => s.id)];
	fs.writeFileSync(path.join(dot, 'community-plugins.json'), JSON.stringify(enabled));
	fs.writeFileSync(path.join(dot, 'core-plugins.json'), JSON.stringify([]));
	fs.writeFileSync(path.join(dot, 'app.json'), JSON.stringify({ legacyEditor: false }));
	fs.writeFileSync(path.join(vaultDir, 'Welcome.md'), '# 更新已安装插件 E2E\n');
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

/** 与插件里 compareVersions 同语义的最小实现（预发布号从简，够 E2E 用） */
function cmpVer(a, b) {
	const pa = String(a).replace(/^v/i, '').split('+')[0].split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
	const pb = String(b).replace(/^v/i, '').split('+')[0].split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] || 0, y = pb[i] || 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	return 0;
}

/**
 * 取线上 HEAD manifest；失败/坏 JSON 就换下一条线路重试（与插件侧同策略）。
 * 注：本机用 curl 手工核对 JSON 时要 `-o 文件` 再读，直接看 stdout 会被 rtk
 * 压成「字段类型表」，看上去像服务端返回了非法 JSON（实际不是）。
 */
async function fetchHeadManifest(repo) {
	for (let attempt = 0; attempt < 6; attempt++) {
		const base = RELAY_BASES[attempt % RELAY_BASES.length];
		const url = `${base}/gh/raw/${repo}/HEAD/manifest.json`;
		try {
			const out = execSync(`curl -sS --max-time 25 ${JSON.stringify(url)}`, { encoding: 'utf8' });
			const m = JSON.parse(out);
			if (m && typeof m.version === 'string') return m;
		} catch { /* 换下一次 */ }
		await sleep(800);
	}
	throw new Error('拿不到线上 HEAD manifest: ' + repo);
}

const fail = [];
function assert(cond, msg) {
	if (cond) console.log('[e2e] ✅', msg);
	else { console.log('[e2e] ❌', msg); fail.push(msg); }
}

async function main() {
	const args = parseArgs(process.argv);
	const display = parseInt(args.display || '112', 10);
	const outDir = args.out || path.join('/tmp', 'pmcn-e2e-update-' + Date.now());
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

	let result = {};
	try {
		await sleep(5000);
		screenshot(display, path.join(outDir, 'shot-00-boot.png'), W, H);
		try {
			execSync(`DISPLAY=:${display} xdotool mousemove 624 568 click 1`, { stdio: 'ignore' });
			console.log('[e2e] 已点信任作者按钮');
			await sleep(2000);
		} catch (e) { console.log('[e2e] 点信任按钮失败（可能无弹框）:', e.message); }

		const ready = await waitReady(vaultDir, 110000);
		console.log('[e2e] bridge ready; loaded =', ready.loadedPlugins);
		if (ready.timedOut) throw new Error('插件/命令未注册: ' + JSON.stringify(ready));

		// 运行时算期望：真 Obsidian 版本 + 各插件线上 minAppVersion
		const verRes = await trigger(vaultDir, {
			action: 'eval',
			code: 'return { apiVersion: obsidian.apiVersion };',
		});
		const appVersion = verRes.evalResult.apiVersion;
		const expect = {};
		for (const s of STALE) {
			const m = await fetchHeadManifest(s.repo);
			const compatible = !m.minAppVersion || cmpVer(m.minAppVersion, appVersion) <= 0;
			expect[s.id] = { latest: m.version, minAppVersion: m.minAppVersion, compatible };
		}
		result.appVersion = appVersion;
		result.expect = expect;
		console.log('[e2e] Obsidian', appVersion, '期望:', JSON.stringify(expect));
		const upgradable = STALE.filter(s => expect[s.id].compatible);
		const blockedList = STALE.filter(s => !expect[s.id].compatible);
		if (upgradable.length === 0) throw new Error('没有任何兼容的可更新样本，E2E 无意义（换 fixture）');

		// 前置：两个桩确实以「旧版本」被 Obsidian 认了，且启用态符合预期
		const pre = await trigger(vaultDir, {
			action: 'eval',
			code: `
				return {
					hiderVer: app.plugins.manifests['obsidian-hider']?.version,
					hiderEnabled: app.plugins.enabledPlugins.has('obsidian-hider'),
					dataviewVer: app.plugins.manifests['dataview']?.version,
					dataviewEnabled: app.plugins.enabledPlugins.has('dataview'),
				};
			`,
		});
		console.log('[e2e] 前置状态 ->', JSON.stringify(pre.evalResult));
		assert(pre.evalResult.hiderVer === '0.0.1' && pre.evalResult.hiderEnabled === true,
			'前置：hider 0.0.1 且启用');
		assert(pre.evalResult.dataviewVer === '0.0.1' && pre.evalResult.dataviewEnabled === false,
			'前置：dataview 0.0.1 且停用');

		// 1) 开商店，等清单（线上 relay）
		await trigger(vaultDir, { command: 'china-speedup:open-plugin-market' });
		console.log('[e2e] store opened; 等待清单加载...');
		await sleep(14000);
		screenshot(display, path.join(outDir, 'shot-01-store.png'), W, H);

		// 2) 【走真实 UI】点「已安装」标签 → 触发自动检查更新，等它跑完
		const check = await trigger(vaultDir, {
			action: 'eval',
			timeoutMs: 120000,
			code: `
				const p = app.plugins.plugins['china-speedup'];
				const v = app.workspace.getLeavesOfType('plugin-market-cn-view')[0]?.view;
				if (!p || !v) return { error: 'plugin/view 未就绪' };
				const tabs = Array.from(v.containerEl.querySelectorAll('.pmcn-tab'));
				const installedTab = tabs.find(t => t.textContent.includes('已安装'));
				if (!installedTab) return { error: '找不到「已安装」标签', tabs: tabs.map(t => t.textContent) };
				installedTab.click();               // ← 用户真实操作：点标签
				const deadline = Date.now() + 100000;
				// 等自动检查开始并结束（stats.requested>0 表示这一轮真的跑了）
				while (Date.now() < deadline) {
					await new Promise(r => setTimeout(r, 500));
					const st = p.updateChecker.lastRoundStats();
					if (!p.updateChecker.isRunning() && st.requested > 0) break;
				}
				return {
					ranCheck: p.updateChecker.lastRoundStats(),
					updatable: p.updateChecker.listUpdatable().map(r => ({
						id: r.id, from: r.installedVersion, to: r.latestVersion,
					})),
					blocked: p.updateChecker.listBlocked().map(r => r.id),
					cardBadges: Array.from(v.containerEl.querySelectorAll('.pmcn-card'))
						.map(c => c.querySelector('.pmcn-card-title')?.textContent),
					updateAllLabel: Array.from(v.containerEl.querySelectorAll('.pmcn-update-bar button'))
						.map(b => b.textContent),
					statusText: v.containerEl.querySelector('.pmcn-update-status')?.textContent,
				};
			`,
		}, 125000);
		result.check = check.evalResult;
		console.log('[e2e] 检查更新 ->', JSON.stringify(check.evalResult, null, 2));
		await sleep(1500);
		screenshot(display, path.join(outDir, 'shot-02-updates-found.png'), W, H);

		const upd = (check.evalResult.updatable || []);
		assert(check.evalResult.ranCheck?.requested >= 2, '点「已安装」标签真的触发了检查（requested ≥ 2）');
		for (const s of upgradable) {
			assert(upd.some(u => u.id === s.id), `${s.id}（兼容）被判为可更新`);
		}
		for (const s of blockedList) {
			assert(!upd.some(u => u.id === s.id),
				`🔴 ${s.id} 的新版需 Obsidian ${expect[s.id].minAppVersion} > 当前 ${appVersion}，不得提示为可更新`);
			assert((check.evalResult.blocked || []).includes(s.id),
				`${s.id} 被标为「需要更高版本 Obsidian」而不是被静默丢掉`);
		}
		assert((check.evalResult.cardBadges || []).some(t => t && t.includes('可更新')),
			'卡片上出现「可更新」徽标');
		assert((check.evalResult.updateAllLabel || []).some(t => t && t.includes(`全部更新（${upgradable.length}）`)),
			`「全部更新（${upgradable.length}）」按钮计数与兼容条目数一致`);

		// 3) 【走真实 UI】点「全部更新」按钮
		const doUpdate = await trigger(vaultDir, {
			action: 'eval',
			timeoutMs: 180000,
			code: `
				const WAIT_IDS_JSON = ${JSON.stringify(JSON.stringify(upgradable.map(s => s.id)))};
				const ALL_IDS_JSON = ${JSON.stringify(JSON.stringify(STALE.map(s => s.id)))};
				const p = app.plugins.plugins['china-speedup'];
				const v = app.workspace.getLeavesOfType('plugin-market-cn-view')[0]?.view;
				const btn = Array.from(v.containerEl.querySelectorAll('.pmcn-update-bar button'))
					.find(b => b.textContent.includes('全部更新'));
				if (!btn) return { error: '找不到「全部更新」按钮' };
				btn.click();                        // ← 用户真实操作：点按钮
				const wait = JSON.parse(WAIT_IDS_JSON);
				const deadline = Date.now() + 170000;
				while (Date.now() < deadline) {
					await new Promise(r => setTimeout(r, 1000));
					if (wait.every(id => {
						const v = app.plugins.manifests[id]?.version;
						return v && v !== '0.0.1';
					})) break;
				}
				const state = {};
				for (const id of JSON.parse(ALL_IDS_JSON)) {
					state[id] = {
						version: app.plugins.manifests[id]?.version,
						enabled: app.plugins.enabledPlugins.has(id),
					};
				}
				return {
					state,
					stillUpdatable: p.updateChecker.listUpdatable().map(r => r.id),
					statusText: v.containerEl.querySelector('.pmcn-update-status')?.textContent,
				};
			`,
		}, 185000);
		result.update = doUpdate.evalResult;
		console.log('[e2e] 全部更新 ->', JSON.stringify(doUpdate.evalResult, null, 2));
		await sleep(2500);
		screenshot(display, path.join(outDir, 'shot-03-updated.png'), W, H);

		const r = doUpdate.evalResult || {};
		const st = r.state || {};
		for (const s of upgradable) {
			assert(st[s.id]?.version && st[s.id].version !== STALE_VERSION,
				`${s.id} 已更新到真实版本 v${st[s.id]?.version}`);
			assert(st[s.id]?.enabled === s.enabled,
				s.enabled
					? `原本启用的 ${s.id} 更新后仍然启用`
					: `🔴 原本停用的 ${s.id} 更新后【仍然停用】（更新不替用户开插件）`);
		}
		for (const s of blockedList) {
			// 🔴 装上去会加载不了的版本，绝不能因为「全部更新」被写进去
			assert(st[s.id]?.version === STALE_VERSION,
				`🔴 ${s.id} 未被换成不兼容的 v${expect[s.id].latest}，仍是 v${st[s.id]?.version}`);
			assert(st[s.id]?.enabled === s.enabled, `${s.id} 的启用状态未被改动`);
		}
		assert((r.stillUpdatable || []).length === 0, '更新完毕后「可更新」清零');
		if (blockedList.length > 0) {
			assert((r.statusText || '').includes('需要更高版本 Obsidian'),
				'状态行如实写明「N 个新版需要更高版本 Obsidian」');
		}

		// 4) 磁盘上真的是新文件（不只是内存 manifest）
		for (const s of upgradable) {
			const mf = path.join(vaultDir, '.obsidian', 'plugins', s.id, 'manifest.json');
			const disk = JSON.parse(fs.readFileSync(mf, 'utf8'));
			const mainSize = fs.statSync(path.join(vaultDir, '.obsidian', 'plugins', s.id, 'main.js')).size;
			assert(disk.version !== STALE_VERSION && disk.id === s.id && mainSize > 1000,
				`${s.id} 磁盘上是新版 v${disk.version}（main.js ${mainSize}B）`);
		}
		for (const s of blockedList) {
			const mf = path.join(vaultDir, '.obsidian', 'plugins', s.id, 'manifest.json');
			const disk = JSON.parse(fs.readFileSync(mf, 'utf8'));
			assert(disk.version === STALE_VERSION, `${s.id} 磁盘上仍是旧版（没被不兼容的新版覆盖）`);
		}

		result.failures = fail;
		fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
		console.log('[e2e] shots in', outDir);
		console.log('OUTDIR=' + outDir);
		if (fail.length) {
			console.error('[e2e] 断言失败 ' + fail.length + ' 条:\n - ' + fail.join('\n - '));
			process.exitCode = 1;
		} else {
			console.log('[e2e] 全部断言通过 ✅');
		}
	} finally {
		await handle.cleanup();
	}
}

main().catch(e => { console.error('[e2e] fatal:', e.stack || e); process.exit(1); });
