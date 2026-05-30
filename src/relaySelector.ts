/**
 * relaySelector — relay-1..5 自动测速与选择（改造自 obsidian-plug/src/endpointSelector.ts）。
 *
 *  1. 候选池来自 marketplace-config.relays（bootstrap 兜底硬编码 relay-1/2）
 *  2. 并发探测 GET <base>/plugin-market/health，首个 200 胜出
 *  3. 结果缓存到 localStorage，1h TTL（缓存的 base 必须仍在当前候选池里才有效）
 *  4. 请求连续失败累计到阈值 → 清缓存，下次重测
 *  5. relay-3..5 DNS 未建时探测必失败，自动跳过——零客户端改动即可后续接入
 */

import { requestUrl } from "obsidian";
import { log, logError } from "./logger";
import type { RelayNode } from "./types";

/** bootstrap 候选：拉到 marketplace-config 之前用它探测、取配置 */
export const BOOTSTRAP_RELAYS: readonly RelayNode[] = [
	{ id: "relay-1", base: "https://relay-1.bijitongbu.site" },
	{ id: "relay-2", base: "https://relay-2.bijitongbu.site" },
] as const;

export const PROBE_PATH = "/plugin-market/health";
export const PROBE_TIMEOUT_MS = 3000;
export const CACHE_TTL_MS = 60 * 60 * 1000;
export const FAILURE_THRESHOLD = 3;

const CACHE_KEY = "plugin-market-cn:relayCache";

export interface RelaySelectorDeps {
	requestFn: (url: string) => Promise<{ status: number }>;
	storage: {
		getItem(key: string): string | null;
		setItem(key: string, value: string): void;
		removeItem(key: string): void;
	};
	now: () => number;
	timeoutMs?: number;
}

export interface RelayCache {
	base: string;
	latencyMs: number;
	chosenAt: number;
}

export interface ProbeResult {
	base: string;
	ok: boolean;
	latencyMs: number;
	error?: string;
}

/** 去掉末尾斜杠，统一 base 形态 */
export const normalizeBase = (base: string): string => base.replace(/\/+$/, "");

/** 从 RelayNode[] 取出启用节点的 base（去重、规整）；空则用 bootstrap */
export const relaysToBases = (relays?: readonly RelayNode[]): string[] => {
	const src = relays && relays.length ? relays : BOOTSTRAP_RELAYS;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of src) {
		if (r.enabled === false) continue;
		if (!r.base) continue;
		const b = normalizeBase(r.base);
		if (seen.has(b)) continue;
		seen.add(b);
		out.push(b);
	}
	return out.length ? out : BOOTSTRAP_RELAYS.map((r) => normalizeBase(r.base));
};

const defaultStorage = {
	getItem(key: string): string | null {
		try {
			return window.localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	setItem(key: string, value: string): void {
		try {
			window.localStorage.setItem(key, value);
		} catch {
			/* noop（移动端/隐私模式偶发） */
		}
	},
	removeItem(key: string): void {
		try {
			window.localStorage.removeItem(key);
		} catch {
			/* noop */
		}
	},
};

const defaultRequestFn = async (url: string): Promise<{ status: number }> => {
	const resp = await requestUrl({ url, method: "GET" });
	return { status: resp.status };
};

const defaultDeps: RelaySelectorDeps = {
	requestFn: defaultRequestFn,
	storage: defaultStorage,
	now: () => Date.now(),
	timeoutMs: PROBE_TIMEOUT_MS,
};

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`probe timeout ${ms}ms`)),
			ms
		);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			}
		);
	});

/** 探测单个 base，不抛异常（ok=false 即失败）。仅 HTTP 200 算健康。 */
export const probeBase = async (
	base: string,
	deps: RelaySelectorDeps = defaultDeps
): Promise<ProbeResult> => {
	const url = normalizeBase(base) + PROBE_PATH;
	const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
	const start = deps.now();
	try {
		const resp = await withTimeout(deps.requestFn(url), timeoutMs);
		const latencyMs = deps.now() - start;
		const ok = resp.status === 200;
		return { base, ok, latencyMs, error: ok ? undefined : `status=${resp.status}` };
	} catch (err) {
		const latencyMs = deps.now() - start;
		return {
			base,
			ok: false,
			latencyMs,
			error: err instanceof Error ? err.message : String(err),
		};
	}
};

