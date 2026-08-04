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

describe("installEntry 跨 base 重试", () => {
	const BASE2 = "https://gh.clipfx.app";
	const repoEntry: MarketEntry = {
		id: "foo",
		name: "Foo",
		author: "a",
		description: "d",
		source: "official",
		repo: "owner/foo",
	};
	/** base1 的 /gh/release 全 504（github.com 被阻断的真实形态），base2 正常 */
	const netWithBrokenRelease = (calls: string[]) => ({
		getText: async (url: string) => {
			calls.push(url);
			if (url.startsWith(BASE) && url.includes("/gh/release/")) {
				return { status: 504, text: "" };
			}
			const table: Record<string, { status: number; text: string }> = {
				[rawHeadManifestUrl(BASE, "owner/foo")]: {
					status: 200,
					text: JSON.stringify({ id: "foo", version: "1.2.3" }),
				},
				[rawHeadManifestUrl(BASE2, "owner/foo")]: {
					status: 200,
					text: JSON.stringify({ id: "foo", version: "1.2.3" }),
				},
				[releaseAssetUrl(BASE2, "owner/foo", "1.2.3", "manifest.json")]: {
					status: 200,
					text: JSON.stringify({ id: "foo", version: "1.2.3" }),
				},
				[releaseAssetUrl(BASE2, "owner/foo", "1.2.3", "main.js")]: {
					status: 200,
					text: bigJs,
				},
			};
			return table[url] ?? { status: 404, text: "" };
		},
	});

	it("首选 base 的 release 504 时自动落到下一条线路", async () => {
		const calls: string[] = [];
		const fs = makeFs();
		const plugins = makePlugins();
		const ctx: InstallContext = {
			net: netWithBrokenRelease(calls),
			fs,
			plugins,
			configDir: ".obsidian",
		};
		const version = await installEntry(repoEntry, [BASE, BASE2], ctx);
		expect(version).toBe("1.2.3");
		expect(calls.some((u) => u.startsWith(BASE) && u.includes("/gh/release/"))).toBe(
			true
		);
		expect(fs.files.get(`${pluginFolder(".obsidian", "foo")}/main.js`)).toBe(bigJs);
		expect(plugins.enabled).toEqual(["foo"]);
	});

	it("所有线路都挂时抛最后一个错误", async () => {
		const ctx: InstallContext = {
			net: makeNet({}),
			fs: makeFs(),
			plugins: makePlugins(),
			configDir: ".obsidian",
		};
		await expect(installEntry(repoEntry, [BASE, BASE2], ctx)).rejects.toThrow(
			/HTTP 404/
		);
	});

	it("id 不匹配是硬失败，不再试其它线路", async () => {
		const calls: string[] = [];
		const net = {
			getText: async (url: string) => {
				calls.push(url);
				if (url.endsWith("/HEAD/manifest.json"))
					return { status: 200, text: JSON.stringify({ id: "foo", version: "1.0.0" }) };
				if (url.includes("/gh/release/") && url.endsWith("manifest.json"))
					return { status: 200, text: JSON.stringify({ id: "EVIL", version: "1.0.0" }) };
				return { status: 200, text: bigJs };
			},
		};
		const ctx: InstallContext = {
			net,
			fs: makeFs(),
			plugins: makePlugins(),
			configDir: ".obsidian",
		};
		await expect(installEntry(repoEntry, [BASE, BASE2], ctx)).rejects.toThrow(
			/id 不匹配/
		);
		expect(calls.some((u) => u.startsWith(BASE2))).toBe(false);
	});

	it("special 直链与 base 无关，只试一次", async () => {
		const calls: string[] = [];
		const net = {
			getText: async (url: string) => {
				calls.push(url);
				return { status: 500, text: "" };
			},
		};
		const entry: MarketEntry = {
			id: "sp",
			name: "Special",
			author: "team",
			description: "d",
			source: "special",
			manifestUrl: "https://relay-1.bijitongbu.site/p/manifest.json",
			assetBase: "https://relay-1.bijitongbu.site/p/",
		};
		const ctx: InstallContext = {
			net,
			fs: makeFs(),
			plugins: makePlugins(),
			configDir: ".obsidian",
		};
		await expect(installEntry(entry, [BASE, BASE2], ctx)).rejects.toThrow(/HTTP 500/);
		expect(calls).toEqual(["https://relay-1.bijitongbu.site/p/manifest.json"]);
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

describe("installEntry 更新时的启用状态", () => {
	const entry: MarketEntry = {
		id: "foo",
		name: "Foo",
		author: "a",
		description: "d",
		source: "official",
		repo: "owner/foo",
	};
	const okNet = () =>
		makeNet({
			[rawHeadManifestUrl(BASE, "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "2.0.0" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "2.0.0", "manifest.json")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "2.0.0" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "2.0.0", "main.js")]: {
				status: 200,
				text: bigJs,
			},
		});

	it("enable:false —— 更新停用中的插件不得把它打开（不替用户改配置）", async () => {
		const fs = makeFs();
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "1.0.0" }; // 已安装但停用
		const ctx: InstallContext = { net: okNet(), fs, plugins, configDir: ".obsidian" };

		const v = await installEntry(entry, BASE, ctx, { enable: false });
		expect(v).toBe("2.0.0");
		// 新文件已落盘
		expect(fs.files.get(`${pluginFolder(".obsidian", "foo")}/main.js`)).toBe(bigJs);
		// 仍然是停用状态
		expect(plugins.enabled).not.toContain("foo");
		expect(plugins.enabledPlugins.has("foo")).toBe(false);
	});

	it("默认（含更新启用中的插件）仍走 停用→启用 让新代码生效", async () => {
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "1.0.0" };
		plugins.enabledPlugins.add("foo");
		const ctx: InstallContext = {
			net: okNet(),
			fs: makeFs(),
			plugins,
			configDir: ".obsidian",
		};
		await installEntry(entry, BASE, ctx);
		expect(plugins.enabled).toContain("foo");
		expect(plugins.enabledPlugins.has("foo")).toBe(true);
	});
});

describe("防降级闸 notOlderThan", () => {
	const entry: MarketEntry = {
		id: "foo",
		name: "Foo",
		author: "a",
		description: "d",
		source: "official",
		repo: "owner/foo",
	};
	/** 线路只有 1.0.0（比用户已装的 2.0.0 旧） */
	const staleNet = makeNet({
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
			text: bigJs,
		},
	});

	it("下载到的版本比已装的旧 → 中止，绝不写盘", async () => {
		const fs = makeFs();
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "2.0.0" };
		const ctx: InstallContext = { net: staleNet, fs, plugins, configDir: ".obsidian" };
		await expect(
			installEntry(entry, BASE, ctx, { notOlderThan: "2.0.0" })
		).rejects.toThrow(/降级/);
		expect(fs.files.has(`${pluginFolder(".obsidian", "foo")}/main.js`)).toBe(false);
	});

	it("同版本重装不受影响", async () => {
		const fs = makeFs();
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "1.0.0" };
		const ctx: InstallContext = { net: staleNet, fs, plugins, configDir: ".obsidian" };
		await expect(
			installEntry(entry, BASE, ctx, { notOlderThan: "1.0.0" })
		).resolves.toBe("1.0.0");
	});
});

