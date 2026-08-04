import {
	PluginUpdater,
	isNewerVersion,
	type UpdaterDeps,
} from "../src/updater/PluginUpdater";

/**
 * 回归守卫：制品里只有 version.json 是 JSON，main.js / styles.css 都不是。
 * requestText 对非 JSON 正文只能把 json 记为 null（见 src/obsidianNet.ts），
 * performUpdate 必须照样成功 —— 线上曾因为这里抛异常 100% 更新失败。
 */
describe("performUpdate 非 JSON 制品", () => {
	it("main.js / styles.css 的 json 为 null 时仍然更新成功", async () => {
		const files: Record<string, string> = {};
		const adapter = {
			write: async (p: string, d: string) => {
				files[p] = d;
			},
			read: async (p: string) => files[p] ?? "",
			exists: async (p: string) => p in files,
			remove: async (p: string) => {
				delete files[p];
			},
			stat: async (p: string) =>
				p in files ? { size: files[p].length } : null,
		};
		const bigJs = "/*\nGENERATED\n*/\n" + "x".repeat(2000);
		const updater = new PluginUpdater(
			{
				requestText: async (url: string) => {
					if (url.endsWith("version.json"))
						return {
							status: 200,
							text: '{"version":"9.9.9"}',
							json: { version: "9.9.9" },
						};
					if (url.endsWith("manifest.json"))
						return {
							status: 200,
							text: '{"id":"china-speedup","version":"9.9.9"}',
							json: { id: "china-speedup", version: "9.9.9" },
						};
					// 非 JSON 正文：json 只能是 null
					if (url.endsWith("main.js"))
						return { status: 200, text: bigJs, json: null };
					return { status: 200, text: ".x{}", json: null };
				},
				adapter,
				basesProvider: async () => ["https://relay-1.x"],
				now: () => 1_000_000,
			},
			".obsidian/plugins/china-speedup",
			"0.1.2"
		);
		const check = await updater.checkForUpdate(true);
		expect(check.hasUpdate).toBe(true);
		const res = await updater.performUpdate();
		expect(res.error).toBeUndefined();
		expect(res.success).toBe(true);
		expect(files[".obsidian/plugins/china-speedup/main.js"]).toBe(bigJs);
		expect(files[".obsidian/plugins/china-speedup/manifest.json"]).toContain(
			"9.9.9"
		);
		// 临时文件清理干净
		expect(
			Object.keys(files).some((k) => k.endsWith(".update-temp"))
		).toBe(false);
	});
});

describe("isNewerVersion", () => {
	it("基本比较", () => {
		expect(isNewerVersion("1.0.1", "1.0.0")).toBe(true);
		expect(isNewerVersion("1.2.0", "1.10.0")).toBe(false);
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
		expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
	});

	it("预发布号按 semver 优先级：1.0.0-beta.1 < 1.0.0", () => {
		expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
		expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
		expect(isNewerVersion("1.0.0-beta", "1.0.0-beta.1")).toBe(false);
		expect(isNewerVersion("1.0.0-rc.1", "1.0.0-beta.9")).toBe(true);
		expect(isNewerVersion("1.0.1-beta.1", "1.0.0")).toBe(true);
	});

	it("v 前缀与 build metadata 不影响比较", () => {
		expect(isNewerVersion("v1.2.0", "1.1.0")).toBe(true);
		expect(isNewerVersion("1.0.0+build.9", "1.0.0")).toBe(false);
	});
});

const makeAdapter = () => {
	const files = new Map<string, string>();
	return {
		files,
		write: async (p: string, d: string) => {
			files.set(p, d);
		},
		read: async (p: string) => {
			if (!files.has(p)) throw new Error("ENOENT " + p);
			return files.get(p)!;
		},
		exists: async (p: string) => files.has(p),
		remove: async (p: string) => {
			files.delete(p);
		},
		stat: async (p: string) =>
			files.has(p) ? { size: files.get(p)!.length } : null,
	};
};

