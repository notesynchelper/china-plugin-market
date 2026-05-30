/**
 * deeplink — obsidian://plugin-market-cn 协议处理。
 *
 * 注意：Obsidian 把协议路径名放在 params.action（恒为 "plugin-market-cn"），所以子动作
 * 不能再用 action，改用查询参数 op：
 *  - obsidian://plugin-market-cn                                打开商店视图
 *  - obsidian://plugin-market-cn?op=install&id=<id>            打开商店、定位并一键安装官方/已知插件
 *  - obsidian://plugin-market-cn?op=special-import&id=&manifest=&assetBase=
 *                                                              从**白名单域**链接导入非官方插件
 *
 * 安全：special-import 的 manifest/assetBase host 必须 ∈ 产品自有白名单域（精确域或子域，
 * 且 https），否则拒绝。调起安装源不限于产品主站——白名单数组里任一产品自有域都放行。
 * parseDeeplinkParams 为纯函数，便于单测覆盖放行 / 拒绝 / 钓鱼用例。
 */

import { isAllowedUrl } from "./whitelist";
import type { MarketEntry } from "./types";

export type DeeplinkIntent =
	| { kind: "open" }
	| { kind: "install"; id: string }
	| { kind: "special-import"; entry: MarketEntry }
	| { kind: "reject"; reason: string };

/** Obsidian 协议回调给的参数（action + 查询键值） */
export type ProtocolParams = Record<string, string>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * 纯解析 + 校验。不做任何副作用。
 */
export const parseDeeplinkParams = (params: ProtocolParams): DeeplinkIntent => {
	// 子动作走 op；params.action 是 Obsidian 注入的协议路径名，忽略
	const op = str(params.op) || "open";

	if (op === "open") return { kind: "open" };

	if (op === "install") {
		const id = str(params.id);
		if (!id) return { kind: "reject", reason: "install 缺少 id" };
		return { kind: "install", id };
	}

	if (op === "special-import" || op === "import") {
		const id = str(params.id);
		const manifestUrl = str(params.manifest || params.manifestUrl);
		const assetBase = str(params.assetBase || params.base);
		if (!id) return { kind: "reject", reason: "special-import 缺少 id" };
		if (!manifestUrl || !assetBase)
			return { kind: "reject", reason: "special-import 缺少 manifest/assetBase" };
		// 白名单强校验（防任意网站推送恶意安装）
		if (!isAllowedUrl(manifestUrl))
			return { kind: "reject", reason: `manifest 非白名单域: ${manifestUrl}` };
		if (!isAllowedUrl(assetBase))
			return { kind: "reject", reason: `assetBase 非白名单域: ${assetBase}` };
		const entry: MarketEntry = {
			id,
			name: str(params.name) || id,
			author: str(params.author) || "未知",
			description: str(params.description) || "通过调起链接导入",
			source: "special",
			manifestUrl,
			assetBase,
			minAppVersion: str(params.minAppVersion) || undefined,
			channel: "test",
		};
		return { kind: "special-import", entry };
	}

	return { kind: "reject", reason: `未知 op: ${op}` };
};

/** 执行器依赖：由 main.ts 注入真实副作用 */
export interface DeeplinkContext {
	enabled: boolean;
	openView: () => Promise<void>;
	locate: (id: string) => void;
	/** 弹确认框，返回是否继续 */
	confirm: (title: string, body: string) => Promise<boolean>;
	/** 安装官方/已知 id（在已加载清单里找 entry 并装） */
	installById: (id: string) => Promise<void>;
	/** 安装一条直链 entry */
	installEntry: (entry: MarketEntry) => Promise<void>;
	notify: (msg: string) => void;
}

/**
 * 执行解析后的意图（含确认弹窗）。
 */
export const runDeeplink = async (
	params: ProtocolParams,
	ctx: DeeplinkContext
): Promise<void> => {
	if (!ctx.enabled) {
		ctx.notify("调起链接已在设置中关闭");
		return;
	}
	const intent = parseDeeplinkParams(params);
	switch (intent.kind) {
		case "open":
			await ctx.openView();
			return;
		case "install": {
			await ctx.openView();
			ctx.locate(intent.id);
			const ok = await ctx.confirm(
				"安装插件",
				`确认从加速商店安装插件「${intent.id}」？`
			);
			if (ok) await ctx.installById(intent.id);
			return;
		}
		case "special-import": {
			await ctx.openView();
			const e = intent.entry;
			const ok = await ctx.confirm(
				"导入第三方插件",
				`即将从白名单域导入插件「${e.name}」(${e.id})\n作者：${e.author}\n来源：${e.manifestUrl}\n\n第三方插件会运行其自带代码，确认信任并安装？`
			);
			if (ok) await ctx.installEntry(e);
			return;
		}
		case "reject":
			ctx.notify(`调起链接被拒绝：${intent.reason}`);
			return;
	}
};
