import {
	UpdateChecker,
	checkUpdates,
	fetchLatestVersion,
	latestVersionUrls,
	UPDATE_CHECK_TTL_MS,
	type UpdateCandidate,
} from "../src/updateChecker";
import { rawHeadManifestUrl } from "../src/installer";
import type { MarketEntry } from "../src/types";

const BASES = ["https://relay-1.x", "https://relay-2.x"];

const officialEntry = (id: string, repo = `owner/${id}`): MarketEntry => ({
	id,
	name: id.toUpperCase(),
	author: "a",
	description: "d",
	source: "official",
	repo,
});

const specialEntry = (id: string): MarketEntry => ({
	id,
	name: id,
	author: "a",
	description: "d",
	source: "special",
	manifestUrl: `https://relay-1.bijitongbu.site/x/${id}/manifest.json`,
	assetBase: `https://relay-1.bijitongbu.site/x/${id}/`,
});

const makeNet = (table: Record<string, { status: number; text: string }>) => {
	const calls: string[] = [];
	return {
		calls,
		getText: async (url: string) => {
			calls.push(url);
			return table[url] ?? { status: 404, text: "" };
		},
	};
};

describe("latestVersionUrls", () => {
	it("repo 条目按线路顺序给出候选", () => {
		expect(latestVersionUrls(officialEntry("foo"), BASES)).toEqual([
			rawHeadManifestUrl(BASES[0], "owner/foo"),
			rawHeadManifestUrl(BASES[1], "owner/foo"),
		]);
	});

	it("special 直链与线路无关，只有一个 URL", () => {
		const e = specialEntry("bar");
		expect(latestVersionUrls(e, BASES)).toEqual([e.manifestUrl]);
	});

	it("既没 repo 也没直链 → 无从查起", () => {
		const e: MarketEntry = {
			id: "x",
			name: "x",
			author: "a",
			description: "d",
			source: "official",
		};
		expect(latestVersionUrls(e, BASES)).toEqual([]);
	});
});

describe("fetchLatestVersion", () => {
	it("已经比本地新 → 够用即止，不再问其余线路", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.2.3" }),
			},
		});
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net, "1.0.0")
		).resolves.toEqual({
			version: "1.2.3",
			minAppVersion: undefined,
			isDesktopOnly: false,
		});
		expect(net.calls).toHaveLength(1);
	});

	it("首条线路缓存滞后 → 继续问完其余线路取最大值（不误判「已是最新」）", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.0.0" }), // 滞后
			},
			[rawHeadManifestUrl(BASES[1], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "2.0.0" }),
			},
		});
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net, "1.0.0")
		).resolves.toMatchObject({ version: "2.0.0" });
		expect(net.calls).toHaveLength(2);
	});

	it("首条线路挂了 → 落到下一条", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/foo")]: { status: 502, text: "" },
			[rawHeadManifestUrl(BASES[1], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "2.0.0" }),
			},
		});
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net)
		).resolves.toMatchObject({ version: "2.0.0" });
		expect(net.calls).toHaveLength(2);
	});

	it("relay 返回错误页（非 JSON）→ 换下一条线路", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/foo")]: {
				status: 200,
				text: "<html>502 Bad Gateway</html>",
			},
			[rawHeadManifestUrl(BASES[1], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "3.0.0" }),
			},
		});
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net)
		).resolves.toMatchObject({ version: "3.0.0" });
	});

	it("id 对不上 → 判未知，且不换线路碰运气", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "evil", version: "9.9.9" }),
			},
			[rawHeadManifestUrl(BASES[1], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "9.9.9" }),
			},
		});
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net)
		).resolves.toBeNull();
		expect(net.calls).toHaveLength(1);
	});

	it("全部线路都挂 → null（未知，不是「最新」）", async () => {
		const net = makeNet({});
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net)
		).resolves.toBeNull();
	});

	it("net 抛异常也不冒泡，按未知处理", async () => {
		const net = {
			getText: async () => {
				throw new Error("boom");
			},
		};
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net)
		).resolves.toBeNull();
	});
});