const BASE = "https://relay-1.x";
const PDIR = ".obsidian/plugins/plugin-market-cn";
const bigJs = "x".repeat(2000);

const makeDeps = (
	table: Record<string, { status: number; text: string; json: unknown }>,
	adapter = makeAdapter()
): { deps: UpdaterDeps; adapter: ReturnType<typeof makeAdapter> } => ({
	adapter,
	deps: {
		requestText: async (url: string) =>
			table[url] || { status: 404, text: "", json: null },
		adapter,
		basesProvider: async () => [BASE],
		now: () => 1000,
	},
});

describe("PluginUpdater.checkForUpdate", () => {
	it("检测到新版本", async () => {
		const { deps } = makeDeps({
			[`${BASE}/plugin-market/version.json`]: {
				status: 200,
				text: '{"version":"2.0.0"}',
				json: { version: "2.0.0" },
			},
		});
		const u = new PluginUpdater(deps, PDIR, "1.0.0");
		const r = await u.checkForUpdate(true);
		expect(r.hasUpdate).toBe(true);
		expect(r.latestVersion).toBe("2.0.0");
	});

	it("同版本不更新", async () => {
		const { deps } = makeDeps({
			[`${BASE}/plugin-market/version.json`]: {
				status: 200,
				text: '{"version":"1.0.0"}',
				json: { version: "1.0.0" },
			},
		});
		const u = new PluginUpdater(deps, PDIR, "1.0.0");
		const r = await u.checkForUpdate(true);
		expect(r.hasUpdate).toBe(false);
	});

	it("version.json 取不到返回 error", async () => {
		const { deps } = makeDeps({});
		const u = new PluginUpdater(deps, PDIR, "1.0.0");
		const r = await u.checkForUpdate(true);
		expect(r.hasUpdate).toBe(false);
		expect(r.error).toBeTruthy();
	});
});

describe("PluginUpdater.performUpdate", () => {
	it("下载→校验→备份→原子替换", async () => {
		const adapter = makeAdapter();
		// 预置原文件，验证会被备份
		adapter.files.set(`${PDIR}/main.js`, "OLDJS");
		adapter.files.set(`${PDIR}/manifest.json`, '{"version":"1.0.0"}');
		const { deps } = makeDeps(
			{
				[`${BASE}/plugin-market/main.js`]: {
					status: 200,
					text: bigJs,
					json: null,
				},
				[`${BASE}/plugin-market/manifest.json`]: {
					status: 200,
					text: '{"id":"plugin-market-cn","version":"2.0.0"}',
					json: null,
				},
				[`${BASE}/plugin-market/styles.css`]: {
					status: 200,
					text: ".a{}",
					json: null,
				},
			},
			adapter
		);
		const u = new PluginUpdater(deps, PDIR, "1.0.0");
		const r = await u.performUpdate();
		expect(r.success).toBe(true);
		expect(adapter.files.get(`${PDIR}/main.js`)).toBe(bigJs);
		expect(adapter.files.get(`${PDIR}/manifest.json`)).toContain("2.0.0");
		// 备份了旧 main.js
		expect(adapter.files.get(`${PDIR}/main.js.backup`)).toBe("OLDJS");
		// 临时文件清理
		expect(adapter.files.has(`${PDIR}/main.js.update-temp`)).toBe(false);
	});

	it("main.js 异常时不替换且报失败", async () => {
		const adapter = makeAdapter();
		adapter.files.set(`${PDIR}/main.js`, "OLDJS");
		const { deps } = makeDeps(
			{
				[`${BASE}/plugin-market/main.js`]: {
					status: 200,
					text: "tiny",
					json: null,
				},
				[`${BASE}/plugin-market/manifest.json`]: {
					status: 200,
					text: '{"version":"2.0.0"}',
					json: null,
				},
			},
			adapter
		);
		const u = new PluginUpdater(deps, PDIR, "1.0.0");
		const r = await u.performUpdate();
		expect(r.success).toBe(false);
		// 原文件未被覆盖
		expect(adapter.files.get(`${PDIR}/main.js`)).toBe("OLDJS");
	});
});
