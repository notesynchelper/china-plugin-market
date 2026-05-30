import { parseDeeplinkParams } from "../src/deeplink";

describe("parseDeeplinkParams", () => {
	it("默认 / open 打开商店（无 op，仅协议路径名）", () => {
		// Obsidian 注入 action=plugin-market-cn，无 op → open
		expect(parseDeeplinkParams({ action: "plugin-market-cn" }).kind).toBe(
			"open"
		);
		expect(parseDeeplinkParams({ op: "open" }).kind).toBe("open");
		expect(parseDeeplinkParams({}).kind).toBe("open");
	});

	it("install 需要 id", () => {
		const ok = parseDeeplinkParams({ op: "install", id: "dataview" });
		expect(ok).toEqual({ kind: "install", id: "dataview" });
		expect(parseDeeplinkParams({ op: "install" }).kind).toBe("reject");
	});

	it("special-import 白名单域放行（非主站子域也放行）", () => {
		const r = parseDeeplinkParams({
			op: "special-import",
			id: "myplug",
			name: "我的插件",
			author: "team",
			manifest: "https://shoujidiannao.bijitongbu.site/p/manifest.json",
			assetBase: "https://shoujidiannao.bijitongbu.site/p/",
		});
		expect(r.kind).toBe("special-import");
		if (r.kind === "special-import") {
			expect(r.entry.id).toBe("myplug");
			expect(r.entry.source).toBe("special");
			expect(r.entry.manifestUrl).toContain("shoujidiannao.bijitongbu.site");
		}
	});

	it("special-import 非白名单域拒绝", () => {
		const r = parseDeeplinkParams({
			op: "special-import",
			id: "evil",
			manifest: "https://evil.com/manifest.json",
			assetBase: "https://evil.com/",
		});
		expect(r.kind).toBe("reject");
	});

	it("special-import 钓鱼近似域拒绝", () => {
		const r = parseDeeplinkParams({
			op: "special-import",
			id: "evil",
			manifest: "https://bijitongbu.site.evil.com/manifest.json",
			assetBase: "https://bijitongbu.site.evil.com/",
		});
		expect(r.kind).toBe("reject");
	});

	it("special-import http 拒绝", () => {
		const r = parseDeeplinkParams({
			op: "special-import",
			id: "x",
			manifest: "http://relay-1.bijitongbu.site/manifest.json",
			assetBase: "http://relay-1.bijitongbu.site/",
		});
		expect(r.kind).toBe("reject");
	});

	it("special-import 缺 manifest/assetBase 拒绝", () => {
		expect(parseDeeplinkParams({ op: "special-import", id: "x" }).kind).toBe(
			"reject"
		);
	});

	it("未知 op 拒绝", () => {
		expect(parseDeeplinkParams({ op: "nuke" }).kind).toBe("reject");
	});
});
