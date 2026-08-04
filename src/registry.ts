/**
 * registry — 拉取并合并插件清单。
 *
 * 数据来源：
 *  1. marketplace-config.json（relay 上 /plugin-market/，服务端唯一热更新出口）
 *     —— 黑名单 / 特殊导入 / relay 节点列表
 *  2. 官方 obsidianmd/obsidian-releases 的 community-plugins.json / stats / deprecation
 *     —— 经 relay 的 /gh/raw 代理加速
 *
 * 合并规则：official.filter(!blacklist) ∪ specialImports（special 同 id 覆盖 official）。
 */

import { requestUrl } from "obsidian";
import { log, logError } from "./logger";
import { isAllowedUrl } from "./whitelist";
import {
	getOrderedFallbackBases,
	relaysToBases,
	notifyRequestFailure,
	notifyRequestSuccess,
} from "./relaySelector";
import type {
	MarketplaceConfig,
	OfficialPlugin,
	PluginStats,
	DeprecationMap,
	MarketEntry,
	SpecialImport,
	RelayNode,
	PluginMarketSettings,
} from "./types";

export const CONFIG_PATH = "/plugin-market/marketplace-config.json";
export const DEFAULT_OFFICIAL_INDEX_BASE =
	"/gh/raw/obsidianmd/obsidian-releases/HEAD";
const COMMUNITY_PLUGINS = "community-plugins.json";
const COMMUNITY_STATS = "community-plugin-stats.json";
const COMMUNITY_DEPRECATION = "community-plugin-deprecation.json";

const CATALOG_TTL_MS = 5 * 60 * 1000;

export interface RegistryNet {
	getJson(url: string): Promise<{ status: number; json: unknown }>;
}

const defaultNet: RegistryNet = {
	async getJson(url: string) {
		const r = await requestUrl({
			url,
			method: "GET",
			headers: { "Content-Type": "application/json" },
		});
		return { status: r.status, json: r.json };
	},
};

