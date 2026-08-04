/**
 * updateChecker — 已安装插件的「有没有新版本」检查。
 *
 * 与 src/updater/（本插件自更新）是两码事：那个只管 china-speedup 自己，
 * 这个管用户 vault 里由商店/官方装的**其它**插件。
 *
 * 版本来源与 installer 取版本走同一条路，保证「查到的版本」= 「点更新会装到的版本」：
 *  - repo 条目：<base>/gh/raw/<repo>/HEAD/manifest.json 的 version
 *  - special 直链：entry.manifestUrl 的 version（与 base 无关，只请求一次）
 *
 * 🔴 宁可不报，绝不误报：查不到 / 线路全挂 / manifest 里 id 对不上，一律当作
 *    「未知」不产出结论，绝不显示成「可更新」——用户看到假的更新提示比看不到更糟。
 */

import { log } from "./logger";
import { rawHeadManifestUrl } from "./installer";
import { isNewerVersion, compareVersions } from "./updater";
import type { MarketEntry, ObsidianManifest } from "./types";

export interface UpdateCheckNet {
	getText(url: string): Promise<{ status: number; text: string }>;
}

/** 一条待检查的已安装插件：商店条目 + 本地已装版本 */
export interface UpdateCandidate {
	entry: MarketEntry;
	installedVersion: string;
}

/** 单条检查结论（只有真查到远端版本才会产出） */
export interface EntryUpdateInfo {
	id: string;
	installedVersion: string;
	latestVersion: string;
	hasUpdate: boolean;
	/** 新版声明的最低 Obsidian 版本 */
	minAppVersion?: string;
	/** 有新版但当前 Obsidian 太旧装不了 —— 此时 hasUpdate 必须为 false */
	blockedByAppVersion?: boolean;
}

/** 远端 manifest 里我们关心的几项 */
export interface RemoteManifestInfo {
	version: string;
	minAppVersion?: string;
	/** 新版是否只支持桌面端（手机上装了会加载不了） */
	isDesktopOnly?: boolean;
}

/** 检查结果缓存有效期（30 分钟） */
export const UPDATE_CHECK_TTL_MS = 30 * 60 * 1000;
/** 并发检查数：太大在弱网/relay 上会互相拖慢，4 条足够 */
export const DEFAULT_CHECK_CONCURRENCY = 4;
/**
 * 确认「没有新版」时最多问几条线路。
 * 问 2 条能挡住「首条线路缓存滞后」，又不会在服务端加到 5 条 relay 时
 * 让一次检查变成 5×N 个请求（失败的线路不算数，仍会继续往下试）。
 */
export const MAX_CONFIRM_BASES = 2;

/** 该条目「取最新版本号」的候选 URL（按线路顺序；直链只有一个） */
export const latestVersionUrls = (
	entry: MarketEntry,
	bases: readonly string[]
): string[] => {
	// special 直链：URL 与加速线路无关，重复请求同一个地址没有意义
	if (entry.source === "special" && entry.manifestUrl && entry.assetBase) {
		return [entry.manifestUrl];
	}
	const repo = entry.repo;
	if (!repo) return [];
	return bases.map((b) => rawHeadManifestUrl(b, repo));
};

/**
 * 取某条目的最新版本信息。查不到返回 null（= 未知，调用方不得当成「已是最新」，
 * 更不得当成「可更新」）。
 *
 * `stopWhenNewerThan` 给了就是「够用即止」：某条线路已经报出比它新的版本就直接返回；
 * 否则**继续问完其余线路取最大值** —— 首条线路的 HEAD 缓存可能滞后，只信它会把
 * 「其实有新版」误判成「已是最新」（codex 2026-08-04）。
 */
