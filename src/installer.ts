/**
 * installer — 把一条插件装进 vault 的 .obsidian/plugins/<id>/ 并启用。
 *
 * 沿用 Obsidian 官方 / BRAT 的安装序列：
 *  1. 取最新版本号（repo 根 manifest.json#version；special 直链则由下载的 manifest 决定）
 *  2. 下载 manifest.json，校验 manifest.id === entry.id
 *  3. 下载 main.js（必需）+ styles.css（可缺）
 *  4. 写盘到 <configDir>/plugins/<id>/
 *  5. loadManifests → enablePluginAndSave
 *
 * 下载全部走 relay：
 *  - repo 插件：<base>/gh/raw/<repo>/HEAD/manifest.json 取版本；
 *               <base>/gh/release/<repo>/<ver>/<file> 取资产
 *  - special 直链：entry.manifestUrl + entry.assetBase（已在 registry 校验白名单）
 */

import { log } from "./logger";
import { compareVersions } from "./updater";
import type { MarketEntry, ObsidianManifest, InstalledState } from "./types";

export interface InstallerNet {
	getText(url: string): Promise<{ status: number; text: string }>;
}

export interface InstallerFs {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	write(path: string, data: string): Promise<void>;
}

export interface PluginsApi {
	manifests: Record<string, { version?: string } | undefined>;
	enabledPlugins: Set<string>;
	plugins: Record<string, unknown>;
	loadManifests(): Promise<void>;
	enablePluginAndSave(id: string): Promise<void>;
	disablePlugin(id: string): Promise<void>;
}

export interface InstallContext {
	net: InstallerNet;
	fs: InstallerFs;
	plugins: PluginsApi;
	/** 通常是 app.vault.configDir，默认 '.obsidian' */
	configDir: string;
}

export interface InstallOptions {
	/**
	 * 写盘后是否启用插件。默认 true（首次安装）。
	 * 更新一个**当前被用户停用**的插件时传 false —— 更新不该顺手把它打开，
	 * 那是替用户改配置。
	 */
	enable?: boolean;
	/**
	 * 🔴 更新闸：下载到的版本必须**严格新于**这个版本，否则中止、不写盘。
	 *
	 * 「更新」点下去却装了同一个版本（某条线路的 HEAD 缓存滞后），却弹「已更新至
	 * vX」并计入成功数 —— 那是骗用户。update 模式传已装版本，reinstall 用
	 * notOlderThan（允许等值重装）。
	 */
	mustBeNewerThan?: string;
	/**
	 * 🔴 防降级闸：下载到的版本若比这个旧，直接中止、不写盘。
	 *
	 * 版本是**按线路各自解析**的（每条 base 读自己的 HEAD manifest）：线路 A 说
	 * 有 2.0.0、但它的 /gh/release 挂了落到线路 B，而 B 的缓存还停在 1.x —— 
	 * 没有这道闸就会把用户已装的新版**悄悄降级**。更新/重装时传已装版本。
	 */
	notOlderThan?: string;
	/** 当前是否移动端（Platform.isMobile）；给了才拦 isDesktopOnly 的新版 */
	isMobile?: boolean;
	/**
	 * 🔴 兼容性闸：下载到的 manifest 若要求比这个更高的 Obsidian，中止、不写盘。
	 *
	 * 检查阶段已经滤过一轮，但两者之间可能变（换线路拿到别的 manifest / 上游刚发新版），
	 * 而写盘是**不可逆**的：覆盖后旧的可用版本就没了。落地前必须再验一次。
	 */
	appVersion?: string;
}

const RELEASE_FILES = {
	manifest: "manifest.json",
	main: "main.js",
	styles: "styles.css",
} as const;

/** repo 模式下，拼 release 资产 URL */
export const releaseAssetUrl = (
	base: string,
	repo: string,
	version: string,
	file: string
): string => `${base.replace(/\/+$/, "")}/gh/release/${repo}/${version}/${file}`;

