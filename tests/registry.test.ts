import {
	mergeCatalog,
	validateSpecialImport,
	resolveUrl,
} from "../src/registry";
import type {
	OfficialPlugin,
	PluginStats,
	DeprecationMap,
	MarketplaceConfig,
	SpecialImport,
} from "../src/types";

const official: OfficialPlugin[] = [
	{ id: "a", name: "Alpha", author: "x", description: "da", repo: "x/a" },
	{ id: "b", name: "Bravo", author: "y", description: "db", repo: "y/b" },
	{ id: "c", name: "Charlie", author: "z", description: "dc", repo: "z/c" },
];
const stats: PluginStats = {
	a: { downloads: 100 },
	b: { downloads: 9000 },
	c: { downloads: 50 },
};
const deprecation: DeprecationMap = { c: ["use something else"] };

const baseConfig = (over: Partial<MarketplaceConfig> = {}): MarketplaceConfig => ({
	version: 1,
	relays: [],
	blacklist: [],
	specialImports: [],
	...over,
});

describe("mergeCatalog", () => {
	it("剔除黑名单", () => {
		const out = mergeCatalog(official, stats, deprecation, baseConfig({ blacklist: ["b"] }), {
			enableSpecialImports: true,
		});
		expect(out.map((e) => e.id).sort()).toEqual(["a", "c"]);
	});

	it("按下载量降序，pinned 置顶", () => {
		const out = mergeCatalog(
			official,
			stats,
			deprecation,
			baseConfig({ pinned: ["c"] }),
			{ enableSpecialImports: false }
		);
		expect(out[0].id).toBe("c"); // pinned first
		expect(out[1].id).toBe("b"); // 9000
		expect(out[2].id).toBe("a"); // 100
	});

	it("标记 deprecated", () => {
		const out = mergeCatalog(official, stats, deprecation, baseConfig(), {
			enableSpecialImports: false,
		});
		expect(out.find((e) => e.id === "c")?.deprecated).toBe(true);
		expect(out.find((e) => e.id === "a")?.deprecated).toBe(false);
	});

	it("特殊导入注入，同 id 覆盖 official", () => {
		const special: SpecialImport = {
			id: "a",
			name: "Alpha-special",
			author: "sp",
			description: "覆盖",
			repo: "sp/a",
		};
		const out = mergeCatalog(
			official,
			stats,
			deprecation,
			baseConfig({ specialImports: [special] }),
			{ enableSpecialImports: true }
		);
		const a = out.find((e) => e.id === "a");
		expect(a?.source).toBe("special");
		expect(a?.name).toBe("Alpha-special");
	});

	it("enableSpecialImports=false 时不注入", () => {
		const special: SpecialImport = {
			id: "z",
			name: "Zeta",
			author: "sp",
			description: "x",
			repo: "sp/z",
		};
		const out = mergeCatalog(
			official,
			stats,
			deprecation,
			baseConfig({ specialImports: [special] }),
			{ enableSpecialImports: false }
		);
		expect(out.find((e) => e.id === "z")).toBeUndefined();
	});

	it("非法特殊导入（非白名单直链）被跳过", () => {
		const special: SpecialImport = {
			id: "bad",
			name: "Bad",
			author: "sp",
			description: "x",
			manifestUrl: "https://evil.com/manifest.json",
			assetBase: "https://evil.com/",
		};
		const out = mergeCatalog(
			official,
			stats,
			deprecation,
			baseConfig({ specialImports: [special] }),
			{ enableSpecialImports: true }
		);
		expect(out.find((e) => e.id === "bad")).toBeUndefined();
	});
});

describe("validateSpecialImport", () => {
	it("repo 模式合法", () => {
		expect(validateSpecialImport({ id: "a", name: "A", author: "", description: "", repo: "x/a" }).ok).toBe(true);
	});
	it("白名单直链合法", () => {
		expect(
			validateSpecialImport({
				id: "a",
				name: "A",
				author: "",
				description: "",
				manifestUrl: "https://relay-1.bijitongbu.site/x/manifest.json",
				assetBase: "https://relay-1.bijitongbu.site/x/",
			}).ok
		).toBe(true);
	});
	it("非白名单直链非法", () => {
		expect(
			validateSpecialImport({
				id: "a",
				name: "A",
				author: "",
				description: "",
				manifestUrl: "https://evil.com/manifest.json",
				assetBase: "https://evil.com/",
			}).ok
		).toBe(false);
	});
	it("只有 manifestUrl 缺 assetBase 非法", () => {
		expect(
			validateSpecialImport({
				id: "a",
				name: "A",
				author: "",
				description: "",
				manifestUrl: "https://relay-1.bijitongbu.site/x/manifest.json",
			}).ok
		).toBe(false);
	});
	it("既无 repo 也无直链非法", () => {
		expect(validateSpecialImport({ id: "a", name: "A", author: "", description: "" }).ok).toBe(false);
	});
});

describe("resolveUrl", () => {
	it("相对 path 前缀 base", () => {
		expect(resolveUrl("https://r/", "/gh/raw/x")).toBe("https://r/gh/raw/x");
		expect(resolveUrl("https://r", "gh/raw/x")).toBe("https://r/gh/raw/x");
	});
	it("绝对 path 原样返回", () => {
		expect(resolveUrl("https://r", "https://other/x")).toBe("https://other/x");
	});
});