export const fetchLatestVersion = async (
	entry: MarketEntry,
	bases: readonly string[],
	net: UpdateCheckNet,
	stopWhenNewerThan?: string
): Promise<RemoteManifestInfo | null> => {
	let best: RemoteManifestInfo | null = null;
	let answered = 0;
	for (const url of latestVersionUrls(entry, bases)) {
		let text: string;
		try {
			const r = await net.getText(url);
			if (r.status !== 200) continue; // 这条线路不行，换下一条
			text = r.text;
		} catch {
			continue;
		}
		let manifest: ObsidianManifest;
		try {
			manifest = JSON.parse(text) as ObsidianManifest;
		} catch {
			continue; // relay 返回了错误页而不是 manifest，换下一条线路
		}
		// id 对不上 = 供应链信号，换线路再试只是「碰运气换个答案」，直接判未知。
		// 缺 id 同样不可验证（Obsidian manifest 必带 id），按未知处理而不是照单全收。
		if (manifest.id !== entry.id) return null;
		// 缺 version 多半是这条线路返回了残缺/被改写的内容，换下一条（同坏 JSON 处理）
		if (typeof manifest.version !== "string" || !manifest.version) continue;
		const info: RemoteManifestInfo = {
			version: manifest.version,
			minAppVersion:
				typeof manifest.minAppVersion === "string"
					? manifest.minAppVersion
					: undefined,
			isDesktopOnly: manifest.isDesktopOnly === true,
		};
		if (!best || compareVersions(info.version, best.version) > 0) best = info;
		// 已经拿到比本地新的版本，没必要再问其余线路
		if (stopWhenNewerThan && isNewerVersion(best.version, stopWhenNewerThan)) {
			return best;
		}
		// 只有「真答上来的」线路计入配额；挂掉的线路不占名额，继续往下试
		if (++answered >= MAX_CONFIRM_BASES) return best;
	}
	return best;
};

/**
 * 并发检查一批已安装插件。查不到版本的条目**不产出结论**（不进返回数组）。
 */
export const checkUpdates = async (
	candidates: readonly UpdateCandidate[],
	bases: readonly string[],
	net: UpdateCheckNet,
	opts: {
		concurrency?: number;
		onEach?: (info: EntryUpdateInfo) => void;
		/** 当前 Obsidian 版本（obsidian 的 apiVersion）；给了才做兼容性判断 */
		appVersion?: string;
		/** 当前是否手机端（Platform.isMobile）；给了才拦 desktop-only 的新版 */
		isMobile?: boolean;
	} = {}
): Promise<EntryUpdateInfo[]> => {
	const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CHECK_CONCURRENCY);
	const results: EntryUpdateInfo[] = [];
	let cursor = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const i = cursor++;
			if (i >= candidates.length) return;
			const c = candidates[i];
			let latest: RemoteManifestInfo | null = null;
			try {
				latest = await fetchLatestVersion(
					c.entry,
					bases,
					net,
					c.installedVersion
				);
			} catch {
				latest = null;
			}
			if (!latest) continue; // 未知 → 不报
			// 🔴 新版要求的 Obsidian 比用户的新 → 装了会加载不了，且旧版已被覆盖。
			//    这种「更新」只会把能用的插件弄坏，不能提示成可更新。
			const blocked =
				!!(
					opts.appVersion &&
					latest.minAppVersion &&
					compareVersions(latest.minAppVersion, opts.appVersion) > 0
				) ||
				// 手机端 + 新版改成 desktop-only：装上去就加载不了
				!!(opts.isMobile && latest.isDesktopOnly);
			const info: EntryUpdateInfo = {
				id: c.entry.id,
				installedVersion: c.installedVersion,
				latestVersion: latest.version,
				hasUpdate: !blocked && isNewerVersion(latest.version, c.installedVersion),
				minAppVersion: latest.minAppVersion,
				blockedByAppVersion:
					blocked && isNewerVersion(latest.version, c.installedVersion),
			};
			results.push(info);
			opts.onEach?.(info);
		}
	};

	const workers = Array.from(
		{ length: Math.min(concurrency, candidates.length) },
		() => worker()
	);
	await Promise.all(workers);
	return results;
};

/**
 * 检查结果的持有者：带 TTL 缓存 + 单飞（同一时刻只跑一轮）。
 * 时间由调用方注入（now 参数），便于单测。
 */
export class UpdateChecker {
	private results = new Map<string, EntryUpdateInfo>();
	private checkedAt = 0;
	private running = false;
	/** 上一轮实际拿到结论的条目数（用于「N 个插件没查到」这类如实文案） */
	private lastResolved = 0;
	private lastRequested = 0;

	isRunning(): boolean {
		return this.running;
	}

	/** 从没查过，或缓存已过期 */
	isStale(now: number): boolean {
		return this.checkedAt === 0 || now - this.checkedAt >= UPDATE_CHECK_TTL_MS;
	}

	get(id: string): EntryUpdateInfo | undefined {
		return this.results.get(id);
	}

	listUpdatable(): EntryUpdateInfo[] {
		return Array.from(this.results.values()).filter((r) => r.hasUpdate);
	}

	/** 有新版、但当前 Obsidian 太旧装不了的条目 */
	listBlocked(): EntryUpdateInfo[] {
		return Array.from(this.results.values()).filter(
			(r) => r.blockedByAppVersion
		);
	}

