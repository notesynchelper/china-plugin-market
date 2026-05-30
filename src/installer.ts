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
 * 安装一条插件。失败抛错（调用方负责 Notice）。
 * 返回安装后的 manifest 版本号。
 */
export const installEntry = async (
	entry: MarketEntry,
	base: string,
	ctx: InstallContext
): Promise<string> => {
	const { net, fs, plugins, configDir } = ctx;

	let manifestUrl: string;
	let mainUrl: string;
	let stylesUrl: string;

	const useDirect = entry.source === "special" && entry.manifestUrl && entry.assetBase;

	if (useDirect) {
		// special 直链（registry 已校验白名单 https）
		const assetBase = entry.assetBase!.replace(/\/+$/, "") + "/";
		manifestUrl = entry.manifestUrl!;
		mainUrl = assetBase + RELEASE_FILES.main;
		stylesUrl = assetBase + RELEASE_FILES.styles;
	} else {
		// repo 模式：先取最新版本号
		const repo = entry.repo;
		if (!repo) throw new Error(`插件 ${entry.id} 缺少 repo / 直链信息，无法安装`);
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
		throw new Error(
			`插件 id 不匹配：期望 ${entry.id}，实际 ${manifest.id}（拒绝安装）`
		);
	}

	// 2) main.js（必需，非空）
	const mainText = await fetchTextOk(net, mainUrl);
	if (!mainText || mainText.length < 100) {
		throw new Error(`插件 ${entry.id} 的 main.js 异常（过小/为空）`);
	}

	// 3) styles.css（可缺）
	let stylesText: string | null = null;
	try {
		stylesText = await fetchTextOk(net, stylesUrl);
	} catch {
		stylesText = null; // 很多插件没有 styles.css
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

	// 5) 加载并启用
	await plugins.loadManifests();
	if (plugins.plugins[entry.id] || plugins.enabledPlugins.has(entry.id)) {
		// 已加载/启用过 → 先停再启，确保新代码生效
		try {
			await plugins.disablePlugin(entry.id);
		} catch {
			/* ignore */
		}
	}
	await plugins.enablePluginAndSave(entry.id);

	log("✅ 安装完成:", entry.id, manifest.version, useDirect ? "(direct)" : "(repo)");
	return manifest.version;
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
