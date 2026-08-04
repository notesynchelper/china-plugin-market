import {
	App,
	Notice,
	Plugin,
	WorkspaceLeaf,
	apiVersion,
	Platform,
	type ObsidianProtocolData,
} from "obsidian";

import { log, logError } from "./logger";
import { BUILD_CONFIG } from "./build-config";
import {
	DEFAULT_SETTINGS,
	type PluginMarketSettings,
	type MarketEntry,
} from "./types";
import { Registry } from "./registry";
import {
	getOrderedFallbackBases,
	relaysToBases,
	selectFastestBase,
	peekRelayCache,
	clearRelayCache,
	notifyRequestFailure,
	notifyRequestSuccess,
} from "./relaySelector";
import {
	installEntry,
	getInstalledState,
	AllBasesFailedError,
	type InstallContext,
	type PluginsApi,
} from "./installer";
import {
	UpdateChecker,
	type EntryUpdateInfo,
	type UpdateCandidate,
} from "./updateChecker";
import { friendlyError } from "./userMessage";
import { fetchText } from "./obsidianNet";
import { runDeeplink } from "./deeplink";
import { confirmDialog } from "./confirmModal";
import { MarketView, MARKET_VIEW_TYPE } from "./marketView";
import { PluginMarketSettingTab } from "./settingsTab";
import { PluginUpdater } from "./updater";

const PROTOCOL_ACTION = "plugin-market-cn";

/** 安装/更新/重新安装 —— 三个独立操作，文案与「是否改动启用状态」都不同 */
export type InstallMode = "install" | "update" | "reinstall";

const MODE_VERB: Record<InstallMode, string> = {
	install: "安装",
	update: "更新",
	reinstall: "重新安装",
};

/** app.plugins 不在公开类型里，按需窄化 */
interface AppWithPlugins extends App {
	plugins: PluginsApi & { setupPluginView?: () => void };
}

export default class PluginMarketPlugin extends Plugin {
	settings: PluginMarketSettings = { ...DEFAULT_SETTINGS };
	registry = new Registry();
	updateChecker = new UpdateChecker();
	private updater: PluginUpdater | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(
			MARKET_VIEW_TYPE,
			(leaf) => new MarketView(leaf, this)
		);

