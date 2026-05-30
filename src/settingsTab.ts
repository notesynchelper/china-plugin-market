import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type PluginMarketPlugin from "./main";
import { isAllowedUrl } from "./whitelist";

export class PluginMarketSettingTab extends PluginSettingTab {
	private plugin: PluginMarketPlugin;

	constructor(app: App, plugin: PluginMarketPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "插件加速商店" });

		// 加速线路（不显示具体节点）+ 重新测速
		new Setting(containerEl)
			.setName("加速线路")
			.setDesc("自动选择最快加速线路")
			.addButton((btn) =>
				btn.setButtonText("重新测速").onClick(async () => {
					btn.setDisabled(true);
					await this.plugin.reprobeNodes();
					new Notice("已重新测速，已切换到最快线路");
					btn.setDisabled(false);
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("启用特殊导入")
			.setDesc("展示并允许安装服务端配置注入的非官方插件")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.enableSpecialImports)
					.onChange(async (v) => {
						this.plugin.settings.enableSpecialImports = v;
						this.plugin.registry.invalidate();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("启用调起链接")
			.setDesc(
				"允许官网（产品自有白名单域）通过 obsidian://plugin-market-cn 链接打开商店 / 安装插件"
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enableDeeplink).onChange(async (v) => {
					this.plugin.settings.enableDeeplink = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("启用插件自更新")
			.setDesc("启动时检查本插件新版本，确认后下载并原子替换")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enableSelfUpdate).onChange(async (v) => {
					this.plugin.settings.enableSelfUpdate = v;
					await this.plugin.saveSettings();
				})
			)
			.addButton((btn) =>
				btn.setButtonText("立即检查").onClick(() => {
					void this.plugin.runSelfUpdateCheck(true);
				})
			);

		new Setting(containerEl)
			.setName("自定义清单地址（高级）")
			.setDesc(
				"覆盖 marketplace-config.json 来源；必须是产品自有白名单域 https 链接，留空用默认"
			)
			.addText((txt) =>
				txt
					.setPlaceholder("https://…/marketplace-config.json")
					.setValue(this.plugin.settings.customConfigUrl)
					.onChange(async (v) => {
						const val = v.trim();
						if (val && !isAllowedUrl(val)) {
							// 不阻止输入，但提示；保存时仍写入，registry 侧会再次校验并忽略非法值
							txt.inputEl.style.borderColor = "var(--color-red)";
						} else {
							txt.inputEl.style.borderColor = "";
						}
						this.plugin.settings.customConfigUrl = val;
						this.plugin.registry.invalidate();
						await this.plugin.saveSettings();
					})
			);
	}
}
