/**
 * userMessage — 面向用户的错误措辞。
 *
 * 原则（codex 文案复检 2026-08-04）：界面上给「发生了什么 + 能做什么 + 短错误码」，
 * 完整异常、堆栈、长 URL 只进日志（logError）——普通用户读不懂 `HTTP 504 @ https://…`，
 * 它还会把 Notice 挤爆。
 */

import { AllBasesFailedError } from "./installer";

export const friendlyError = (e: unknown): string => {
	if (e instanceof AllBasesFailedError) {
		const detail =
			e.lastError instanceof Error ? e.lastError.message : String(e.lastError);
		const code = /HTTP (\d{3})/.exec(detail)?.[1];
		return `加速线路暂时不可用，请稍后重试${code ? `（HTTP ${code}）` : ""}`;
	}
	const msg = e instanceof Error ? e.message : String(e);
	// 去掉 "@ https://…" 这段诊断用 URL，保留前面的原因
	const short = msg.replace(/\s*@\s*https?:\/\/\S+/g, "").trim();
	return short.length > 80 ? short.slice(0, 80) + "…" : short;
};
