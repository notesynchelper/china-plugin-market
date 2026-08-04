import { safeTextResponse } from "../src/obsidianNet";

/**
 * 回归守卫：真机上 requestUrl 的 `json` 是「访问即 JSON.parse」的属性，
 * 对 main.js / styles.css 这类非 JSON 正文会抛。自更新下载 main.js 时踩中它
 * → 每次都「更新失败」（真机 E2E 才发现，单测原先在这层之上打桩看不到）。
 */
const responseWithThrowingJson = (status: number, text: string) => {
	const r = { status, text };
	Object.defineProperty(r, "json", {
		get() {
			throw new SyntaxError(
				`Unexpected token '/', "${text.slice(0, 8)}"... is not valid JSON`
			);
		},
	});
	return r as { status: number; text: string; json?: unknown };
};

describe("safeTextResponse", () => {
	it("json 属性抛异常时不传染调用方，json 记为 null", () => {
		const js = "/*\nTHIS IS A GENERATED FILE\n*/\nconst x = 1;";
		const r = safeTextResponse(responseWithThrowingJson(200, js));
		expect(r.status).toBe(200);
		expect(r.text).toBe(js);
		expect(r.json).toBeNull();
	});

	it("正文是 JSON 时原样带出", () => {
		const r = safeTextResponse({
			status: 200,
			text: '{"version":"1.2.3"}',
			json: { version: "1.2.3" },
		});
		expect(r.json).toEqual({ version: "1.2.3" });
	});

	it("json 为 undefined 归一成 null", () => {
		const r = safeTextResponse({ status: 404, text: "", json: undefined });
		expect(r).toEqual({ status: 404, text: "", json: null });
	});
});
