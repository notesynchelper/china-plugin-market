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

		// 加速线路（不显示具体节点）+ 重新测速
		new Setting(containerEl)
			.setName("加速线路")
			.setDesc("自动选择响应最快的加速线路")
			.addButton((btn) =>
				btn.setButtonText("重新测速").onClick(async () => {
					btn.setDisabled(true);
					try {
						// 全部线路探测失败时会回退到第一条且不写缓存 —— 那不叫「已切换到最快线路」
						const { ok } = await this.plugin.reprobeNodes();
						new Notice(
							ok
								? "测速完成，已选择响应最快的线路"
								: "测速失败，暂时继续使用当前线路"
						);
					} finally {
						btn.setDisabled(false);
					}
				})
			);

		new Setting(containerEl)
			.setName("显示额外收录插件")
			.setDesc("显示并允许安装未收录在 Obsidian 社区插件目录中的插件")
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
			.setName("允许外部链接打开商店")
			.setDesc(
				// 注意：obsidian:// 协议不告诉我们是哪个网页发起的，所以不能承诺
				// 「只有官网能调起」；能保证的是安装前必弹确认 + 直链来源限产品自有域
				"允许外部链接打开商店或发起插件安装；安装前会再次确认，直链插件的下载地址仅限产品自有域名"
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enableDeeplink).onChange(async (v) => {
					this.plugin.settings.enableDeeplink = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("自动检查插件加速商店更新")
			.setDesc("启动 Obsidian 时检查本插件新版本，确认后再更新")
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
			.setName("检查已安装插件更新")
			.setDesc(
				"检查本商店中其他已安装插件的更新；结果显示在商店「已安装」页，可逐个更新或全部更新"
			)
			.addButton((btn) =>
				btn.setButtonText("立即检查").onClick(() => {
					void this.plugin.checkInstalledUpdates(true, true);
				})
			);

		new Setting(containerEl)
			.setName("商店配置地址（高级）")
			.setDesc(
				"使用指定的 marketplace-config.json；仅支持产品自有域名的 HTTPS 地址，留空则使用默认地址"
			)
			.addText((txt) =>
				txt
					.setPlaceholder("https://…/marketplace-config.json")
					.setValue(this.plugin.settings.customConfigUrl)
					.onChange(async (v) => {
						const val = v.trim();
						// 不阻止输入，只做视觉提示；保存时仍写入，
						// registry 侧会再次校验并忽略非法值
						txt.inputEl.toggleClass(
							"pmcn-input-invalid",
							!!val && !isAllowedUrl(val)
						);
						this.plugin.settings.customConfigUrl = val;
						this.plugin.registry.invalidate();
						await this.plugin.saveSettings();
					})
			);
	}
}
