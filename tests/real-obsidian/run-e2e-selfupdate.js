'use strict';

// 插件加速商店 — 【自更新】真机 E2E（发版后必跑）。
//
// 真 Obsidian（Xvfb）里装一个【线上旧版】china-speedup（GitHub Release 资产），启动后
// 走真实自更新路径：命令「检查插件加速商店更新」→ 弹确认框 → 点确认 → 从 relay 下载
// 新版原地替换。断言磁盘上的三件套确实变成了端点当前版本、且 .backup 生成 /
// .update-temp 清理干净。
//
// 存在意义：2026-08-04 之前这条链路曾 100% 失败（requestUrl 的 r.json 在 main.js 上抛），
// 端点推了新版但没有一个用户更得动，**单测看不见**。发版后必须真机验一次。
//
//   node tests/real-obsidian/run-e2e-selfupdate.js [--from=0.1.4] [--display=122] [--out=<dir>]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const launcher = require('/home/work/gate/obsidian-plug/tests/real-obsidian/lib/obsidian-launcher.js');

const BRIDGE_DIR = path.join(__dirname, 'bridge-plugin');
const PLUGIN_ID = 'china-speedup';
const REPO_SLUG = 'notesynchelper/china-speedup';
const ENDPOINT = 'https://relay-1.bijitongbu.site/plugin-market';
const FILES = ['main.js', 'manifest.json', 'styles.css'];

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

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** 取端点当前版本 + 制品 sha（落盘再读：curl 的 stdout 会被 rtk 压成摘要） */
function fetchEndpointState(tmpDir) {
	fs.mkdirSync(tmpDir, { recursive: true });
	const out = {};
	for (const f of [...FILES, 'version.json']) {
		const p = path.join(tmpDir, f);
		execSync(`curl -sS --max-time 40 ${JSON.stringify(`${ENDPOINT}/${f}?_v=${Date.now()}`)} -o ${JSON.stringify(p)}`);
		out[f] = fs.readFileSync(p);
	}
	return {
		version: JSON.parse(out['version.json'].toString('utf8')).version,
		sha: Object.fromEntries(FILES.map(f => [f, sha(out[f])])),
	};
}

function buildVault(vaultDir, oldVer, workDir) {
	const dot = path.join(vaultDir, '.obsidian');
	const pluginDir = path.join(dot, 'plugins', PLUGIN_ID);
	fs.mkdirSync(pluginDir, { recursive: true });
	fs.mkdirSync(path.join(dot, 'plugins', 'qa-bridge'), { recursive: true });

	// 装【线上旧版】——用 Release 资产，跟真实用户手里的字节一致
	execSync(
		`gh release download ${oldVer} --repo ${REPO_SLUG} --dir ${JSON.stringify(pluginDir)} ` +
		FILES.map(f => `--pattern ${f}`).join(' ') + ' --clobber',
		{ stdio: 'pipe' },
	);
	for (const f of ['main.js', 'manifest.json']) {
		fs.copyFileSync(path.join(BRIDGE_DIR, f), path.join(dot, 'plugins', 'qa-bridge', f));
	}
	fs.writeFileSync(path.join(dot, 'community-plugins.json'), JSON.stringify([PLUGIN_ID, 'qa-bridge']));
	fs.writeFileSync(path.join(dot, 'core-plugins.json'), JSON.stringify([]));
	fs.writeFileSync(path.join(dot, 'app.json'), JSON.stringify({ legacyEditor: false }));
	fs.writeFileSync(path.join(vaultDir, 'Welcome.md'), '# 自更新 E2E\n');
	fs.mkdirSync(workDir, { recursive: true });
	return pluginDir;
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

async function waitReady(vaultDir, timeoutMs = 110000) {
	const ready = path.join(vaultDir, 'qa-bridge-ready.json');
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(ready)) return JSON.parse(fs.readFileSync(ready, 'utf8'));
		await sleep(300);
	}
	throw new Error('qa-bridge ready 超时');
}

const fail = [];
function assert(cond, msg) {
	if (cond) console.log('[e2e] ✅', msg);
	else { console.log('[e2e] ❌', msg); fail.push(msg); }
}

