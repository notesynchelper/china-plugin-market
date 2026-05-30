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
		throw lastErr || new Error("all bases failed for " + file);
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

/** semver 比较：latest 是否比 current 新 */
export const isNewerVersion = (latest: string, current: string): boolean => {
	const parse = (v: string) =>
		v.split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
	const L = parse(latest);
	const C = parse(current);
	for (let i = 0; i < Math.max(L.length, C.length); i++) {
		const l = L[i] || 0;
		const c = C[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
};