describe("checkUpdates", () => {
	const cand = (id: string, installed: string): UpdateCandidate => ({
		entry: officialEntry(id),
		installedVersion: installed,
	});

	it("只对查到版本的条目产出结论", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "1.1.0" }),
			},
			[rawHeadManifestUrl(BASES[0], "owner/b")]: {
				status: 200,
				text: JSON.stringify({ id: "b", version: "1.0.0" }),
			},
			// c 全线路 404 → 无结论
		});
		const out = await checkUpdates(
			[cand("a", "1.0.0"), cand("b", "1.0.0"), cand("c", "1.0.0")],
			BASES,
			net
		);
		expect(out.map((o) => o.id).sort()).toEqual(["a", "b"]);
		expect(out.find((o) => o.id === "a")?.hasUpdate).toBe(true);
		expect(out.find((o) => o.id === "b")?.hasUpdate).toBe(false);
	});

	it("本地版本更新（预发布/手动装）不会被报成可更新", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "1.0.0" }),
			},
		});
		const out = await checkUpdates([cand("a", "1.4.0")], BASES, net);
		expect(out[0].hasUpdate).toBe(false);
	});

	it("并发受限，全部条目都跑到", async () => {
		const ids = Array.from({ length: 9 }, (_, i) => `p${i}`);
		let inFlight = 0;
		let peak = 0;
		const net = {
			getText: async (url: string) => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((r) => setTimeout(r, 1));
				inFlight--;
				const id = /owner\/(p\d+)/.exec(url)?.[1] ?? "";
				return {
					status: 200,
					text: JSON.stringify({ id, version: "2.0.0" }),
				};
			},
		};
		const out = await checkUpdates(
			ids.map((id) => cand(id, "1.0.0")),
			BASES,
			net,
			{ concurrency: 3 }
		);
		expect(out).toHaveLength(9);
		expect(peak).toBeLessThanOrEqual(3);
	});
});

describe("UpdateChecker 缓存与状态", () => {
	const net = makeNet({
		[rawHeadManifestUrl(BASES[0], "owner/a")]: {
			status: 200,
			text: JSON.stringify({ id: "a", version: "2.0.0" }),
		},
	});
	const candidates: UpdateCandidate[] = [
		{ entry: officialEntry("a"), installedVersion: "1.0.0" },
	];

	it("TTL 内不重复请求，force 才重查", async () => {
		const c = new UpdateChecker();
		const fresh = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "2.0.0" }),
			},
		});
		await c.run(candidates, BASES, fresh, 1000);
		expect(fresh.calls).toHaveLength(1);
		await c.run(candidates, BASES, fresh, 1000 + UPDATE_CHECK_TTL_MS - 1);
		expect(fresh.calls).toHaveLength(1); // 命中缓存
		await c.run(candidates, BASES, fresh, 1000 + UPDATE_CHECK_TTL_MS);
		expect(fresh.calls).toHaveLength(2); // 过期重查
		await c.run(candidates, BASES, fresh, 1000 + UPDATE_CHECK_TTL_MS, {
			force: true,
		});
		expect(fresh.calls).toHaveLength(3);
	});

	it("列出可更新 + 统计本轮查到几条", async () => {
		const c = new UpdateChecker();
		await c.run(
			[
				...candidates,
				{ entry: officialEntry("missing"), installedVersion: "1.0.0" },
			],
			BASES,
			net,
			1000
		);
		expect(c.listUpdatable().map((r) => r.id)).toEqual(["a"]);
		expect(c.lastRoundStats()).toEqual({ requested: 2, resolved: 1 });
	});

	it("更新成功后 markUpdated 立刻消掉「可更新」", async () => {
		const c = new UpdateChecker();
		await c.run(candidates, BASES, net, 1000);
		expect(c.listUpdatable()).toHaveLength(1);
		c.markUpdated("a", "2.0.0");
		expect(c.listUpdatable()).toHaveLength(0);
		expect(c.get("a")?.installedVersion).toBe("2.0.0");
	});

	it("重查时本轮没查到的旧结论被清掉，不拿过期数据报可更新", async () => {
		const c = new UpdateChecker();
		await c.run(candidates, BASES, net, 1000);
		expect(c.get("a")?.hasUpdate).toBe(true);
		const dead = makeNet({}); // 线路全挂
		await c.run(candidates, BASES, dead, 2000, { force: true });
		expect(c.get("a")).toBeUndefined();
		expect(c.listUpdatable()).toHaveLength(0);
	});

	it("单飞：已有一轮在跑时再调返回 null", async () => {
		const c = new UpdateChecker();
		const gate: { release: () => void } = { release: () => undefined };
		const blocked = new Promise<void>((r) => {
			gate.release = r;
		});
		const slow = {
			getText: async () => {
				await blocked;
				return {
					status: 200,
					text: JSON.stringify({ id: "a", version: "2.0.0" }),
				};
			},
		};
		const first = c.run(candidates, BASES, slow, 1000);
		await Promise.resolve();
		expect(c.isRunning()).toBe(true);
		await expect(c.run(candidates, BASES, slow, 1000)).resolves.toBeNull();
		gate.release();
		await first;
		expect(c.isRunning()).toBe(false);
	});
});

