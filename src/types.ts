/**
 * 共享类型契约。所有模块依赖本文件，避免类型漂移。
 */

/** relay 加速节点（来自 marketplace-config.relays，bootstrap 兜底硬编码 relay-1/2） */
export interface RelayNode {
	id: string;
	/** 不含末尾斜杠的 base，如 https://relay-1.bijitongbu.site */
	base: string;
	/** 权重（预留，当前仅用于稳定排序） */
	weight?: number;
	/** 是否启用；false 的节点不参与探测 */
	enabled?: boolean;
}

/** 特殊导入条目：官方清单里没有、由服务端配置注入的非官方插件 */
export interface SpecialImport {
	id: string;
	name: string;
	author: string;
	description: string;
	/** 若托管在 GitHub release，则给 owner/name，走 relay /gh 代理下载 */
	repo?: string;
	/** 直接给 manifest.json 完整 URL（必须是产品自有白名单域） */
	manifestUrl?: string;
	/** 资产基址（main.js/styles.css 同目录，必须是产品自有白名单域），结尾带斜杠 */
	assetBase?: string;
	minAppVersion?: string;
	/** 标注用：是否为测试/前沿包 */
	channel?: "stable" | "test";
}

/** 服务端唯一可热更新出口：黑名单 + 特殊导入 + relay 节点列表 */
export interface MarketplaceConfig {
	version: number;
	updatedAt?: string;
	relays: RelayNode[];
	/** 官方清单基址（relay 上的 /gh/raw 前缀指向 obsidianmd/obsidian-releases） */
	officialIndex?: { base: string };
	/** 黑名单插件 id：从官方全量中剔除 */
	blacklist: string[];
	/** 特殊导入插件 */
	specialImports: SpecialImport[];
	/** 置顶插件 id */
	pinned?: string[];
}

/** 官方 community-plugins.json 的单条 */
export interface OfficialPlugin {
	id: string;
	name: string;
	author: string;
	description: string;
	repo: string;
}

/** 官方 community-plugin-stats.json：id -> { downloads, updated, [version]: count } */
export type PluginStats = Record<
	string,
	{ downloads?: number; updated?: number } & Record<string, number>
>;

/** 官方 community-plugin-deprecation.json：id -> 替代说明 */
export type DeprecationMap = Record<string, unknown>;

/** 合并后用于渲染的单条插件 */
export interface MarketEntry {
	id: string;
	name: string;
	author: string;
	description: string;
	repo?: string;
	source: "official" | "special";
	downloads?: number;
	deprecated?: boolean;
	pinned?: boolean;
	/** special 专用 */
	manifestUrl?: string;
	assetBase?: string;
	minAppVersion?: string;
	channel?: "stable" | "test";
}

/** Obsidian 插件 manifest.json 的最小形态 */
export interface ObsidianManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion?: string;
	description?: string;
	author?: string;
	[k: string]: unknown;
}

/** 已安装插件的状态（用于 UI 按钮态） */
export interface InstalledState {
	installed: boolean;
	enabled: boolean;
	version?: string;
	hasUpdate?: boolean;
}

/** 插件设置 */
export interface PluginMarketSettings {
	/** 是否启用特殊导入条目展示/安装 */
	enableSpecialImports: boolean;
	/** 是否启用 obsidian:// 调起链接 */
	enableDeeplink: boolean;
	/** 是否启用插件自更新 */
	enableSelfUpdate: boolean;
	/** 高级：自定义 marketplace-config.json URL（必须白名单域） */
	customConfigUrl: string;
	/** 上次选中的最快节点（仅展示用，真值在 localStorage 缓存） */
	lastFastestBase: string;
}

export const DEFAULT_SETTINGS: PluginMarketSettings = {
	enableSpecialImports: true,
	enableDeeplink: true,
	enableSelfUpdate: true,
	customConfigUrl: "",
	lastFastestBase: "",
};