describe("落地前的兼容性闸与「更新必须真更新」", () => {
	const entry: MarketEntry = {
		id: "foo",
		name: "Foo",
		author: "a",
		description: "d",
		source: "official",
		repo: "owner/foo",
	};
	const netAt = (version: string, minAppVersion?: string) =>
		makeNet({
			[rawHeadManifestUrl(BASE, "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version }),
			},
			[releaseAssetUrl(BASE, "owner/foo", version, "manifest.json")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version, minAppVersion }),
			},
			[releaseAssetUrl(BASE, "owner/foo", version, "main.js")]: {
				status: 200,
				text: bigJs,
			},
		});

	it("新版要求更高的 Obsidian → 中止，绝不覆盖还能用的旧版", async () => {
		const fs = makeFs();
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "1.0.0" };
		const ctx: InstallContext = {
			net: netAt("2.0.0", "9.9.9"),
			fs,
			plugins,
			configDir: ".obsidian",
		};
		await expect(
			installEntry(entry, BASE, ctx, { appVersion: "1.7.2" })
		).rejects.toThrow(/需要 Obsidian 9\.9\.9/);
		expect(fs.files.has(`${pluginFolder(".obsidian", "foo")}/main.js`)).toBe(false);
	});

	it("兼容则照常安装", async () => {
		const ctx: InstallContext = {
			net: netAt("2.0.0", "1.5.0"),
			fs: makeFs(),
			plugins: makePlugins(),
			configDir: ".obsidian",
		};
		await expect(
			installEntry(entry, BASE, ctx, { appVersion: "1.7.2" })
		).resolves.toBe("2.0.0");
	});

	it("更新拿到同版本 → 中止，不许弹「已更新」", async () => {
		const fs = makeFs();
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "1.0.0" };
		const ctx: InstallContext = {
			net: netAt("1.0.0"),
			fs,
			plugins,
			configDir: ".obsidian",
		};
		await expect(
			installEntry(entry, BASE, ctx, { mustBeNewerThan: "1.0.0" })
		).rejects.toThrow(/暂无可用更新/);
		expect(fs.files.has(`${pluginFolder(".obsidian", "foo")}/main.js`)).toBe(false);
	});
});

