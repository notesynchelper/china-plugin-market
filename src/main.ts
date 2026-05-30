import {
	App,
	Notice,
	Plugin,
	WorkspaceLeaf,
	requestUrl,
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
} from "./relaySelector";
import {
	installEntry,
	getInstalledState,
	type InstallContext,
	type PluginsApi,
} from "./installer";
import { runDeeplink } from "./deeplink";
import { confirmDialog } from "./confirmModal";
import { MarketView, MARKET_VIEW_TYPE } from "./marketView";
import { PluginMarketSettingTab } from "./settingsTab";
import { PluginUpdater } from "./updater";

const PROTOCOL_ACTION = "plugin-market-cn";

/** app.plugins 不在公开类型里，按需窄化 */
interface AppWithPlugins extends App {
	plugins: PluginsApi & { setupPluginView?: () => void };
}

export default class PluginMarketPlugin extends Plugin {
	settings: PluginMarketSettings = { ...DEFAULT_SETTINGS };
	registry = new Registry();
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
		if (leaf) workspace.revealLeaf(leaf);
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

	async reprobeNodes(): Promise<string> {
		clearRelayCache();
		return this.getFastestBase();
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
					const r = await requestUrl({ url, method: "GET" });
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

	async installMarketEntry(entry: MarketEntry): Promise<void> {
		const notice = new Notice(`正在安装「${entry.name}」…`, 0);
		try {
			const base = await this.getFastestBase();
			const version = await installEntry(entry, base, this.buildInstallContext());
			notice.setMessage(`「${entry.name}」安装成功 v${version}`);
			setTimeout(() => notice.hide(), 4000);
			this.getMarketView()?.refresh();
		} catch (e) {
			logError("安装失败:", e);
			notice.setMessage(
				`「${entry.name}」安装失败：${e instanceof Error ? e.message : e}`
			);
			setTimeout(() => notice.hide(), 6000);
		}
	}

	async installById(id: string): Promise<void> {
		try {
			const { entries } = await this.registry.load(this.settings);
			const entry = entries.find((e) => e.id === id);
			if (!entry) {
				new Notice(`商店清单里找不到插件「${id}」`);
				return;
			}
			await this.installMarketEntry(entry);
		} catch (e) {
			logError("installById 失败:", e);
			new Notice(`安装「${id}」失败：${e instanceof Error ? e.message : e}`);
		}
	}

	// ---------- 调起链接 ----------
	private async handleProtocol(params: ObsidianProtocolData): Promise<void> {
		await runDeeplink(params as Record<string, string>, {
			enabled: this.settings.enableDeeplink,
			openView: () => this.activateView(),
			locate: (id) => this.getMarketView()?.locate(id),
			confirm: (title, body) => confirmDialog(this.app, title, body),
			installById: (id) => this.installById(id),
			installEntry: (entry) => this.installMarketEntry(entry),
			notify: (msg) => new Notice(msg),
		});
	}

	// ---------- 自更新 ----------
	private buildUpdater(): PluginUpdater {
		const adapter = this.app.vault.adapter;
		return new PluginUpdater(
			{
				requestText: async (url: string) => {
					const r = await requestUrl({ url, method: "GET" });
					return { status: r.status, text: r.text, json: r.json };
				},
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
