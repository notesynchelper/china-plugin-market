/**
 * 轻量日志器：debug/info 仅开发模式输出，warn/error 始终输出。
 * 开发模式由 esbuild define 的 process.env.DEV_MODE 决定（默认 false）。
 */

const isDev = (() => {
	try {
		return process.env.DEV_MODE === "true";
	} catch {
		return false;
	}
})();

export class Logger {
	private static dev = isDev;

	static setDevMode(devMode: boolean): void {
		Logger.dev = devMode;
	}

	static debug(...args: unknown[]): void {
		if (Logger.dev) console.debug(...args);
	}

	static warn(...args: unknown[]): void {
		console.warn(...args);
	}

	static error(...args: unknown[]): void {
		console.error(...args);
	}
}

export const log = (...args: unknown[]): void => Logger.debug(...args);
export const logWarn = (...args: unknown[]): void => Logger.warn(...args);
export const logError = (...args: unknown[]): void => Logger.error(...args);
