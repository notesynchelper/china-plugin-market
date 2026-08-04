/**
 * obsidianNet — requestUrl 的安全包装。
 *
 * 两个坑，都是真机 E2E 才暴露的（单测在这层之上打桩，抓不到）：
 *
 *  1. `RequestUrlResponse.json` 是「一访问就 JSON.parse 正文」的属性，对
 *     main.js / styles.css 这种非 JSON 正文**直接抛异常**。自更新的
 *     requestText 以前无条件读 `r.json`，于是每次下载 main.js 都炸
 *     （`Unexpected token '/'`）→ 自更新 100% 失败。这里惰性读 + 兜底 null。
 *  2. `requestUrl` 默认 `throw: true`，4xx/5xx 直接抛，调用方拿不到状态码
 *     （安装器的「HTTP 404 @ url」提示因此永远出不来）。统一 `throw: false`，
 *     状态码走返回值。
 */

import { requestUrl } from "obsidian";

export interface TextResponse {
	status: number;
	text: string;
	/** 正文能解析成 JSON 时才有值；非 JSON（main.js/styles.css）为 null */
	json: unknown;
}

/** 收敛 RequestUrlResponse：读 json 绝不抛 */
export const safeTextResponse = (r: {
	status: number;
	text: string;
	json?: unknown;
}): TextResponse => {
	let json: unknown = null;
	try {
		json = r.json ?? null;
	} catch {
		json = null; // 正文不是 JSON —— 正常情况，不是错误
	}
	return { status: r.status, text: r.text, json };
};

/** GET 文本；4xx/5xx 不抛，状态码在返回值里 */
export const fetchText = async (url: string): Promise<TextResponse> =>
	safeTextResponse(await requestUrl({ url, method: "GET", throw: false }));