/** repo 模式下，取版本号用的 raw HEAD manifest URL */
export const rawHeadManifestUrl = (base: string, repo: string): string =>
	`${base.replace(/\/+$/, "")}/gh/raw/${repo}/HEAD/${RELEASE_FILES.manifest}`;

export const pluginFolder = (configDir: string, id: string): string =>
	`${configDir.replace(/\/+$/, "")}/plugins/${id}`;

/** 已安装状态（给 UI 按钮态用） */
export const getInstalledState = (
	id: string,
	plugins: PluginsApi
): InstalledState => {
	const manifest = plugins.manifests[id];
	return {
		installed: !!manifest,
		enabled: plugins.enabledPlugins.has(id),
		version: manifest?.version,
	};
};

/**
 * 换 base 重试也救不了的硬失败：id 不匹配（供应链红线）、条目本身缺信息。
 * 与「网络/上游抖动」区分开——后者才值得换下一个 base 再试。
 */
export class InstallAbortError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InstallAbortError";
	}
}

/**
 * 这条线路给的版本不满足「必须更新」要求（多半是它的 HEAD 缓存滞后）。
 * 属于**可换线路重试**的失败：别的线路可能就有新版。
 */
export class StaleVersionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StaleVersionError";
	}
}

/** 所有候选线路的下载都失败（区别于「id 不匹配」「写盘失败」，只有它代表线路问题） */
export class AllBasesFailedError extends Error {
	readonly lastError: unknown;
	constructor(message: string, lastError: unknown) {
		super(message);
		this.name = "AllBasesFailedError";
		this.lastError = lastError;
	}
}

/** 一次安装所需的全部内容，下载阶段产出，写盘阶段消费 */
export interface InstallPayload {
	manifestText: string;
	manifest: ObsidianManifest;
	mainText: string;
	stylesText: string | null;
	direct: boolean;
}

/**
 * 下载阶段（纯网络，可换 base 重试）：取版本 → 下载三件套 → 校验。
 * 不碰磁盘、不动插件状态，失败可以安全地在另一个 base 上重来。
 */