async function main() {
	const args = parseArgs(process.argv);
	const display = parseInt(args.display || '122', 10);
	const outDir = args.out || path.join('/tmp', 'pmcn-e2e-selfupdate-' + Date.now());
	const W = 1400, H = 900;

	requireTools();
	fs.mkdirSync(outDir, { recursive: true });
	const vaultDir = path.join(outDir, 'vault');
	const userDataDir = path.join(outDir, 'obsidian-userdata');

	const endpoint = fetchEndpointState(path.join(outDir, 'endpoint'));
	const oldVer = args.from || '0.1.4';
	console.log('[e2e] 端点当前版本 =', endpoint.version, '| 起始安装版本 =', oldVer);
	if (oldVer === endpoint.version) throw new Error('起始版本与端点同版，测不出更新');

	const pluginDir = buildVault(vaultDir, oldVer, path.join(outDir, 'work'));
	const before = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
	console.log('[e2e] vault 里预装 =', before.id, before.version);

	const handle = await launcher.launch({
		vaultPath: vaultDir, userDataDir, display,
		viewport: { w: W, h: H },
		logPath: path.join(outDir, 'obsidian.log'),
		launchTimeoutMs: 45000,
	});

	try {
		await sleep(5000);
		screenshot(display, path.join(outDir, 'shot-00-boot.png'), W, H);
		try {
			execSync(`DISPLAY=:${display} xdotool mousemove 624 568 click 1`, { stdio: 'ignore' });
			await sleep(2000);
		} catch { /* 可能没有信任框 */ }

		const ready = await waitReady(vaultDir);
		assert(!ready.timedOut, '旧版插件正常加载（命令已注册）');
		assert(before.version === oldVer, `起始版本确实是 v${oldVer}`);

		// 走真实入口：命令面板「检查插件加速商店更新」
		await trigger(vaultDir, { command: 'china-speedup:check-self-update' });
		await sleep(6000);
		screenshot(display, path.join(outDir, 'shot-01-confirm.png'), W, H);

		// 点确认框里的「确认」（用户真实操作）
		const clicked = await trigger(vaultDir, {
			action: 'eval',
			code: `
				const btns = Array.from(document.querySelectorAll('.modal-button-container button'));
				const ok = btns.find(b => b.textContent.trim() === '确认');
				const title = document.querySelector('.modal-content h3, .modal h3')?.textContent || '';
				if (ok) ok.click();
				return { found: !!ok, title, buttons: btns.map(b => b.textContent.trim()) };
			`,
		});
		console.log('[e2e] 确认框 ->', JSON.stringify(clicked.evalResult));
		assert(clicked.evalResult.found === true,
			`弹出了「${clicked.evalResult.title || '发现新版本'}」确认框并点了确认`);

		// 等磁盘上的制品被替换
		const deadline = Date.now() + 120000;
		let now = before.version;
		while (Date.now() < deadline) {
			await sleep(1500);
			try {
				now = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')).version;
			} catch { /* 替换瞬间可能读到半个文件 */ }
			if (now === endpoint.version) break;
		}
		await sleep(1500);
		screenshot(display, path.join(outDir, 'shot-02-updated.png'), W, H);

		assert(now === endpoint.version,
			`自更新把 v${oldVer} 换成了端点版本 v${endpoint.version}（实际 v${now}）`);
		for (const f of FILES) {
			const p = path.join(pluginDir, f);
			const got = fs.existsSync(p) ? sha(fs.readFileSync(p)) : '(缺失)';
			assert(got === endpoint.sha[f], `${f} 与端点字节一致（${got.slice(0, 12)}）`);
		}
		assert(fs.existsSync(path.join(pluginDir, 'main.js.backup')), '替换前生成了 main.js.backup');
		const leftovers = fs.readdirSync(pluginDir).filter(f => f.endsWith('.update-temp'));
		assert(leftovers.length === 0, `临时文件清理干净（残留 ${leftovers.length} 个）`);

		fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
			from: oldVer, endpoint, finalVersion: now, failures: fail,
		}, null, 2));
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
