import { isAllowedHost, isAllowedUrl, PRODUCT_DOMAINS } from "../src/whitelist";

describe("whitelist.isAllowedHost", () => {
	it("精确产品自有域放行", () => {
		for (const d of PRODUCT_DOMAINS) {
			expect(isAllowedHost(d)).toBe(true);
		}
	});

	it("子域放行", () => {
		expect(isAllowedHost("relay-1.bijitongbu.site")).toBe(true);
		expect(isAllowedHost("obsidian.notebooksyncer.com")).toBe(true);
		expect(isAllowedHost("shoujidiannao.bijitongbu.site")).toBe(true);
		expect(isAllowedHost("getcontent.clipfx.app")).toBe(true);
	});

	it("大小写 / 端口归一", () => {
		expect(isAllowedHost("Relay-1.BijiTongBu.Site")).toBe(true);
		expect(isAllowedHost("relay-1.bijitongbu.site:443")).toBe(true);
	});

	it("钓鱼近似域一律拒绝", () => {
		expect(isAllowedHost("bijitongbu.site.evil.com")).toBe(false);
		expect(isAllowedHost("evilbijitongbu.site")).toBe(false);
		expect(isAllowedHost("notebooksyncer.com.attacker.net")).toBe(false);
		expect(isAllowedHost("xbijitongbu.site")).toBe(false);
		expect(isAllowedHost("")).toBe(false);
		expect(isAllowedHost("github.com")).toBe(false);
	});
});

describe("whitelist.isAllowedUrl", () => {
	it("白名单 https 放行", () => {
		expect(
			isAllowedUrl("https://relay-1.bijitongbu.site/plugin-market/x/manifest.json")
		).toBe(true);
	});

	it("http 一律拒绝（即便白名单域）", () => {
		expect(isAllowedUrl("http://relay-1.bijitongbu.site/x")).toBe(false);
	});

	it("非白名单域拒绝", () => {
		expect(isAllowedUrl("https://raw.githubusercontent.com/a/b/manifest.json")).toBe(
			false
		);
		expect(isAllowedUrl("https://bijitongbu.site.evil.com/x")).toBe(false);
	});

	it("非法 URL 拒绝", () => {
		expect(isAllowedUrl("not a url")).toBe(false);
		expect(isAllowedUrl("")).toBe(false);
	});
});