export const fetchInstallPayload = async (
	entry: MarketEntry,
	base: string,
	net: InstallerNet,
	opts: InstallOptions = {}
): Promise<InstallPayload> => {
	let manifestUrl: string;
	let mainUrl: string;
	let stylesUrl: string;

	const useDirect = !!(
		entry.source === "special" &&
		entry.manifestUrl &&
		entry.assetBase
	);

	if (useDirect) {
		// special 直链（registry 已校验白名单 https）
		const assetBase = entry.assetBase!.replace(/\/+$/, "") + "/";
		manifestUrl = entry.manifestUrl!;
		mainUrl = assetBase + RELEASE_FILES.main;
		stylesUrl = assetBase + RELEASE_FILES.styles;
	} else {
		// repo 模式：先取最新版本号
		const repo = entry.repo;
		if (!repo)
			throw new InstallAbortError(
				`插件 ${entry.id} 缺少 repo / 直链信息，无法安装`
			);
		const headManifest = await fetchTextOk(net, rawHeadManifestUrl(base, repo));
		let headParsed: ObsidianManifest;
		try {
			headParsed = JSON.parse(headManifest) as ObsidianManifest;
		} catch {
			throw new Error(`插件 ${entry.id} 的 HEAD manifest 不是合法 JSON`);
		}
		const version = headParsed.version;
		if (!version) throw new Error(`插件 ${entry.id} HEAD manifest 缺 version`);
		manifestUrl = releaseAssetUrl(base, repo, version, RELEASE_FILES.manifest);
		mainUrl = releaseAssetUrl(base, repo, version, RELEASE_FILES.main);
		stylesUrl = releaseAssetUrl(base, repo, version, RELEASE_FILES.styles);
	}

	// 1) manifest（校验 id）
	const manifestText = await fetchTextOk(net, manifestUrl);
	let manifest: ObsidianManifest;
	try {
		manifest = JSON.parse(manifestText) as ObsidianManifest;
	} catch {
		throw new Error(`插件 ${entry.id} 的 release manifest 不是合法 JSON`);
	}
	if (manifest.id !== entry.id) {
		// 换 base 也不该「碰运气」拿到别的 id —— 直接中止，不重试
		throw new InstallAbortError(
			`插件 id 不匹配：期望 ${entry.id}，实际 ${manifest.id}（拒绝安装）`
		);
	}
	// 没有版本号的 manifest 不能写盘：写进去会顶掉能用的版本，还会显示成 vundefined
	if (typeof manifest.version !== "string" || !manifest.version) {
		throw new Error(`插件 ${entry.id} 的 release manifest 缺 version`);
	}

	// 2) 版本闸提前到下载阶段：这条线路缓存滞后就换下一条，而不是整单放弃
	if (
		opts.mustBeNewerThan &&
		compareVersions(manifest.version, opts.mustBeNewerThan) <= 0
	) {
		throw new StaleVersionError(
			`加速线路上仍是 v${manifest.version}（与已安装相同或更旧），暂无可用更新，请稍后重试`
		);
	}
	if (
		opts.notOlderThan &&
		compareVersions(manifest.version, opts.notOlderThan) < 0
	) {
		throw new StaleVersionError(
			`下载到的版本 v${manifest.version} 比已安装的 v${opts.notOlderThan} 旧，已取消（避免降级）`
		);
	}

	// 3) main.js（必需，非空）
	const mainText = await fetchTextOk(net, mainUrl);
	if (!mainText || mainText.length < 100) {
		throw new Error(`插件 ${entry.id} 的 main.js 异常（过小/为空）`);
	}

	// 4) styles.css（可缺）
	let stylesText: string | null = null;
	try {
		stylesText = await fetchTextOk(net, stylesUrl);
	} catch {
		stylesText = null; // 很多插件没有 styles.css
	}

	return { manifestText, manifest, mainText, stylesText, direct: useDirect };
};

/**
 * 落地阶段（磁盘 + 插件状态，只做一次）：写盘 → loadManifests → 启用。
 * 这里失败换 base 也没意义，故与下载阶段分开。
 */
