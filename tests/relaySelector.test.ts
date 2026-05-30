import {
	relaysToBases,
	raceProbe,
	selectFastestBase,
	getOrderedFallbackBases,
	normalizeBase,
	BOOTSTRAP_RELAYS,
	clearRelayCache,
	__resetForTests,
	type RelaySelectorDeps,
} from "../src/relaySelector";

const makeStorage = () => {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
		setItem: (k: string, v: string) => {
			m.set(k, v);
		},
		removeItem: (k: string) => {
			m.delete(k);
		},
		_map: m,
	};
};

const makeDeps = (
	statusByUrl: (url: string) => number,
	storage = makeStorage()
): RelaySelectorDeps => ({
	requestFn: async (url: string) => ({ status: statusByUrl(url) }),
	storage,
	now: () => 1000,
	timeoutMs: 50,
});

beforeEach(() => {
	__resetForTests();
});

describe("relaysToBases", () => {
	it("空输入回退 bootstrap", () => {
		expect(relaysToBases()).toEqual(
			BOOTSTRAP_RELAYS.map((r) => normalizeBase(r.base))
		);
	});

	it("过滤 enabled=false、去重、去末尾斜杠", () => {
		const bases = relaysToBases([
			{ id: "a", base: "https://a.test/" },
			{ id: "b", base: "https://b.test", enabled: false },
			{ id: "a2", base: "https://a.test" }, // 与第一个重复
			{ id: "c", base: "https://c.test" },
		]);
		expect(bases).toEqual(["https://a.test", "https://c.test"]);
	});
});

describe("raceProbe", () => {
	it("返回第一个 200 的 base", async () => {
		const deps = makeDeps((url) =>
			url.includes("good.test") ? 200 : 500
		);
		const r = await raceProbe(
			["https://bad.test", "https://good.test"],
			deps
		);
		expect(r?.base).toBe("https://good.test");
		expect(r?.ok).toBe(true);
	});

	it("全失败返回 null", async () => {
		const deps = makeDeps(() => 500);
		const r = await raceProbe(["https://a.test", "https://b.test"], deps);
		expect(r).toBeNull();
	});
});

describe("selectFastestBase", () => {
	it("选中并写缓存，第二次命中缓存", async () => {
		const storage = makeStorage();
		const deps = makeDeps(
			(url) => (url.includes("relay-2") ? 200 : 500),
			storage
		);
		const bases = ["https://relay-1.x", "https://relay-2.x"];
		const first = await selectFastestBase(bases, deps);
		expect(first).toBe("https://relay-2.x");
		expect(storage.getItem("plugin-market-cn:relayCache")).toContain("relay-2");

		// 第二次：即使全部 500 也用缓存
		const deps2 = makeDeps(() => 500, storage);
		const second = await selectFastestBase(bases, deps2);
		expect(second).toBe("https://relay-2.x");
	});

	it("缓存 base 不在候选池则忽略", async () => {
		const storage = makeStorage();
		storage.setItem(
			"plugin-market-cn:relayCache",
			JSON.stringify({ base: "https://old.x", latencyMs: 1, chosenAt: 1000 })
		);
		const deps = makeDeps(
			(url) => (url.includes("relay-1") ? 200 : 500),
			storage
		);
		const chosen = await selectFastestBase(["https://relay-1.x"], deps);
		expect(chosen).toBe("https://relay-1.x");
	});

	it("全挂时回退候选池首位（不写缓存）", async () => {
		const storage = makeStorage();
		const deps = makeDeps(() => 500, storage);
		const chosen = await selectFastestBase(
			["https://relay-1.x", "https://relay-2.x"],
			deps
		);
		expect(chosen).toBe("https://relay-1.x");
		expect(storage.getItem("plugin-market-cn:relayCache")).toBeNull();
	});
});

describe("getOrderedFallbackBases", () => {
	it("primary 在首，其余跟随", async () => {
		const deps = makeDeps((url) => (url.includes("relay-2") ? 200 : 500));
		clearRelayCache(deps);
		const ordered = await getOrderedFallbackBases(
			["https://relay-1.x", "https://relay-2.x", "https://relay-3.x"],
			deps
		);
		expect(ordered[0]).toBe("https://relay-2.x");
		expect(ordered).toHaveLength(3);
		expect(new Set(ordered).size).toBe(3);
	});
});
