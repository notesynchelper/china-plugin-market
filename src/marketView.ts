import { ItemView, WorkspaceLeaf } from "obsidian";
import type PluginMarketPlugin from "./main";
import type { InstallMode } from "./main";
import type { MarketEntry } from "./types";
import type { EntryUpdateInfo } from "./updateChecker";
import { logError } from "./logger";
import { friendlyError } from "./userMessage";

export const MARKET_VIEW_TYPE = "plugin-market-cn-view";

type TabKey = "all" | "installed" | "special";

/** 按钮上的动作名，与 Notice 里的措辞保持同一套词 */
const MODE_LABEL: Record<InstallMode, string> = {
	install: "安装",
	update: "更新",
	reinstall: "重新安装",
};

export class MarketView extends ItemView {
	private plugin: PluginMarketPlugin;
	private entries: MarketEntry[] = [];
	private filterText = "";
	private activeTab: TabKey = "all";
	private loading = false;
	/** 「全部更新」批次进行中：期间必须锁住所有更新入口，否则会并发写盘 */
	private batchUpdating = false;
	private batchDone = 0;
	private batchTotal = 0;

	private listEl!: HTMLElement;
	private nodeStatusEl!: HTMLElement;
	private tabsEl!: HTMLElement;
	private updateBarEl!: HTMLElement;
	private updateStatusEl!: HTMLElement;
	private checkBtn!: HTMLButtonElement;
	private updateAllBtn!: HTMLButtonElement;

	constructor(leaf: WorkspaceLeaf, plugin: PluginMarketPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return MARKET_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "插件加速商店";
	}

	getIcon(): string {
		return "store";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("pmcn-view");
		this.buildToolbar(root);
		this.listEl = root.createDiv({ cls: "pmcn-list" });
		await this.reloadCatalog(false);
	}

	private buildToolbar(root: HTMLElement): void {
		const toolbar = root.createDiv({ cls: "pmcn-toolbar" });

		const row1 = toolbar.createDiv({ cls: "pmcn-toolbar-row" });
		const search = row1.createEl("input", {
			cls: "pmcn-search",
			attr: { type: "text", placeholder: "搜索名称、作者或描述…" },
		});
		search.addEventListener("input", () => {
			this.filterText = search.value.trim().toLowerCase();
			this.renderList();
		});

		const refreshBtn = row1.createEl("button", { text: "刷新" });
		refreshBtn.addEventListener("click", () => void this.reloadCatalog(true));

		const row2 = toolbar.createDiv({ cls: "pmcn-toolbar-row" });
		this.tabsEl = row2.createDiv({ cls: "pmcn-tabs" });
		this.buildTabs();

		this.nodeStatusEl = row2.createDiv({ cls: "pmcn-node-status" });
		this.renderNodeStatus("connecting");

		// 「已安装」专属操作条：检查更新 / 一键全部更新
		this.updateBarEl = toolbar.createDiv({
			cls: "pmcn-toolbar-row pmcn-update-bar",
		});
		this.checkBtn = this.updateBarEl.createEl("button", { text: "检查更新" });
		this.checkBtn.addEventListener("click", () => void this.runUpdateCheck(true));
		this.updateAllBtn = this.updateBarEl.createEl("button", {
			text: "全部更新",
			cls: "mod-cta",
		});
		this.updateAllBtn.addEventListener("click", () => void this.runUpdateAll());
		this.updateStatusEl = this.updateBarEl.createDiv({
			cls: "pmcn-update-status",
		});
		this.renderUpdateBar();
	}

	private buildTabs(): void {
		this.tabsEl.empty();
		const tabs: { key: TabKey; label: string }[] = [
			{ key: "all", label: "全部" },
			{ key: "installed", label: "已安装" },
			{ key: "special", label: "额外收录" },
		];
		for (const t of tabs) {
			const el = this.tabsEl.createDiv({
				cls: "pmcn-tab" + (this.activeTab === t.key ? " is-active" : ""),
				text: t.label,
			});
			el.addEventListener("click", () => {
				this.activeTab = t.key;
				this.buildTabs();
				this.renderUpdateBar();
				this.renderList();
				// 首次进「已安装」（或缓存过期）时自动查一次，不打扰其它 tab
				if (t.key === "installed") void this.runUpdateCheck(false);
			});
		}
	}

	/**
	 * 只显示通用加速状态，不暴露具体加速节点。
	 * 🔴 「已连接」必须以**真的拿到了插件列表**为准：registry.load 在所有线路都失败时
	 * 也会正常返回（config 退空、清单退 []），拿它 resolve 当成功就是骗用户。
	 */
	private renderNodeStatus(state: "connecting" | "ok" | "fail"): void {
		this.nodeStatusEl.empty();
		this.nodeStatusEl.createSpan({
			cls:
				"pmcn-node-dot" +
				(state === "ok" ? " is-ok" : state === "fail" ? " is-fail" : ""),
		});
		this.nodeStatusEl.createSpan({
			text:
				state === "ok"
					? "加速线路已连接"
					: state === "fail"
						? "加速线路连接失败"
						: "正在连接加速线路…",
		});
	}