/**
 * codex 代码审查（2026-08-04）指出的回归点，逐条钉住。
 */
describe("codex review 回归守卫", () => {
	it("已卸载插件的旧结论必须被清掉——否则「全部更新」会把它装回来", async () => {
		const c = new UpdateChecker();
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "2.0.0" }),
			},
			[rawHeadManifestUrl(BASES[0], "owner/b")]: {
				status: 200,
				text: JSON.stringify({ id: "b", version: "2.0.0" }),
			},
		});
		const both: UpdateCandidate[] = [
			{ entry: officialEntry("a"), installedVersion: "1.0.0" },
			{ entry: officialEntry("b"), installedVersion: "1.0.0" },
		];
		await c.run(both, BASES, net, 1000);
		expect(c.listUpdatable().map((r) => r.id).sort()).toEqual(["a", "b"]);
		// b 被用户卸载 → 下一轮候选里没有它
		await c.run([both[0]], BASES, net, 2000, { force: true });
		expect(c.get("b")).toBeUndefined();
		expect(c.listUpdatable().map((r) => r.id)).toEqual(["a"]);
	});

	it("manifest 缺 version 时换下一条线路，而不是整体判未知", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo" }), // 有 id 没 version
			},
			[rawHeadManifestUrl(BASES[1], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "4.0.0" }),
			},
		});
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net)
		).resolves.toMatchObject({ version: "4.0.0" });
	});

	it("预发布版不得被判成比正式版新（否则「更新」= 降级到 beta）", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "1.0.0-beta.1" }),
			},
		});
		const out = await checkUpdates(
			[{ entry: officialEntry("a"), installedVersion: "1.0.0" }],
			BASES,
			net
		);
		expect(out[0].hasUpdate).toBe(false);
	});

	it("从预发布升到正式版仍算可更新", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "1.0.0" }),
			},
		});
		const out = await checkUpdates(
			[{ entry: officialEntry("a"), installedVersion: "1.0.0-beta.1" }],
			BASES,
			net
		);
		expect(out[0].hasUpdate).toBe(true);
	});
});

describe("兼容性闸门（minAppVersion）", () => {
	const netWith = (minAppVersion?: string) =>
		makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "2.0.0", minAppVersion }),
			},
		});
	const cand: UpdateCandidate[] = [
		{ entry: officialEntry("a"), installedVersion: "1.0.0" },
	];

	it("新版要求的 Obsidian 更高 → 不报可更新，但标出原因", async () => {
		const out = await checkUpdates(cand, BASES, netWith("1.9.0"), {
			appVersion: "1.7.2",
		});
		expect(out[0].hasUpdate).toBe(false);
		expect(out[0].blockedByAppVersion).toBe(true);
		expect(out[0].minAppVersion).toBe("1.9.0");
	});

	it("当前 Obsidian 够新 → 正常报可更新", async () => {
		const out = await checkUpdates(cand, BASES, netWith("1.5.0"), {
			appVersion: "1.7.2",
		});
		expect(out[0].hasUpdate).toBe(true);
		expect(out[0].blockedByAppVersion).toBe(false);
	});

	it("没给 appVersion 时不做兼容性判断（保持旧行为）", async () => {
		const out = await checkUpdates(cand, BASES, netWith("9.9.9"));
		expect(out[0].hasUpdate).toBe(true);
	});
});

describe("manifest 必须自带正确 id", () => {
	it("缺 id 的 manifest 一律判未知，不照单全收它的版本号", async () => {
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ version: "9.9.9" }), // 没有 id
			},
		});
		await expect(
			fetchLatestVersion(officialEntry("foo"), BASES, net)
		).resolves.toBeNull();
	});
});

