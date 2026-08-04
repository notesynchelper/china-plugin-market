/**
 * PluginUpdater — 插件自更新（结构沿用 obsidian-plug/src/updater/PluginUpdater.ts）。
 *
 * 安全机制：
 *  1. 所有文件先下到 .update-temp 临时文件
 *  2. 全部下载/校验通过后才替换正式文件
 *  3. 替换前备份原文件（.backup）
 *  4. 成功/失败都清理临时文件
 *
 * 制品来源 = relay 的 /plugin-market/{version.json,main.js,manifest.json,styles.css}。
 * basesProvider 提供有序 relay base 列表（最快优先），逐个尝试做冗余。
 */

import { log, logError } from "../logger";
import {
	VersionInfo,
	UpdateCheckResult,
	UpdateResult,
	PLUGIN_MARKET_PATH,
	VERSION_FILE,
	SELF_UPDATE_FILES,
	TEMP_SUFFIX,
	VERSION_CHECK_DEBOUNCE_MS,
	MIN_MAIN_JS_SIZE,
} from "./types";

export interface UpdaterAdapter {
	write(path: string, data: string): Promise<void>;
	read(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
	stat(path: string): Promise<{ size: number } | null>;
}

export interface UpdaterDeps {
	requestText(
		url: string
	): Promise<{ status: number; text: string; json: unknown }>;
	adapter: UpdaterAdapter;
	/** 有序 relay base 列表（最快优先），如 ['https://relay-1...', ...] */
	basesProvider: () => Promise<string[]>;
	now: () => number;
}

const join = (base: string, file: string): string =>
	`${base.replace(/\/+$/, "")}${PLUGIN_MARKET_PATH}/${file}`;

export class PluginUpdater {
	private deps: UpdaterDeps;
	private pluginDir: string;
	private currentVersion: string;
	private lastCheckTime = 0;
	private cached: VersionInfo | null = null;
	private isUpdating = false;

	constructor(deps: UpdaterDeps, pluginDir: string, currentVersion: string) {
		this.deps = deps;
		this.pluginDir = pluginDir;
		this.currentVersion = currentVersion;
	}

	/** 逐 base 取某文件文本，首个 200 胜 */
	private async fetchAcrossBases(
		file: string
	): Promise<{ text: string; json: unknown }> {
		const bases = await this.deps.basesProvider();
		let lastErr: unknown = null;
		for (const base of bases) {
			try {
				const r = await this.deps.requestText(join(base, file));
				if (r.status === 200) return { text: r.text, json: r.json };
				lastErr = new Error(`HTTP ${r.status}`);
			} catch (e) {
				lastErr = e;
			}
		}
		throw lastErr instanceof Error
			? lastErr
			: new Error("all bases failed for " + file);
	}

	async checkForUpdate(forceCheck = false): Promise<UpdateCheckResult> {
		const now = this.deps.now();
		if (
			!forceCheck &&
			this.cached &&
			now - this.lastCheckTime < VERSION_CHECK_DEBOUNCE_MS
		) {
			return this.buildResult(this.cached);
		}
		try {
			const { text, json } = await this.fetchAcrossBases(VERSION_FILE);
			const data = (json ?? JSON.parse(text)) as { version: string };
			if (!data || typeof data.version !== "string") {
				throw new Error("version.json 缺 version 字段");
			}
			this.cached = { version: data.version };
			this.lastCheckTime = now;
			return this.buildResult(this.cached);
		} catch (error) {
			logError("🔄 [updater] 版本检查失败:", error);
			return {
				hasUpdate: false,
				currentVersion: this.currentVersion,
				latestVersion: "",
				error: error instanceof Error ? error.message : "version check failed",
			};
		}
	}

	private buildResult(info: VersionInfo): UpdateCheckResult {
		return {
			hasUpdate: isNewerVersion(info.version, this.currentVersion),
			currentVersion: this.currentVersion,
			latestVersion: info.version,
		};
	}