	lastRoundStats(): { requested: number; resolved: number } {
		return { requested: this.lastRequested, resolved: this.lastResolved };
	}

	/**
	 * 更新成功后本地纠正，避免卡片继续挂着「可更新」。
	 *
	 * ⚠️ 只在**查过**（有 prev）时改写结论；没查过就直接删掉——凭一次安装就写下
	 * 「latest == 刚装的版本」等于伪造了一个没做过的检查，卡片会显示「已是最新」。
	 */
	markUpdated(id: string, version: string): void {
		const prev = this.results.get(id);
		if (!prev) {
			this.results.delete(id);
			return;
		}
		this.results.set(id, {
			...prev,
			installedVersion: version,
			hasUpdate: isNewerVersion(prev.latestVersion, version),
			blockedByAppVersion:
				prev.blockedByAppVersion && isNewerVersion(prev.latestVersion, version),
		});
	}

	/** 条目从 vault 里消失（卸载）后清掉，别留幽灵结论 */
	forget(id: string): void {
		this.results.delete(id);
	}

	/**
	 * 用当前候选复核缓存：不在候选里（已卸载）、或已装版本变了（被别的途径升级过）
	 * 的结论一律丢弃 —— 它们是拿旧事实算出来的，留着就会误报。
	 */
	reconcile(candidates: readonly UpdateCandidate[]): number {
		const cur = new Map(candidates.map((c) => [c.entry.id, c.installedVersion]));
		let dropped = 0;
		for (const [id, info] of Array.from(this.results.entries())) {
			const installed = cur.get(id);
			if (installed === undefined || installed !== info.installedVersion) {
				this.results.delete(id);
				dropped++;
			}
		}
		return dropped;
	}

	clear(): void {
		this.results.clear();
		this.checkedAt = 0;
		this.lastResolved = 0;
		this.lastRequested = 0;
	}

	/**
	 * 跑一轮检查。force=false 且缓存新鲜 → 直接返回缓存里的可更新列表。
	 * 已在跑 → 返回 null（调用方按「正在检查」处理，不要重复发起）。
	 */
	async run(
		candidates: readonly UpdateCandidate[],
		bases: readonly string[],
		net: UpdateCheckNet,
		now: number,
		opts: {
			force?: boolean;
			concurrency?: number;
			onEach?: (info: EntryUpdateInfo) => void;
			appVersion?: string;
			isMobile?: boolean;
		} = {}
	): Promise<EntryUpdateInfo[] | null> {
		if (this.running) return null;
		if (!opts.force && !this.isStale(now)) {
			// 缓存里的结论是拿「当时的已装版本」算的：这 30 分钟里插件可能被别的
			// 途径升级/卸载了，先按当前候选复核，过时的直接丢掉（宁可不报）。
			// 丢掉过就说明前提变了 → 必须重查，否则「刚被清空的缓存」会被当成
			// 「没有更新」，把真实存在的新版藏满一个 TTL。
			const dropped = this.reconcile(candidates);
			const missing = candidates.some((c) => !this.results.has(c.entry.id));
			if (dropped === 0 && !missing) return this.listUpdatable();
		}
		this.running = true;
		try {
			const found = await checkUpdates(candidates, bases, net, {
				concurrency: opts.concurrency,
				// ⚠️ 必须传下去：漏了它 blockedByAppVersion 永远为 false，
				// 兼容性闸门就成了「写了但从不生效」的死代码（codex 2026-08-04 抓到）
				appVersion: opts.appVersion,
				onEach: (info) => {
					this.results.set(info.id, info);
					opts.onEach?.(info);
				},
			});
			// 只保留「本轮候选 ∩ 本轮查到结论」的条目：
			//  - 不在候选里（插件已被卸载）→ 留着会让「全部更新」把用户删掉的插件装回来
			//  - 在候选里但没查到 → 留着等于拿过期数据继续报「可更新」
			const resolved = new Set(found.map((f) => f.id));
			for (const id of Array.from(this.results.keys())) {
				if (!resolved.has(id)) this.results.delete(id);
			}
			this.checkedAt = now;
			this.lastRequested = candidates.length;
			this.lastResolved = found.length;
			log(
				"🔍 [updateChecker] 检查完成:",
				found.length,
				"/",
				candidates.length,
				"可更新",
				found.filter((f) => f.hasUpdate).length
			);
			return this.listUpdatable();
		} finally {
			this.running = false;
		}
	}
}