	// ---------- 已安装插件的更新 ----------

	private renderUpdateBar(): void {
		if (!this.updateBarEl) return;
		this.updateBarEl.toggleClass("is-hidden", this.activeTab !== "installed");
		const checking = this.plugin.updateChecker.isRunning();
		const updatable = this.plugin.updateChecker.listUpdatable();
		// ⚠️ 每装完一个都会 refresh() 回到这里；不看 batchUpdating 的话，
		// 剩余计数 >0 会把按钮重新点亮，用户再点一下就是两批并发装。
		this.checkBtn.disabled = checking || this.batchUpdating;
		this.checkBtn.setText(checking ? "检查中…" : "检查更新");
		this.updateAllBtn.disabled =
			checking || this.batchUpdating || updatable.length === 0;
		this.updateAllBtn.setText(
			this.batchUpdating
				? "更新中…"
				: updatable.length > 0
					? `全部更新（${updatable.length}）`
					: "全部更新"
		);
		this.updateStatusEl.setText(
			this.updateStatusText(checking, updatable.length)
		);
	}

	private updateStatusText(checking: boolean, updatable: number): string {
		if (this.batchUpdating) {
			return this.batchTotal > 0
				? `正在更新 ${Math.min(this.batchDone + 1, this.batchTotal)}/${this.batchTotal}…`
				: "正在更新…";
		}
		if (checking) return "正在检查更新…";
		const { requested, resolved } = this.plugin.updateChecker.lastRoundStats();
		if (requested === 0) return "";
		const missed = Math.max(0, requested - resolved);
		const blocked = this.plugin.updateChecker.listBlocked().length;
		// 「未能获取最新版本」「需要更高版本 Obsidian」都是独立一档，
		// 绝不混进「没有可更新」里充数
		const tail =
			(missed > 0 ? `，另有 ${missed} 个未能获取最新版本` : "") +
			(blocked > 0 ? `，${blocked} 个新版需要更高版本 Obsidian` : "");
		return updatable > 0
			? `${updatable} 个插件可更新${tail}`
			: `未发现可更新的插件${tail}`;
	}

	private async runUpdateCheck(force: boolean): Promise<void> {
		this.renderUpdateBar();
		await this.plugin.checkInstalledUpdates(force);
		this.renderUpdateBar();
		this.renderList();
	}

	private async runUpdateAll(): Promise<void> {
		if (this.batchUpdating) return;
		this.batchUpdating = true;
		this.batchDone = 0;
		this.batchTotal = this.plugin.updateChecker.listUpdatable().length;
		this.renderUpdateBar();
		this.renderList(); // 卡片上的「更新」按钮同样要在批次期间失效
		try {
			await this.plugin.updateAllInstalled((done, total) => {
				this.batchDone = done;
				this.batchTotal = total;
				this.renderUpdateBar();
			});
		} finally {
			this.batchUpdating = false;
			this.batchDone = 0;
			this.batchTotal = 0;
			this.renderUpdateBar();
			this.renderList();
		}
	}