/** 并发探测，返回第一个 ok 的；全失败返回 null */
export const raceProbe = async (
	bases: readonly string[],
	deps: RelaySelectorDeps = defaultDeps
): Promise<ProbeResult | null> => {
	if (bases.length === 0) return null;
	return new Promise<ProbeResult | null>((resolve) => {
		let settled = false;
		let remaining = bases.length;
		const finish = (result: ProbeResult | null) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		bases.forEach((base) => {
			probeBase(base, deps).then(
				(r) => {
					if (r.ok) {
						finish(r);
						return;
					}
					remaining -= 1;
					if (remaining === 0) finish(null);
				},
				() => {
					remaining -= 1;
					if (remaining === 0) finish(null);
				}
			);
		});
	});
};

const readCache = (
	bases: readonly string[],
	deps: RelaySelectorDeps
): RelayCache | null => {
	const raw = deps.storage.getItem(CACHE_KEY);
	if (!raw) return null;
	try {
		const obj = JSON.parse(raw) as RelayCache;
		if (!obj || typeof obj.base !== "string" || typeof obj.chosenAt !== "number")
			return null;
		if (deps.now() - obj.chosenAt > CACHE_TTL_MS) return null;
		// 缓存的 base 必须仍在当前候选池里（配置可能换了节点）
		if (!bases.includes(normalizeBase(obj.base))) return null;
		return obj;
	} catch {
		return null;
	}
};

let consecutiveFailures = 0;

/**
 * 选当前应优先用的 base：
 * - 命中缓存且 base 仍在候选池 → 用缓存
 * - 否则 raceProbe → 写缓存；全挂时返回候选池[0]（不写缓存）
 */
export const selectFastestBase = async (
	bases: readonly string[],
	deps: RelaySelectorDeps = defaultDeps
): Promise<string> => {
	const pool = bases.length ? bases.map(normalizeBase) : relaysToBases();
	const cached = readCache(pool, deps);
	if (cached) {
		log("🔧 relaySelector 命中缓存:", cached.base);
		return cached.base;
	}
	const result = await raceProbe(pool, deps);
	if (result) {
		deps.storage.setItem(
			CACHE_KEY,
			JSON.stringify({
				base: result.base,
				latencyMs: result.latencyMs,
				chosenAt: deps.now(),
			})
		);
		consecutiveFailures = 0;
		log("🔧 relaySelector 选中:", result.base, `${result.latencyMs}ms`);
		return result.base;
	}
	logError("relaySelector 所有候选都失败，回退:", pool[0]);
	return pool[0];
};

/** 返回「优先 base + 其余候选」去重列表，供逐一重试 */
export const getOrderedFallbackBases = async (
	bases: readonly string[],
	deps: RelaySelectorDeps = defaultDeps
): Promise<string[]> => {
	const pool = (bases.length ? bases.map(normalizeBase) : relaysToBases());
	const primary = await selectFastestBase(pool, deps);
	const rest = pool.filter((b) => b !== primary);
	return [primary, ...rest];
};

/** 一整轮（所有 base 都挂）失败时调用，累计到阈值清缓存 */
export const notifyRequestFailure = (
	deps: RelaySelectorDeps = defaultDeps
): void => {
	consecutiveFailures += 1;
	if (consecutiveFailures >= FAILURE_THRESHOLD) {
		log("🔧 relaySelector 连续失败阈值触发，清缓存");
		deps.storage.removeItem(CACHE_KEY);
		consecutiveFailures = 0;
	}
};

/** 任意成功时调用，归零失败计数 */
export const notifyRequestSuccess = (): void => {
	consecutiveFailures = 0;
};

export const clearRelayCache = (deps: RelaySelectorDeps = defaultDeps): void => {
	deps.storage.removeItem(CACHE_KEY);
	consecutiveFailures = 0;
};

export const peekRelayCache = (
	deps: RelaySelectorDeps = defaultDeps
): RelayCache | null => {
	const raw = deps.storage.getItem(CACHE_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as RelayCache;
	} catch {
		return null;
	}
};

/** 测试用：重置内部计数器 */
export const __resetForTests = (): void => {
	consecutiveFailures = 0;
};
