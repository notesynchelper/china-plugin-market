/**
 * 插件自更新类型与常量（复用 obsidian-plug/src/updater 的形态）。
 *
 * 自更新制品由 relay 的 /plugin-market/ 提供：version.json + main.js / manifest.json / styles.css。
 * 多个 relay base 互为冗余；不依赖 GitHub（GitHub Release 是手动安装路径）。
 */

export interface VersionInfo {
	version: string;
}

export interface UpdateCheckResult {
	hasUpdate: boolean;
	currentVersion: string;
	latestVersion: string;
	error?: string;
}

export interface UpdateResult {
	success: boolean;
	message: string;
	filesUpdated?: string[];
	error?: string;
}

/** /plugin-market 静态目录前缀 */
export const PLUGIN_MARKET_PATH = "/plugin-market";
/** 版本清单文件名 */
export const VERSION_FILE = "version.json";
/** 自更新替换的文件（顺序无关；main.js 必需，styles.css 可缺） */
export const SELF_UPDATE_FILES = ["manifest.json", "main.js", "styles.css"] as const;
/** 下载临时后缀 */
export const TEMP_SUFFIX = ".update-temp";
/** 版本检查防抖（1 分钟） */
export const VERSION_CHECK_DEBOUNCE_MS = 60 * 1000;
/** main.js 最小可接受字节数（防下载损坏） */
export const MIN_MAIN_JS_SIZE = 1000;