		this.addRibbonIcon("store", "插件加速商店", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-plugin-market",
			name: "打开插件加速商店",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "check-self-update",
			name: "检查插件加速商店更新",
			callback: () => void this.runSelfUpdateCheck(true),
		});

		this.addCommand({
			id: "check-installed-plugin-updates",
			name: "检查已安装插件更新",
			callback: () => void this.checkInstalledUpdates(true, true),
		});

		this.addSettingTab(new PluginMarketSettingTab(this.app, this));

		// obsidian://plugin-market-cn?action=...
		this.registerObsidianProtocolHandler(
			PROTOCOL_ACTION,
			(params: ObsidianProtocolData) => {
				void this.handleProtocol(params);
			}
		);

		// 自更新：仅在编译开关 + 用户设置都开启时
		if (BUILD_CONFIG.ENABLE_AUTO_UPDATE && this.settings.enableSelfUpdate) {
			this.app.workspace.onLayoutReady(() => {
				void this.runSelfUpdateCheck(false);
			});
		}

		log("插件加速商店已加载");
	}

	onunload(): void {
		// view 由 Obsidian 在 unload 时回收
	}

	// ---------- 设置 ----------
	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<PluginMarketSettings> | null
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ---------- 视图 ----------
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const existing = workspace.getLeavesOfType(MARKET_VIEW_TYPE);
		if (existing.length > 0) {
			leaf = existing[0];
		} else {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: MARKET_VIEW_TYPE, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	private getMarketView(): MarketView | null {
		const leaves = this.app.workspace.getLeavesOfType(MARKET_VIEW_TYPE);
		const view = leaves[0]?.view;
		return view instanceof MarketView ? view : null;
	}

	// ---------- relay base ----------
	async getOrderedBases(): Promise<string[]> {
		return getOrderedFallbackBases(relaysToBases(this.registry.getKnownRelays()));
	}

	async getFastestBase(): Promise<string> {
		const base = await selectFastestBase(
			relaysToBases(this.registry.getKnownRelays())
		);
		this.settings.lastFastestBase = base;
		return base;
	}

	currentBaseLabel(): string {
		const cache = peekRelayCache();
		return cache?.base || this.settings.lastFastestBase || "(未测速)";
	}

	/**
	 * 重新测速。`ok=false` 表示所有线路探测都失败（selectFastestBase 会回退到
	 * 候选池第一条但**不写缓存**），此时不能对用户说「已切换到最快线路」。
	 */
	async reprobeNodes(): Promise<{ base: string; ok: boolean }> {
		clearRelayCache();
		const base = await this.getFastestBase();
		return { base, ok: peekRelayCache() != null };
	}

	// ---------- 安装 ----------
	private get pluginsApi(): PluginsApi {
		return (this.app as AppWithPlugins).plugins;
	}

	private buildInstallContext(): InstallContext {
		const adapter = this.app.vault.adapter;
		return {
			net: {
				async getText(url: string) {
					const r = await fetchText(url);
					return { status: r.status, text: r.text };
				},
			},
			fs: {
				exists: (p) => adapter.exists(p),
				mkdir: (p) => adapter.mkdir(p),
				write: (p, d) => adapter.write(p, d),
			},
			plugins: this.pluginsApi,
			configDir: this.app.vault.configDir,
		};
	}

	getInstalledState(id: string) {
		return getInstalledState(id, this.pluginsApi);
	}

	/**
	 * 安装 / 更新 / 重新安装一条插件。返回是否成功。
	 *
	 * 🔴 update 与 reinstall **保持插件原有启用状态**——用户手动停用过的插件，
	 * 更新或重装都不该顺手替他打开（那是改配置）。只有 install（首次安装 /
	 * 调起链接安装）才启用。
	 */
	async installMarketEntry(
		entry: MarketEntry,
		opts: { mode?: InstallMode } = {}
	): Promise<boolean> {
		const mode: InstallMode = opts.mode ?? "install";
		const verb = MODE_VERB[mode];
		const before = this.getInstalledState(entry.id);
		const keepDisabled =
			mode !== "install" && before.installed && !before.enabled;
		const notice = new Notice(`正在${verb}「${entry.name}」…`, 0);
		try {
			// 传整条「最快优先 + 其余候选」列表：某条线路的 /gh/release 挂了
			// （relay 到 github.com 被阻断时会 502/504）自动落到下一条，含 CF 备线
			const bases = await this.getOrderedBases();
			this.settings.lastFastestBase = bases[0] ?? "";
			const version = await installEntry(
				entry,
				bases,
				this.buildInstallContext(),
				{
					enable: !keepDisabled,
					// 更新必须拿到严格更新的版本；重装允许等值但不许降级
					mustBeNewerThan:
						mode === "update" ? before.version : undefined,
					notOlderThan:
						mode === "reinstall" ? before.version : undefined,
					// 落地前再验一次兼容性（写盘不可逆）
					appVersion: apiVersion,
					isMobile: Platform.isMobile,
				}
			);
			notifyRequestSuccess();
			this.updateChecker.markUpdated(entry.id, version);
			const done =
				mode === "update"
					? `「${entry.name}」已更新至 v${version}`
					: `「${entry.name}」已${verb}（v${version}）`;
			notice.setMessage(keepDisabled ? `${done}，仍处于停用状态` : done);
			window.setTimeout(() => notice.hide(), 4000);
			this.getMarketView()?.refresh();
			return true;
		} catch (e) {
			logError(`${verb}失败:`, e);
			// 只有「所有线路都下载失败」才算线路问题；id 不匹配 / 写盘失败
			// 与线路无关，不该推高失败计数去清测速缓存
			if (e instanceof AllBasesFailedError) notifyRequestFailure();
			notice.setMessage(`「${entry.name}」${verb}失败：${friendlyError(e)}`);
			window.setTimeout(() => notice.hide(), 6000);
			return false;
		}
	}

	async installById(id: string): Promise<void> {
		try {
			const { entries } = await this.registry.load(this.settings);
			const entry = entries.find((e) => e.id === id);
			if (!entry) {
				new Notice(`商店中未找到插件「${id}」`);
				return;
			}
			await this.installMarketEntry(entry);
		} catch (e) {
			logError("installById 失败:", e);
			new Notice(`安装「${id}」失败：${friendlyError(e)}`);
		}
	}

	// ---------- 已安装插件的更新 ----------

	/**
	 * 可检查更新的已安装插件 = 商店清单里有、本地已装且能读到版本号的条目。
	 * 本插件自己走自更新链路（见 runSelfUpdateCheck），不混进来。
	 */
	updateCandidates(entries: readonly MarketEntry[]): UpdateCandidate[] {
		const out: UpdateCandidate[] = [];
		for (const entry of entries) {
			if (entry.id === this.manifest.id) continue;
			const state = this.getInstalledState(entry.id);
			if (!state.installed || !state.version) continue;
			out.push({ entry, installedVersion: state.version });
		}
		return out;
	}

	/**
	 * 检查已安装插件是否有新版本。
	 *
	 * @param force  跳过 30min 缓存
	 * @param notify 是否弹 Notice 汇报（命令面板入口用；商店视图内自己渲染状态）
	 * @returns 可更新条目；正在检查中返回 null
	 */
	async checkInstalledUpdates(
		force: boolean,
		notify = false
	): Promise<EntryUpdateInfo[] | null> {
		if (this.updateChecker.isRunning()) {
			if (notify) new Notice("正在检查更新，请稍候…");
			return null;
		}
		const notice = notify ? new Notice("正在检查更新…", 0) : null;
		try {
			const { entries, officialOk } = await this.registry.load(this.settings);
			// registry.load 在线路挂掉时会「安静地」降级：官方清单取失败就只剩
			// 特殊导入那几条。没有官方清单 ≠ 没有可检查的插件，此时既不能清缓存
			// 也不能说「暂无」——那会把一次网络故障说成「你没有插件要更新」
			if (!officialOk) {
				notice?.setMessage("插件列表没取到，请检查网络后重试");
				if (notice) window.setTimeout(() => notice.hide(), 5000);
				return null;
			}
			const candidates = this.updateCandidates(entries);
			if (candidates.length === 0) {
				// 一个候选都没有（插件全卸了/全不在清单里）→ 旧结论必须一起清掉，
				// 否则「全部更新」会把用户已卸载的插件装回来
				this.updateChecker.clear();
				notice?.setMessage("本商店中暂无可检查更新的已安装插件");
				if (notice) window.setTimeout(() => notice.hide(), 4000);
				return [];
			}
			const bases = await this.getOrderedBases();
			const updatable = await this.updateChecker.run(
				candidates,
				bases,
				{ getText: async (url) => fetchText(url) },
				Date.now(),
				{
					force,
					// 新版要求的 Obsidian 比用户的新时不提示更新（装了会加载不了）
					appVersion: apiVersion,
					isMobile: Platform.isMobile,
					// 只在真查出「可更新」时重画（可更新通常只有个位数）；
					// 每条结论都重画会让「全部」tab 的几百张卡片被反复重建
					onEach: (info) => {
						if (info.hasUpdate) this.getMarketView()?.refresh();
					},
				}
			);
			// 期间被别处抢先开了一轮（run 返回 null）：没有本轮结论，
			// 绝不能拿空结果说「都是最新版」
			if (updatable === null) {
				notice?.setMessage("正在检查更新，请稍候…");
				if (notice) window.setTimeout(() => notice.hide(), 4000);
				return null;
			}
			if (notice) {
				const { requested, resolved } = this.updateChecker.lastRoundStats();
				const missed = Math.max(0, requested - resolved);
				const n = updatable.length;
				// 「未能获取最新版本」是独立的一档，绝不并进「没有可更新」里
				const tail = missed > 0 ? `，另有 ${missed} 个未能获取最新版本` : "";
				notice.setMessage(
					n > 0
						? `${n} 个插件可更新${tail}。请到商店「已安装」页更新`
						: `未发现可更新的插件${tail}`
				);
				window.setTimeout(() => notice.hide(), 5000);
			}
			this.getMarketView()?.refresh();
			return updatable;
		} catch (e) {
			logError("检查已安装插件更新失败:", e);
			if (notice) {
				notice.setMessage(`检查更新失败：${friendlyError(e)}`);
				window.setTimeout(() => notice.hide(), 6000);
			}
			return null;
		}
	}

	/**
	 * 逐个更新所有「已确认可更新」的插件（串行，避免并发写盘 + 抢线路）。
	 * onProgress(done, total) 供 UI 显示「正在更新 2/5…」。
	 */
	async updateAllInstalled(
		onProgress?: (done: number, total: number) => void
	): Promise<{ ok: number; failed: number }> {
		const targets = this.updateChecker.listUpdatable();
		let ok = 0;
		let failed = 0;
		if (targets.length === 0) return { ok, failed };
		let byId: Map<string, MarketEntry>;
		try {
			const { entries } = await this.registry.load(this.settings);
			byId = new Map(entries.map((e) => [e.id, e]));
		} catch (e) {
			logError("全部更新前取清单失败:", e);
			new Notice(`更新失败，插件列表没取到：${friendlyError(e)}`, 6000);
			return { ok, failed: targets.length };
		}
		let skipped = 0;
		let done = 0;
		onProgress?.(0, targets.length);
		for (const t of targets) {
			// 结论产出后用户可能已把插件卸载 —— 绝不趁「全部更新」把它装回来
			if (!this.getInstalledState(t.id).installed) {
				this.updateChecker.forget(t.id);
				skipped++;
				continue;
			}
			const entry = byId.get(t.id);
			if (!entry) {
				failed++;
				continue;
			}
			const success = await this.installMarketEntry(entry, { mode: "update" });
			if (success) ok++;
			else failed++;
			onProgress?.(++done, targets.length);
		}
		new Notice(
			ok + failed === 0
				? "没有需要更新的插件"
				: failed === 0
					? `${ok} 个插件已更新`
					: `更新完成：成功 ${ok} 个，失败 ${failed} 个`,
			6000
		);
		if (skipped > 0) log("已跳过", skipped, "个更新前已被卸载的插件");
		this.getMarketView()?.refresh();
		return { ok, failed };
	}

	// ---------- 调起链接 ----------
	private async handleProtocol(params: ObsidianProtocolData): Promise<void> {
		await runDeeplink(params, {
			enabled: this.settings.enableDeeplink,
			openView: () => this.activateView(),
			locate: (id) => this.getMarketView()?.locate(id),
			confirm: (title, body) => confirmDialog(this.app, title, body),
			installById: (id) => this.installById(id),
			installEntry: async (entry) => {
				await this.installMarketEntry(entry);
			},
			notify: (msg) => new Notice(msg),
		});
	}

	// ---------- 自更新 ----------
	private buildUpdater(): PluginUpdater {
		const adapter = this.app.vault.adapter;
		return new PluginUpdater(
			{
				// ⚠️ 必须走 fetchText：直接读 requestUrl 的 r.json 会在 main.js
				// 这种非 JSON 正文上抛异常，自更新曾因此 100% 失败
				requestText: (url: string) => fetchText(url),
				adapter: {
					write: (p, d) => adapter.write(p, d),
					read: (p) => adapter.read(p),
					exists: (p) => adapter.exists(p),
					remove: (p) => adapter.remove(p),
					stat: (p) => adapter.stat(p),
				},
				basesProvider: () => this.getOrderedBases(),
				now: () => Date.now(),
			},
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`,
			this.manifest.version
		);
	}

	async runSelfUpdateCheck(manual: boolean): Promise<void> {
		if (!BUILD_CONFIG.ENABLE_AUTO_UPDATE) {
			if (manual) new Notice("此构建未开启自更新");
			return;
		}
		if (!this.updater) this.updater = this.buildUpdater();
		const result = await this.updater.checkForUpdate(manual);
		if (result.error) {
			if (manual) new Notice(`检查更新失败：${result.error}`);
			return;
		}
		if (!result.hasUpdate) {
			if (manual)
				new Notice(`已是最新版本 v${result.currentVersion}`);
			return;
		}
		const ok = await confirmDialog(
			this.app,
			"发现新版本",
			`插件加速商店有新版本 v${result.latestVersion}（当前 v${result.currentVersion}）。\n是否现在更新？更新后需重启 Obsidian。`
		);
		if (!ok) return;
		const upd = await this.updater.performUpdate();
		new Notice(upd.message, upd.success ? 6000 : 8000);
	}
}
