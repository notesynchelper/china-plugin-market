import { ItemView, WorkspaceLeaf } from "obsidian";
import type PluginMarketPlugin from "./main";
import type { MarketEntry } from "./types";
import { logError } from "./logger";

export const MARKET_VIEW_TYPE = "plugin-market-cn-view";

type TabKey = "all" | "installed" | "special";

export class MarketView extends ItemView {
	private plugin: PluginMarketPlugin;
	private entries: MarketEntry[] = [];
	private filterText = "";
	private activeTab: TabKey = "all";
	private loading = false;

	private listEl!: HTMLElement;
	private nodeStatusEl!: HTMLElement;
	private tabsEl!: HTMLElement;

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
			attr: { type: "text", placeholder: "搜索插件名 / 作者 / 描述…" },
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
		this.renderNodeStatus(false);
	}

	private buildTabs(): void {
		this.tabsEl.empty();
		const tabs: { key: TabKey; label: string }[] = [
			{ key: "all", label: "全部" },
			{ key: "installed", label: "已安装" },
			{ key: "special", label: "特殊导入" },
		];
		for (const t of tabs) {
			const el = this.tabsEl.createDiv({
				cls: "pmcn-tab" + (this.activeTab === t.key ? " is-active" : ""),
				text: t.label,
			});
			el.addEventListener("click", () => {
				this.activeTab = t.key;
				this.buildTabs();
				this.renderList();
			});
		}
	}

	private renderNodeStatus(ok: boolean): void {
		// 只显示通用加速状态，不暴露具体加速节点
		this.nodeStatusEl.empty();
		this.nodeStatusEl.createSpan({
			cls: "pmcn-node-dot" + (ok ? " is-ok" : ""),
		});
		this.nodeStatusEl.createSpan({
			text: ok ? "加速已连接" : "连接加速线路…",
		});
	}

	private async reloadCatalog(force: boolean): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.listEl.empty();
		this.listEl.createDiv({ cls: "pmcn-empty", text: "正在加载清单…" });
		try {
			const result = await this.plugin.registry.load(this.plugin.settings, force);
			this.entries = result.entries;
			this.renderNodeStatus(true);
			this.renderList();
		} catch (e) {
			logError("加载清单失败:", e);
			this.listEl.empty();
			this.listEl.createDiv({
				cls: "pmcn-empty",
				text: `加载失败：${e instanceof Error ? e.message : e}`,
			});
		} finally {
			this.loading = false;
		}
	}

	/** 供外部（如调起链接安装后）刷新按钮态 */
	refresh(): void {
		this.renderList();
	}

	/** 定位某个 id：设为搜索词并切到全部 */
	locate(id: string): void {
		this.activeTab = "all";
		this.filterText = id.toLowerCase();
		this.buildTabs();
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
			this.listEl.createDiv({ cls: "pmcn-empty", text: "没有匹配的插件" });
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
				text: `仅显示前 ${MAX} / ${items.length} 条，请用搜索缩小范围`,
			});
		}
	}

	private renderCard(entry: MarketEntry): void {
		const card = this.listEl.createDiv({ cls: "pmcn-card" });

		const title = card.createDiv({ cls: "pmcn-card-title" });
		title.createSpan({ text: entry.name });
		if (entry.source === "special") {
			title.createSpan({ cls: "pmcn-badge is-special", text: "特殊导入" });
		}
		if (entry.deprecated) {
			title.createSpan({ cls: "pmcn-badge is-deprecated", text: "已弃用" });
		}
		if (entry.pinned) {
			title.createSpan({ cls: "pmcn-badge", text: "置顶" });
		}

		card.createDiv({ cls: "pmcn-card-author", text: `作者：${entry.author}` });
		card.createDiv({ cls: "pmcn-card-desc", text: entry.description });

		const footer = card.createDiv({ cls: "pmcn-card-footer" });
		footer.createSpan({
			cls: "pmcn-downloads",
			text:
				entry.downloads != null
					? `↓ ${entry.downloads.toLocaleString()}`
					: entry.source === "special"
						? "第三方"
						: "",
		});

		const state = this.plugin.getInstalledState(entry.id);
		const btn = footer.createEl("button");
		if (state.installed) {
			btn.setText(state.enabled ? "重新安装" : "已安装·启用");
		} else {
			btn.setText("安装");
			btn.addClass("mod-cta");
		}
		btn.addEventListener("click", () => {
			void this.handleInstallClick(btn, entry);
		});
	}

	private async handleInstallClick(
		btn: HTMLButtonElement,
		entry: MarketEntry
	): Promise<void> {
		btn.disabled = true;
		btn.setText("安装中…");
		await this.plugin.installMarketEntry(entry);
		btn.disabled = false;
		this.renderList();
	}
}
