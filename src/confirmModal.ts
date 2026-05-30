import { App, Modal } from "obsidian";

/** 简单确认弹窗，resolve(true/false) */
export class ConfirmModal extends Modal {
	private title: string;
	private body: string;
	private resolved = false;
	private resolver: (v: boolean) => void;

	constructor(
		app: App,
		title: string,
		body: string,
		resolver: (v: boolean) => void
	) {
		super(app);
		this.title = title;
		this.body = body;
		this.resolver = resolver;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.title });
		for (const line of this.body.split("\n")) {
			contentEl.createEl("p", { text: line });
		}
		const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = btnRow.createEl("button", { text: "取消" });
		cancel.onclick = () => {
			this.finish(false);
		};
		const ok = btnRow.createEl("button", { text: "确认", cls: "mod-cta" });
		ok.onclick = () => {
			this.finish(true);
		};
	}

	private finish(v: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolver(v);
		this.close();
	}

	onClose(): void {
		// 用户直接关闭视为取消
		if (!this.resolved) {
			this.resolved = true;
			this.resolver(false);
		}
		this.contentEl.empty();
	}
}

/** 便捷 promise 化 */
export const confirmDialog = (
	app: App,
	title: string,
	body: string
): Promise<boolean> =>
	new Promise((resolve) => {
		new ConfirmModal(app, title, body, resolve).open();
	});