describe("缓存命中时按当前已装版本复核", () => {
	it("TTL 内插件被别的途径升级过 → 旧结论丢弃，不再报可更新", async () => {
		const c = new UpdateChecker();
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "2.0.0" }),
			},
		});
		await c.run(
			[{ entry: officialEntry("a"), installedVersion: "1.0.0" }],
			BASES,
			net,
			1000
		);
		expect(c.listUpdatable()).toHaveLength(1);
		// 用户自己装到 2.0.0 了；TTL 内再问一次 —— 前提变了必须重查，
		// 不能拿「刚被清掉的缓存」直接回答「没有更新」
		const before = net.calls.length;
		const hit = await c.run(
			[{ entry: officialEntry("a"), installedVersion: "2.0.0" }],
			BASES,
			net,
			1000 + 60_000
		);
		expect(hit).toEqual([]);
		expect(net.calls.length).toBeGreaterThan(before); // 真的重查了
		expect(c.get("a")).toMatchObject({
			installedVersion: "2.0.0",
			hasUpdate: false,
		});
	});
});

/**
 * 🔴 可达性守卫：兼容性闸门必须在**真实入口 UpdateChecker.run** 上生效。
 * 只测 checkUpdates 会漏掉「run 忘了把 appVersion 传下去」这类死代码
 * （codex 2026-08-04 实际抓到过一次）。
 */
describe("UpdateChecker.run 必须把 appVersion 透传下去", () => {
	it("run(appVersion) 生效：不兼容的新版不进可更新列表", async () => {
		const c = new UpdateChecker();
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({
					id: "a",
					version: "2.0.0",
					minAppVersion: "9.9.9",
				}),
			},
		});
		const out = await c.run(
			[{ entry: officialEntry("a"), installedVersion: "1.0.0" }],
			BASES,
			net,
			1000,
			{ appVersion: "1.7.2" }
		);
		expect(out).toEqual([]);
		expect(c.get("a")?.blockedByAppVersion).toBe(true);
		expect(c.listBlocked().map((r) => r.id)).toEqual(["a"]);
	});
});

describe("确认「无新版」时的问询上限", () => {
	it("最多问 2 条能答上来的线路，挂掉的线路不占名额", async () => {
		const FIVE = ["https://r1", "https://r2", "https://r3", "https://r4"];
		const net = makeNet({
			// r1 挂（不占名额）
			[rawHeadManifestUrl(FIVE[1], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.0.0" }),
			},
			[rawHeadManifestUrl(FIVE[2], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.0.0" }),
			},
			[rawHeadManifestUrl(FIVE[3], "owner/foo")]: {
				status: 200,
				text: JSON.stringify({ id: "foo", version: "1.0.0" }),
			},
		});
		await expect(
			fetchLatestVersion(officialEntry("foo"), FIVE, net, "1.0.0")
		).resolves.toMatchObject({ version: "1.0.0" });
		// r1(失败) + r2 + r3 = 3 次请求后达到 2 条有效回答，不再问 r4
		expect(net.calls).toHaveLength(3);
	});
});

describe("手机端不装 desktop-only 的新版", () => {
	const net = makeNet({
		[rawHeadManifestUrl(BASES[0], "owner/a")]: {
			status: 200,
			text: JSON.stringify({ id: "a", version: "2.0.0", isDesktopOnly: true }),
		},
	});
	const cand: UpdateCandidate[] = [
		{ entry: officialEntry("a"), installedVersion: "1.0.0" },
	];

	it("手机端：新版改成仅桌面 → 不提示可更新", async () => {
		const out = await checkUpdates(cand, BASES, net, { isMobile: true });
		expect(out[0].hasUpdate).toBe(false);
		expect(out[0].blockedByAppVersion).toBe(true);
	});

	it("桌面端：照常可更新", async () => {
		const out = await checkUpdates(cand, BASES, net, { isMobile: false });
		expect(out[0].hasUpdate).toBe(true);
	});
});

describe("markUpdated 不许伪造没做过的检查", () => {
	it("没查过就装了一次 → 不留「已是最新」结论", () => {
		const c = new UpdateChecker();
		c.markUpdated("never-checked", "1.0.0");
		expect(c.get("never-checked")).toBeUndefined();
	});

	it("查过的条目：改写已装版本并重算 hasUpdate", async () => {
		const c = new UpdateChecker();
		const net = makeNet({
			[rawHeadManifestUrl(BASES[0], "owner/a")]: {
				status: 200,
				text: JSON.stringify({ id: "a", version: "2.0.0" }),
			},
		});
		await c.run(
			[{ entry: officialEntry("a"), installedVersion: "1.0.0" }],
			BASES,
			net,
			1000
		);
		c.markUpdated("a", "2.0.0");
		expect(c.get("a")).toMatchObject({
			installedVersion: "2.0.0",
			latestVersion: "2.0.0",
			hasUpdate: false,
		});
	});
});
