import {
	installEntry,
	pluginFolder,
	releaseAssetUrl,
	rawHeadManifestUrl,
	getInstalledState,
	type InstallContext,
	type PluginsApi,
} from "../src/installer";
import type { MarketEntry } from "../src/types";

const makeFs = () => {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	return {
		files,
		dirs,
		exists: async (p: string) => files.has(p) || dirs.has(p),
		mkdir: async (p: string) => {
			dirs.add(p);
		},
		write: async (p: string, d: string) => {
			files.set(p, d);
		},
	};
};

const makePlugins = (): PluginsApi & { enabled: string[] } => {
	const enabledPlugins = new Set<string>();
	const enabled: string[] = [];
	return {
		manifests: {},
		enabledPlugins,
		plugins: {},
		enabled,
		loadManifests: async () => {},
		enablePluginAndSave: async (id: string) => {
			enabledPlugins.add(id);
			enabled.push(id);
		},
		disablePlugin: async (id: string) => {
			enabledPlugins.delete(id);
		},
	};
};

const makeNet = (table: Record<string, { status: number; text: string }>) => ({
	getText: async (url: string) => {
		const hit = table[url];
		if (!hit) return { status: 404, text: "" };
		return hit;
	},
});

const BASE = "https://relay-1.x";
const bigJs = "x".repeat(500);

describe("installEntry repo 模式", () => {
	it("取版本→下载→写盘→启用", async () => {
		const entry: MarketEntry = {
			id: "foo",
			name: "Foo",
			author: "a",
			description: "d",
			source: "official",
			repo: "owner/foo",
		};
		const net = makeNet({
			[rawHeadManifestUrl(BASE, "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.2.3" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "1.2.3", "manifest.json")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.2.3" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "1.2.3", "main.js")]: {
				status: 200,
				text: bigJs,
			},
			// styles.css 缺失 -> 404
		});
		const fs = makeFs();
		const plugins = makePlugins();
		const ctx: InstallContext = { net, fs, plugins, configDir: ".obsidian" };

		const version = await installEntry(entry, BASE, ctx);
		expect(version).toBe("1.2.3");
		const folder = pluginFolder(".obsidian", "foo");
		expect(fs.files.get(`${folder}/manifest.json`)).toContain('"foo"');
		expect(fs.files.get(`${folder}/main.js`)).toBe(bigJs);
		expect(fs.files.has(`${folder}/styles.css`)).toBe(false);
		expect(plugins.enabled).toContain("foo");
	});

	it("id 不匹配拒绝安装", async () => {
		const entry: MarketEntry = {
			id: "foo",
			name: "Foo",
			author: "a",
			description: "d",
			source: "official",
			repo: "owner/foo",
		};
		const net = makeNet({
			[rawHeadManifestUrl(BASE, "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.0.0" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "1.0.0", "manifest.json")]: {
				status: 200,
				text: JSON.stringify({ id: "EVIL", version: "1.0.0" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "1.0.0", "main.js")]: {
				status: 200,
				text: bigJs,
			},
		});
		const ctx: InstallContext = {
			net,
			fs: makeFs(),
			plugins: makePlugins(),
			configDir: ".obsidian",
		};
		await expect(installEntry(entry, BASE, ctx)).rejects.toThrow(/id 不匹配/);
	});

	it("main.js 过小拒绝", async () => {
		const entry: MarketEntry = {
			id: "foo",
			name: "Foo",
			author: "a",
			description: "d",
			source: "official",
			repo: "owner/foo",
		};
		const net = makeNet({
			[rawHeadManifestUrl(BASE, "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.0.0" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "1.0.0", "manifest.json")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.0.0" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "1.0.0", "main.js")]: {
				status: 200,
				text: "tiny",
			},
		});
		const ctx: InstallContext = {
			net,
			fs: makeFs(),
			plugins: makePlugins(),
			configDir: ".obsidian",
		};
		await expect(installEntry(entry, BASE, ctx)).rejects.toThrow(/main\.js/);
	});
});

describe("installEntry special 直链模式", () => {
	it("从 assetBase 下载并安装", async () => {
		const entry: MarketEntry = {
			id: "sp",
			name: "Special",
			author: "team",
			description: "d",
			source: "special",
			manifestUrl: "https://relay-1.bijitongbu.site/p/manifest.json",
			assetBase: "https://relay-1.bijitongbu.site/p/",
		};
		const net = makeNet({
			"https://relay-1.bijitongbu.site/p/manifest.json": {
				status: 200,
				text: JSON.stringify({ id: "sp", version: "0.5.0" }),
			},
			"https://relay-1.bijitongbu.site/p/main.js": {
				status: 200,
				text: bigJs,
			},
			"https://relay-1.bijitongbu.site/p/styles.css": {
				status: 200,
				text: ".x{}",
			},
		});
		const fs = makeFs();
		const plugins = makePlugins();
		const ctx: InstallContext = { net, fs, plugins, configDir: ".obsidian" };
		const v = await installEntry(entry, BASE, ctx);
		expect(v).toBe("0.5.0");
		const folder = pluginFolder(".obsidian", "sp");
		expect(fs.files.get(`${folder}/styles.css`)).toBe(".x{}");
		expect(plugins.enabled).toContain("sp");
	});
});

describe("getInstalledState", () => {
	it("反映 manifests / enabledPlugins", () => {
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "1.0.0" };
		plugins.enabledPlugins.add("foo");
		const st = getInstalledState("foo", plugins);
		expect(st).toEqual({ installed: true, enabled: true, version: "1.0.0" });
		expect(getInstalledState("bar", plugins).installed).toBe(false);
	});
});
