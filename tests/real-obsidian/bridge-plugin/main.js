'use strict';

// QA Bridge（改自 obsidian-plug/tests/real-obsidian/bridge-plugin）。
// 监听 <vault>/qa-trigger.json 执行：
//   { id, command:"<commandId>" }          → app.commands.executeCommandById
//   { id, action:"eval", code:"<js>" }     → 在 Obsidian 上下文 async eval（E2E 触发真实安装用）
// 结果写 <vault>/qa-result.json；就绪信号 <vault>/qa-bridge-ready.json（等本插件 + 命令注册后写）。

const obsidian = require('obsidian');
const fs = require('fs');
const path = require('path');

const TRIGGER_FILE = 'qa-trigger.json';
const RESULT_FILE = 'qa-result.json';
const READY_FILE = 'qa-bridge-ready.json';
const POLL_MS = 300;

const REQUIRED_PLUGIN_IDS = ['plugin-market-cn'];
const REQUIRED_COMMAND_IDS = ['plugin-market-cn:open-plugin-market'];

function resolveVaultBasePath(adapter) {
	if (!adapter) return null;
	if (typeof adapter.getBasePath === 'function') {
		try { return adapter.getBasePath(); } catch {}
	}
	if (adapter.basePath) return adapter.basePath;
	if (adapter.path && adapter.path.basePath) return adapter.path.basePath;
	return null;
}

class QABridge extends obsidian.Plugin {
	async onload() {
		this.vaultPath = resolveVaultBasePath(this.app.vault.adapter);
		if (!this.vaultPath) { console.error('[qa-bridge] no vault basePath'); return; }
		this.triggerPath = path.join(this.vaultPath, TRIGGER_FILE);
		this.resultPath = path.join(this.vaultPath, RESULT_FILE);
		this.readyPath = path.join(this.vaultPath, READY_FILE);
		this.lastMtimeNs = 0;
		this.readySignalWritten = false;

		const h = window.setInterval(() => { this._poll(); }, POLL_MS);
		this.registerInterval(h);
		this.app.workspace.onLayoutReady(() => this._armReady());
	}

	_armReady() {
		const deadline = Date.now() + 60000;
		const tick = () => {
			if (this.readySignalWritten) return;
			const mp = REQUIRED_PLUGIN_IDS.filter(id => !this.app.plugins?.plugins?.[id]);
			const mc = REQUIRED_COMMAND_IDS.filter(id => !this.app.commands?.commands?.[id]);
			if (mp.length === 0 && mc.length === 0) return this._writeReady();
			if (Date.now() > deadline) return this._writeReady({ missingPlugins: mp, missingCommands: mc, timedOut: true });
			setTimeout(tick, 100);
		};
		tick();
	}

	_writeReady(extra = {}) {
		if (this.readySignalWritten) return;
		this.readySignalWritten = true;
		const payload = Object.assign({
			ts: Date.now(),
			loadedPlugins: Object.keys(this.app.plugins?.plugins || {}),
		}, extra);
		try { fs.writeFileSync(this.readyPath, JSON.stringify(payload, null, 2)); }
		catch (e) { console.error('[qa-bridge] ready write fail', e); }
	}

	async _poll() {
		let st;
		try { st = fs.statSync(this.triggerPath); }
		catch (e) { if (e.code !== 'ENOENT') console.error('[qa-bridge] stat', e); return; }
		const ns = st.mtimeNs !== undefined ? Number(st.mtimeNs) : st.mtimeMs * 1e6;
		if (ns === this.lastMtimeNs) return;
		this.lastMtimeNs = ns;
		let req;
		try { req = JSON.parse(fs.readFileSync(this.triggerPath, 'utf8')); }
		catch (e) { return this._writeResult({ status: 'err', error: 'parse: ' + e.message }); }
		await this._handle(req);
	}

	async _handle(req) {
		const res = { id: req?.id, command: req?.command, action: req?.action, startedAt: Date.now() };
		try {
			if (req?.action === 'eval') {
				if (typeof req.code !== 'string') throw new Error('missing code');
				// eslint-disable-next-line no-new-func
				const fn = new Function('app', 'obsidian', 'return (async () => {' + req.code + '})()');
				res.evalResult = await fn(this.app, obsidian);
				res.executed = true;
				res.status = 'ok';
			} else if (req?.command) {
				res.executed = !!this.app.commands.executeCommandById(req.command);
				res.status = 'ok';
			} else {
				throw new Error('missing command or action');
			}
		} catch (e) {
			res.status = 'err';
			res.error = String(e?.stack || e);
		} finally {
			res.finishedAt = Date.now();
			this._writeResult(res);
		}
	}

	_writeResult(res) {
		try { fs.writeFileSync(this.resultPath, JSON.stringify(res, null, 2)); }
		catch (e) { console.error('[qa-bridge] result write fail', e); }
	}
}

module.exports = QABridge;