/** 把 path（相对 /xxx 或绝对 http...）解析成完整 URL */
export const resolveUrl = (base: string, path: string): string => {
	if (/^https?:\/\//i.test(path)) return path;
	const b = base.replace(/\/+$/, "");
	const p = path.startsWith("/") ? path : "/" + path;
	return b + p;
};

/** 校验单条特殊导入是否合法可用 */
export const validateSpecialImport = (
	s: SpecialImport
): { ok: boolean; reason?: string } => {
	if (!s.id || !s.name) return { ok: false, reason: "missing id/name" };
	// 必须有获取途径：repo（走 relay /gh）或 manifestUrl+assetBase（白名单域）
	if (s.repo) return { ok: true };
	if (s.manifestUrl || s.assetBase) {
		if (s.manifestUrl && !isAllowedUrl(s.manifestUrl))
			return { ok: false, reason: "manifestUrl not whitelisted/https" };
		if (s.assetBase && !isAllowedUrl(s.assetBase))
			return { ok: false, reason: "assetBase not whitelisted/https" };
		if (!s.manifestUrl || !s.assetBase)
			return { ok: false, reason: "need both manifestUrl and assetBase" };
		return { ok: true };
	}
	return { ok: false, reason: "no repo nor manifestUrl/assetBase" };
};

/**
 * 纯合并函数（便于单测）。
 */
export const mergeCatalog = (
	official: OfficialPlugin[],
	stats: PluginStats,
	deprecation: DeprecationMap,
	config: MarketplaceConfig,
	opts: { enableSpecialImports: boolean }
): MarketEntry[] => {
	const blacklist = new Set(config.blacklist || []);
	const pinned = new Set(config.pinned || []);
	// 用 own keys 建集合：`id in deprecation` 会把 constructor/toString
	// 这类原型链继承属性误判成「已弃用」
	const deprecated = new Set(Object.keys(deprecation || {}));
	const byId = new Map<string, MarketEntry>();

	for (const p of official) {
		if (!p || !p.id) continue;
		if (blacklist.has(p.id)) continue;
		byId.set(p.id, {
			id: p.id,
			name: p.name,
			author: p.author,
			description: p.description,
			repo: p.repo,
			source: "official",
			downloads: stats[p.id]?.downloads,
			deprecated: deprecated.has(p.id),
			pinned: pinned.has(p.id),
		});
	}

	if (opts.enableSpecialImports) {
		for (const s of config.specialImports || []) {
			const v = validateSpecialImport(s);
			if (!v.ok) {
				logError("特殊导入条目无效，跳过:", s.id, v.reason);
				continue;
			}
			// special 同 id 覆盖 official（服务端意图）
			byId.set(s.id, {
				id: s.id,
				name: s.name,
				author: s.author,
				description: s.description,
				repo: s.repo,
				source: "special",
				manifestUrl: s.manifestUrl,
				assetBase: s.assetBase,
				minAppVersion: s.minAppVersion,
				channel: s.channel,
				pinned: pinned.has(s.id),
			});
		}
	}

	const entries = Array.from(byId.values());
	entries.sort((a, b) => {
		if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
		const da = a.downloads ?? -1;
		const db = b.downloads ?? -1;
		if (da !== db) return db - da;
		return a.name.localeCompare(b.name);
	});
	return entries;
};

export interface CatalogResult {
	entries: MarketEntry[];
	config: MarketplaceConfig;
	base: string;
	/**
	 * 官方 community-plugins.json 是否真的取到了。
	 * 取不到时 entries 可能仍非空（只剩特殊导入），调用方**不能**把「非空」
	 * 当成「清单健康」——那会把网络故障误报成「没有插件需要处理」。
	 */
	officialOk: boolean;
}

const FALLBACK_CONFIG: MarketplaceConfig = {
	version: 0,
	relays: [],
	blacklist: [],
	specialImports: [],
};

export class Registry {
	private net: RegistryNet;
	private cache: CatalogResult | null = null;
	private cachedAt = 0;
	/** 上一次配置里的 relays，给下一轮选节点用（服务端热加节点） */
	private knownRelays: RelayNode[] = [];

	constructor(net: RegistryNet = defaultNet) {
		this.net = net;
	}

	getKnownRelays(): RelayNode[] {
		return this.knownRelays;
	}

	/** 逐 base 尝试取 JSON，首个 200 胜；全失败抛错 */
	private async fetchFirst(
		bases: string[],
		path: string
	): Promise<unknown> {
		let lastErr: unknown = null;
		for (const base of bases) {
			const url = resolveUrl(base, path);
			try {
				const r = await this.net.getJson(url);
				if (r.status === 200 && r.json != null) {
					notifyRequestSuccess();
					return r.json;
				}
				lastErr = new Error(`status=${r.status} @ ${url}`);
			} catch (e) {
				lastErr = e;
			}
		}
		notifyRequestFailure();
		throw lastErr instanceof Error
			? lastErr
			: new Error("all bases failed for " + path);
	}

	private async fetchConfig(
		bases: string[],
		customConfigUrl: string
	): Promise<MarketplaceConfig> {
		// 高级：用户自定义 config URL（必须白名单 https）
		if (customConfigUrl) {
			if (!isAllowedUrl(customConfigUrl)) {
				logError("自定义 config URL 非白名单，忽略:", customConfigUrl);
			} else {
				try {
					const r = await this.net.getJson(customConfigUrl);
					if (r.status === 200 && r.json) return r.json as MarketplaceConfig;
				} catch (e) {
					logError("自定义 config URL 取失败，回退默认:", e);
				}
			}
		}
		const json = await this.fetchFirst(bases, CONFIG_PATH);
		return json as MarketplaceConfig;
	}

	/**
	 * 拉取合并后的插件清单。force=true 跳过 5min 缓存。
	 */
	async load(
		settings: PluginMarketSettings,
		force = false
	): Promise<CatalogResult> {
		const now = Date.now();
		if (!force && this.cache && now - this.cachedAt < CATALOG_TTL_MS) {
			return this.cache;
		}

		// 1) bootstrap 候选 → 选最快 → 取 config
		const bootstrapBases = await getOrderedFallbackBases(
			relaysToBases(this.knownRelays)
		);
		let config: MarketplaceConfig;
		try {
			config = await this.fetchConfig(bootstrapBases, settings.customConfigUrl);
		} catch (e) {
			logError("取 marketplace-config 失败，用空配置:", e);
			config = { ...FALLBACK_CONFIG };
		}
		if (Array.isArray(config.relays) && config.relays.length) {
			this.knownRelays = config.relays;
		}

		// 2) 用 config.relays 重新定 base 顺序，取官方清单
		const bases = await getOrderedFallbackBases(relaysToBases(config.relays));
		const indexBase = config.officialIndex?.base || DEFAULT_OFFICIAL_INDEX_BASE;
		// indexBase 可能是相对(/gh/raw/...)或绝对(http...)。相对时由 fetchFirst 逐 base 前缀。
		const idxPath = (file: string): string =>
			/^https?:\/\//i.test(indexBase)
				? resolveUrl(indexBase, file)
				: indexBase.replace(/\/+$/, "") + "/" + file;

		const official = (await this.fetchFirst(
			bases,
			idxPath(COMMUNITY_PLUGINS)
		).catch((e) => {
			logError("取官方 community-plugins 失败:", e);
			return [] as OfficialPlugin[];
		})) as OfficialPlugin[];

		const stats = (await this.fetchFirst(bases, idxPath(COMMUNITY_STATS)).catch(
			() => ({})
		)) as PluginStats;

		const deprecation = (await this.fetchFirst(
			bases,
			idxPath(COMMUNITY_DEPRECATION)
		).catch(() => ({}))) as DeprecationMap;

		const entries = mergeCatalog(
			Array.isArray(official) ? official : [],
			stats || {},
			deprecation || {},
			config,
			{ enableSpecialImports: settings.enableSpecialImports }
		);

		const result: CatalogResult = {
			entries,
			config,
			base: bases[0],
			officialOk: Array.isArray(official) && official.length > 0,
		};
		this.cache = result;
		this.cachedAt = now;
		log("📦 registry 合并完成:", entries.length, "条，base=", bases[0]);
		return result;
	}

	invalidate(): void {
		this.cache = null;
		this.cachedAt = 0;
	}
}
