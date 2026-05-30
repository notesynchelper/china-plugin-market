/**
 * 构建期配置。esbuild 用 --define 注入 process.env.ENABLE_AUTO_UPDATE。
 * 本插件不走 Obsidian 官方插件市场审核，自更新默认开启；保留可关开关。
 */
const enableAutoUpdate = (() => {
	try {
		return process.env.ENABLE_AUTO_UPDATE !== "false";
	} catch {
		return true;
	}
})();

export const BUILD_CONFIG = {
	ENABLE_AUTO_UPDATE: enableAutoUpdate,
} as const;