	private async reloadCatalog(force: boolean): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.listEl.empty();
		this.listEl.createDiv({ cls: "pmcn-empty", text: "正在加载插件列表…" });
		try {
			const result = await this.plugin.registry.load(this.plugin.settings, force);
			this.entries = result.entries;
			// 一条都没拿到 = 线路没通（或全被拉黑），不能算「已连接」
			this.renderNodeStatus(result.entries.length > 0 ? "ok" : "fail");
			this.renderList();
		} catch (e) {
			logError("加载清单失败:", e);
			this.renderNodeStatus("fail");
			this.listEl.empty();
			this.listEl.createDiv({
				cls: "pmcn-empty",
				text: `插件列表加载失败：${friendlyError(e)}`,
			});
		} finally {
			this.loading = false;
		}
	}

	/** 供外部（如调起链接安装后）刷新按钮态 */
	refresh(): void {
		this.renderUpdateBar();
		this.renderList();
	}

	/** 定位某个 id：设为搜索词并切到全部 */
	locate(id: string): void {
		this.activeTab = "all";
		this.filterText = id.toLowerCase();
		this.buildTabs();
		this.renderUpdateBar();
		this.renderList();
	}

	private visibleEntries(): MarketEntry[] {
		return this.entries.filter((e) => {
			if (this.activeTab === "special" && e.source !== "special") return false;
			if (this.activeTab === "installed") {
				if (!this.plugin.getInstalledState(e.id).installed) return false;
			}
			if (this.filterText) {
				const hay = (
					e.id +
					" " +
					e.name +
					" " +
					e.author +
					" " +
					e.description
				).toLowerCase();
				if (!hay.includes(this.filterText)) return false;
			}
			return true;
		});
	}

	private renderList(): void {
		this.listEl.empty();
		const items = this.visibleEntries();
		if (items.length === 0) {
			this.listEl.createDiv({ cls: "pmcn-empty", text: this.emptyText() });
			return;
		}
		// 上限渲染，避免一次性渲染数千张卡顿
		const MAX = 300;
		for (const entry of items.slice(0, MAX)) {
			this.renderCard(entry);
		}
		if (items.length > MAX) {
			this.listEl.createDiv({
				cls: "pmcn-empty",
				text: `共 ${items.length.toLocaleString()} 个插件，仅显示前 ${MAX} 个。搜索关键词可查看其他插件`,
			});
		}
	}

	private emptyText(): string {
		if (this.filterText) return "没有匹配的插件，换个关键词试试";
		if (this.activeTab === "installed")
			return "本商店中暂无已安装的插件，可去「全部」浏览";
		if (this.activeTab === "special") {
			// 关掉开关和「确实没有条目」是两回事，别混成一句
			return this.plugin.settings.enableSpecialImports
				? "暂无额外收录的插件"
				: "「额外收录」已在设置中关闭，可去设置里开启";
		}
		return "没有加载到插件，点「刷新」重试";
	}

	private renderCard(entry: MarketEntry): void {
		const card = this.listEl.createDiv({ cls: "pmcn-card" });
		const state = this.plugin.getInstalledState(entry.id);
		const cached = this.plugin.updateChecker.get(entry.id);
		// 缓存结论是拿「当时的已装版本」算的：这期间插件可能被别的途径升级过，
		// 版本对不上就当没查过，绝不拿它渲染「可更新」按钮
		const info =
			cached && cached.installedVersion === state.version ? cached : undefined;
		const canUpdate = state.installed && !!info?.hasUpdate;

		const title = card.createDiv({ cls: "pmcn-card-title" });
		title.createSpan({ text: entry.name });
		if (entry.source === "special") {
			title.createSpan({ cls: "pmcn-badge is-special", text: "额外收录" });
		}
		if (entry.deprecated) {
			title.createSpan({ cls: "pmcn-badge is-deprecated", text: "已弃用" });
		}
		if (entry.pinned) {
			// pinned 只是服务端置顶排序，不代表产品背书，别写成「推荐」
			title.createSpan({ cls: "pmcn-badge", text: "置顶" });
		}
		if (canUpdate) {
			title.createSpan({ cls: "pmcn-badge is-update", text: "可更新" });
		}
		if (state.installed && !state.enabled) {
			title.createSpan({ cls: "pmcn-badge", text: "已停用" });
		}

		card.createDiv({ cls: "pmcn-card-author", text: `作者：${entry.author}` });
		card.createDiv({ cls: "pmcn-card-desc", text: entry.description });

		if (state.installed) {
			card.createDiv({ cls: "pmcn-card-state", text: this.stateLine(entry, state, info) });
		}

		const footer = card.createDiv({ cls: "pmcn-card-footer" });
		footer.createSpan({
			cls: "pmcn-downloads",
			text:
				entry.downloads != null
					? `${entry.downloads.toLocaleString()} 次下载`
					: "",
		});

		const mode: InstallMode = canUpdate
			? "update"
			: state.installed
				? "reinstall"
				: "install";
		const btn = footer.createEl("button", { text: MODE_LABEL[mode] });
		if (mode !== "reinstall") btn.addClass("mod-cta");
		btn.disabled = this.batchUpdating;
		btn.addEventListener("click", () => {
			void this.handleInstallClick(btn, entry, mode);
		});
	}

	/**
	 * 已安装卡片的版本行。四种状态各自说清楚，**不把「没查到」说成「已是最新」**：
	 * 未检查 / 可更新 / 已是最新 / 未能获取最新版。
	 */
	private stateLine(
		entry: MarketEntry,
		state: { version?: string },
		info: EntryUpdateInfo | undefined
	): string {
		if (!state.version) return "已安装（版本未知）";
		const cur = `已安装 v${state.version}`;
		if (info?.hasUpdate) return `${cur} → 最新 v${info.latestVersion}`;
		// 有新版但当前 Obsidian 太旧：如实说明为什么没给更新按钮
		if (info?.blockedByAppVersion)
			return `${cur}（新版 v${info.latestVersion} 需 Obsidian ${info.minAppVersion}+）`;
		if (info) return `${cur}（已是最新）`;
		// 本插件自己走自更新，从不进这轮检查，别给它扣「未能获取」
		const checked =
			this.plugin.updateChecker.lastRoundStats().requested > 0 &&
			entry.id !== this.plugin.manifest.id;
		return checked ? `${cur}（未能获取最新版）` : cur;
	}

	private async handleInstallClick(
		btn: HTMLButtonElement,
		entry: MarketEntry,
		mode: InstallMode
	): Promise<void> {
		btn.disabled = true;
		btn.setText(`${MODE_LABEL[mode]}中…`);
		await this.plugin.installMarketEntry(entry, { mode });
		btn.disabled = false;
		this.renderUpdateBar();
		this.renderList();
	}
}