export const applyInstallPayload = async (
	entry: MarketEntry,
	payload: InstallPayload,
	ctx: InstallContext,
	opts: InstallOptions = {}
): Promise<string> => {
	const { fs, plugins, configDir } = ctx;
	const { manifestText, manifest, mainText, stylesText } = payload;
	const enable = opts.enable !== false;

	// 防降级：宁可这次不更新，也不能把用户已有的新版本换成旧的。
	// ⚠️ 用**此刻**磁盘/内存里的版本重判一次：下载这几秒里别的更新路径可能已经把
	// 它推到更高版本了，只信下载前抓的快照会让那次升级被悄悄回滚。
	const floorNow = [
		opts.notOlderThan,
		opts.mustBeNewerThan,
		plugins.manifests[entry.id]?.version,
	]
		.filter((v): v is string => !!v)
		.sort((a, b) => compareVersions(b, a))[0];
	if (
		floorNow &&
		manifest.version &&
		compareVersions(manifest.version, floorNow) < 0
	) {
		throw new InstallAbortError(
			`下载到的版本 v${manifest.version} 比已安装的 v${floorNow} 旧，已取消（避免降级）`
		);
	}

	// 更新必须真的更新：拿到同版本就别假装成功
	if (
		opts.mustBeNewerThan &&
		manifest.version &&
		compareVersions(manifest.version, opts.mustBeNewerThan) <= 0
	) {
		throw new InstallAbortError(
			`加速线路上仍是 v${manifest.version}（与已安装相同或更旧），暂无可用更新，请稍后重试`
		);
	}

	// 移动端装不了 desktop-only 的新版：装上去 = 把能用的插件换成加载不了的
	if (opts.isMobile && manifest.isDesktopOnly === true) {
		throw new InstallAbortError("该版本仅支持桌面端，手机端已取消安装");
	}

	// 兼容性：写盘不可逆，覆盖前必须确认新版跑得起来
	if (
		opts.appVersion &&
		typeof manifest.minAppVersion === "string" &&
		manifest.minAppVersion &&
		compareVersions(manifest.minAppVersion, opts.appVersion) > 0
	) {
		throw new InstallAbortError(
			`该版本需要 Obsidian ${manifest.minAppVersion} 或更高（当前 ${opts.appVersion}），已取消`
		);
	}

	// 4) 写盘
	const folder = pluginFolder(configDir, entry.id);
	if (!(await fs.exists(folder))) {
		await fs.mkdir(folder);
	}
	await fs.write(`${folder}/${RELEASE_FILES.manifest}`, manifestText);
	await fs.write(`${folder}/${RELEASE_FILES.main}`, mainText);
	if (stylesText != null) {
		await fs.write(`${folder}/${RELEASE_FILES.styles}`, stylesText);
	}

	// 5) 加载并（按需）启用
	await plugins.loadManifests();
	const wasRunning =
		!!plugins.plugins[entry.id] || plugins.enabledPlugins.has(entry.id);
	if (wasRunning && enable) {
		// 已加载/启用过 → 先停再启，确保新代码生效
		try {
			await plugins.disablePlugin(entry.id);
		} catch {
			/* ignore */
		}
	}
	if (enable) {
		await plugins.enablePluginAndSave(entry.id);
	}

	log(
		"✅ 安装完成:",
		entry.id,
		manifest.version,
		payload.direct ? "(direct)" : "(repo)",
		enable ? "(enabled)" : "(kept disabled)"
	);
	return manifest.version;
};

/**
 * 安装一条插件。失败抛错（调用方负责 Notice）。返回安装后的 manifest 版本号。
 *
 * `base` 可以是单个 base，也可以是「最快优先 + 其余候选」的有序列表：
 * 下载阶段逐个 base 试，某个 base 的 relay 挂了（如 /gh/release 502/504）自动落到
 * 下一个（含 CF 备线）。id 不匹配这类硬失败不重试。special 直链与 base 无关，只试一次。
 */
export const installEntry = async (
	entry: MarketEntry,
	base: string | readonly string[],
	ctx: InstallContext,
	opts: InstallOptions = {}
): Promise<string> => {
	const all = typeof base === "string" ? [base] : [...base];
	if (all.length === 0) throw new InstallAbortError("没有可用的加速线路");
	// special 直链的 URL 与 base 无关，多试几遍只是重复同样的请求
	const isDirect = !!(
		entry.source === "special" &&
		entry.manifestUrl &&
		entry.assetBase
	);
	const bases = isDirect ? all.slice(0, 1) : all;

	let payload: InstallPayload | null = null;
	let lastErr: unknown = null;
	for (const b of bases) {
		try {
			payload = await fetchInstallPayload(entry, b, ctx.net, opts);
			break;
		} catch (e) {
			if (e instanceof InstallAbortError) throw e;
			lastErr = e;
			log("⚠️ 安装下载失败，换下一条线路:", entry.id, b, e);
		}
	}
	if (!payload) {
		// 全部线路都只有旧版本 —— 这不是「线路挂了」，别说成网络问题
		if (lastErr instanceof StaleVersionError) {
			throw new InstallAbortError(lastErr.message);
		}
		const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
		throw new AllBasesFailedError(
			`插件 ${entry.id} 在所有加速线路上都下载失败：${detail}`,
			lastErr
		);
	}
	return applyInstallPayload(entry, payload, ctx, opts);
};

/** GET 文本，非 200 抛错 */
const fetchTextOk = async (
	net: InstallerNet,
	url: string
): Promise<string> => {
	const r = await net.getText(url);
	if (r.status !== 200) throw new Error(`HTTP ${r.status} @ ${url}`);
	return r.text;
};
