/**
 * 测试用 obsidian 模块替身。仅覆盖被单测模块 import 的符号。
 * 核心逻辑走依赖注入（net/adapter），故这里的 requestUrl 只是占位。
 */

export interface RequestUrlResponse {
	status: number;
	text: string;
	json: unknown;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
}

export function requestUrl(): Promise<RequestUrlResponse> {
	return Promise.resolve({
		status: 200,
		text: "",
		json: null,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
	});
}

/** 真实 Obsidian 导出的当前版本号（如 '1.7.2'） */
export const apiVersion = "1.7.2";

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export class Notice {
	message: string;
	constructor(message?: string | DocumentFragment) {
		this.message = typeof message === "string" ? message : "";
	}
	setMessage(message: string | DocumentFragment): this {
		this.message = typeof message === "string" ? message : "";
		return this;
	}
	hide(): void {
		/* no-op */
	}
}

/* 下列 UI 基类只为 import 解析；单测不实例化它们。 */
export class Plugin {}
export class Component {}
export class ItemView {}
export class Modal {}
export class PluginSettingTab {}
export class Setting {}
export class WorkspaceLeaf {}
export class App {}
export class TFile {}
export class TFolder {}

export function setIcon(): void {
	/* no-op */
}
export function addIcon(): void {
	/* no-op */
}