describe("版本闸可跨线路重试", () => {
	const BASE2 = "https://gh.clipfx.app";
	const entry: MarketEntry = {
		id: "foo",
		name: "Foo",
		author: "a",
		description: "d",
		source: "official",
		repo: "owner/foo",
	};
	/** base1 的 HEAD 缓存滞后在 1.0.0，base2 已经有 2.0.0 */
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
			text: bigJs,
		},
		[rawHeadManifestUrl(BASE2, "owner/foo")]: {
			status: 200,
			text: JSON.stringify({ id: "foo", version: "2.0.0" }),
		},
		[releaseAssetUrl(BASE2, "owner/foo", "2.0.0", "manifest.json")]: {
			status: 200,
			text: JSON.stringify({ id: "foo", version: "2.0.0" }),
		},
		[releaseAssetUrl(BASE2, "owner/foo", "2.0.0", "main.js")]: {
			status: 200,
			text: bigJs,
		},
	});

	it("首条线路只有旧版 → 落到下一条线路真的更新成功", async () => {
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "1.0.0" };
		const ctx: InstallContext = {
			net,
			fs: makeFs(),
			plugins,
			configDir: ".obsidian",
		};
		await expect(
			installEntry(entry, [BASE, BASE2], ctx, { mustBeNewerThan: "1.0.0" })
		).resolves.toBe("2.0.0");
	});

	it("所有线路都只有旧版 → 报「暂无可用更新」而不是「线路不可用」", async () => {
		const plugins = makePlugins();
		plugins.manifests["foo"] = { version: "1.0.0" };
		const ctx: InstallContext = {
			net,
			fs: makeFs(),
			plugins,
			configDir: ".obsidian",
		};
		await expect(
			installEntry(entry, [BASE], ctx, { mustBeNewerThan: "1.0.0" })
		).rejects.toThrow(/暂无可用更新/);
	});

	it("release manifest 缺 version → 不写盘", async () => {
		const badNet = makeNet({
			[rawHeadManifestUrl(BASE, "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "2.0.0" }),
			},
			[releaseAssetUrl(BASE, "owner/foo", "2.0.0", "manifest.json")]: {
				status: 200,
				text: JSON.stringify({ id: "foo" }), // 没有 version
			},
			[releaseAssetUrl(BASE, "owner/foo", "2.0.0", "main.js")]: {
				status: 200,
				text: bigJs,
			},
		});
		const fs = makeFs();
		const ctx: InstallContext = {
			net: badNet,
			fs,
			plugins: makePlugins(),
			configDir: ".obsidian",
		};
		await expect(installEntry(entry, BASE, ctx)).rejects.toThrow(/缺 version/);
		expect(fs.files.has(`${pluginFolder(".obsidian", "foo")}/main.js`)).toBe(false);
	});
});

describe("落地阶段的两道并发/平台守卫", () => {
	const entry: MarketEntry = {
		id: "foo",
		name: "Foo",
		author: "a",
		description: "d",
		source: "official",
		repo: "owner/foo",
	};
	const netAt = (version: string, extra = {}) =>
		makeNet({
			[rawHeadManifestUrl(BASE, "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version }),
			},
			[releaseAssetUrl(BASE, "owner/foo", version, "manifest.json")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version, ...extra }),
			},
			[releaseAssetUrl(BASE, "owner/foo", version, "main.js")]: {
				status: 200,
				text: bigJs,
			},
		});

	it("手机端不写 desktop-only 的版本", async () => {
		const fs = makeFs();
		const ctx: InstallContext = {
			net: netAt("2.0.0", { isDesktopOnly: true }),
			fs,
			plugins: makePlugins(),
			configDir: ".obsidian",
		};
		await expect(
			installEntry(entry, BASE, ctx, { isMobile: true })
		).rejects.toThrow(/仅支持桌面端/);
		expect(fs.files.has(`${pluginFolder(".obsidian", "foo")}/main.js`)).toBe(false);
	});

	it("下载期间别的路径把插件升到了更高版本 → 落地时重判，不回滚它", async () => {
		const fs = makeFs();
		const plugins = makePlugins();
		// 下载前是 1.0.0（调用方据此传 notOlderThan），下载完发现已经是 3.0.0
		plugins.manifests["foo"] = { version: "3.0.0" };
		const ctx: InstallContext = {
			net: netAt("2.0.0"),
			fs,
			plugins,
			configDir: ".obsidian",
		};
		await expect(
			installEntry(entry, BASE, ctx, { notOlderThan: "1.0.0" })
		).rejects.toThrow(/避免降级/);
		expect(fs.files.has(`${pluginFolder(".obsidian", "foo")}/main.js`)).toBe(false);
	});
});
