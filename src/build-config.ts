/**
 * 构建期配置。esbuild 用 define 注入裸标识符 __ENABLE_AUTO_UPDATE__
 * （不用 process.env.*：插件跑在移动端 WebView 里，没有 process）。
 * 本插件不走 Obsidian 官方插件市场审核，自更新默认开启；保留可关开关。
 */
declare const __ENABLE_AUTO_UPDATE__: string | undefined;

const enableAutoUpdate =
	typeof __ENABLE_AUTO_UPDATE__ === "string"
		? __ENABLE_AUTO_UPDATE__ !== "false"
		: true;

export const BUILD_CONFIG = {
	ENABLE_AUTO_UPDATE: enableAutoUpdate,
} as const;
