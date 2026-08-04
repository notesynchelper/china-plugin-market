// 复现 Obsidian 官方插件审查（eslint-plugin-obsidianmd）用的本地配置。
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{
		// 审查只看发行代码；tests/ 是 jest 环境（describe/it 全局），不参与
		ignores: ["main.js", "tests/**", "node_modules/**"],
	},
	...obsidianmd.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
		},
	},
	{
		// 构建/测试脚本跑在 Node 里，不进插件产物
		files: ["*.config.mjs", "*.config.js"],
		languageOptions: {
			globals: { process: "readonly", module: "writable", require: "readonly" },
		},
	},
]);
