/**
 * 轻量日志器：debug/info 仅开发模式输出，warn/error 始终输出。
 * 开发模式由 esbuild define 注入的裸标识符 __DEV_MODE__ 决定（默认 false）。
 */
declare const __DEV_MODE__: string | undefined;

const isDev = typeof __DEV_MODE__ === "string" && __DEV_MODE__ === "true";

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