	async performUpdate(): Promise<UpdateResult> {
		if (this.isUpdating) {
			return { success: false, message: "更新正在进行中，请稍候" };
		}
		this.isUpdating = true;
		const updated: string[] = [];
		try {
			// Phase 1: 下载到临时文件
			const downloaded: Record<string, string> = {};
			for (const file of SELF_UPDATE_FILES) {
				try {
					const { text } = await this.fetchAcrossBases(file);
					downloaded[file] = text;
				} catch (e) {
					if (file === "styles.css") {
						log("🔄 [updater] styles.css 缺失，跳过");
						continue; // styles.css 可缺
					}
					throw e;
				}
			}

			// Phase 2: 校验
			if (!downloaded["main.js"] || downloaded["main.js"].length < MIN_MAIN_JS_SIZE) {
				throw new Error("main.js 异常（过小/为空）");
			}
			if (!downloaded["manifest.json"]) {
				throw new Error("manifest.json 缺失");
			}
			try {
				JSON.parse(downloaded["manifest.json"]);
			} catch {
				throw new Error("manifest.json 不是合法 JSON");
			}

			// 写临时文件
			for (const file of Object.keys(downloaded)) {
				await this.deps.adapter.write(
					`${this.pluginDir}/${file}${TEMP_SUFFIX}`,
					downloaded[file]
				);
			}

			// Phase 3: 备份 + 原子替换
			for (const file of Object.keys(downloaded)) {
				const target = `${this.pluginDir}/${file}`;
				if (await this.deps.adapter.exists(target)) {
					const orig = await this.deps.adapter.read(target);
					await this.deps.adapter.write(`${target}.backup`, orig);
				}
				await this.deps.adapter.write(target, downloaded[file]);
				updated.push(file);
			}

			// Phase 4: 清理临时文件
			await this.cleanupTemp();

			return {
				success: true,
				message: "插件更新成功！请重启 Obsidian 以应用更新。",
				filesUpdated: updated,
			};
		} catch (error) {
			logError("🔄 [updater] 更新失败:", error);
			await this.cleanupTemp();
			return {
				success: false,
				message: "更新失败",
				error: error instanceof Error ? error.message : "Unknown error",
			};
		} finally {
			this.isUpdating = false;
		}
	}

	private async cleanupTemp(): Promise<void> {
		for (const file of SELF_UPDATE_FILES) {
			const tmp = `${this.pluginDir}/${file}${TEMP_SUFFIX}`;
			try {
				if (await this.deps.adapter.exists(tmp)) {
					await this.deps.adapter.remove(tmp);
				}
			} catch (e) {
				logError("🔄 [updater] 清理临时文件失败:", tmp, e);
			}
		}
	}

	isUpdateInProgress(): boolean {
		return this.isUpdating;
	}
}

/**
 * semver 比较：latest 是否比 current 新。
 *
 * 按 semver 优先级处理 **预发布号**：`1.0.0-beta.1` < `1.0.0`。
 * 旧实现把 `-beta.1` 当成第 4、5 段数字，于是 `1.0.0-beta.1` 会被判成比
 * `1.0.0` 新 —— 在「更新已安装插件」里就是把用户从正式版推去装 beta（降级）。
 */
export const isNewerVersion = (latest: string, current: string): boolean =>
	compareVersions(latest, current) > 0;

interface ParsedVersion {
	core: number[];
	/** 预发布标识符；空数组 = 正式版（正式版 > 任何预发布） */
	pre: string[];
}

const parseVersion = (v: string): ParsedVersion => {
	// 去掉前缀 v 和 build metadata（+xxx 不参与优先级比较）
	const clean = String(v ?? "").trim().replace(/^v/i, "").split("+")[0];
	const dash = clean.indexOf("-");
	const coreStr = dash === -1 ? clean : clean.slice(0, dash);
	const preStr = dash === -1 ? "" : clean.slice(dash + 1);
	return {
		core: coreStr.split(".").map((n) => parseInt(n, 10) || 0),
		pre: preStr ? preStr.split(".") : [],
	};
};

/** a>b → 1；a<b → -1；相等 → 0 */
export const compareVersions = (a: string, b: string): number => {
	const A = parseVersion(a);
	const B = parseVersion(b);
	for (let i = 0; i < Math.max(A.core.length, B.core.length); i++) {
		const x = A.core[i] || 0;
		const y = B.core[i] || 0;
		if (x !== y) return x > y ? 1 : -1;
	}
	// 主版本相同：有预发布号的更旧（1.0.0-beta < 1.0.0）
	if (A.pre.length === 0 && B.pre.length === 0) return 0;
	if (A.pre.length === 0) return 1;
	if (B.pre.length === 0) return -1;
	for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
		const x = A.pre[i];
		const y = B.pre[i];
		// 标识符少的更旧（beta < beta.1）
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const nx = /^\d+$/.test(x) ? parseInt(x, 10) : null;
		const ny = /^\d+$/.test(y) ? parseInt(y, 10) : null;
		if (nx !== null && ny !== null) {
			if (nx !== ny) return nx > ny ? 1 : -1;
		} else if (nx !== null) {
			return -1; // 纯数字标识符优先级低于字母数字
		} else if (ny !== null) {
			return 1;
		} else if (x !== y) {
			return x > y ? 1 : -1;
		}
	}
	return 0;
};
