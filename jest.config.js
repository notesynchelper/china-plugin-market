process.env.TZ = "UTC";

module.exports = {
	// jsdom：插件跑在 Electron/WebView 里，源码用 window.setTimeout 等
	// window 定时器（Obsidian 弹出窗口兼容要求），node 环境下没有 window
	testEnvironment: "jsdom",
	roots: ["<rootDir>/tests"],
	moduleFileExtensions: ["ts", "js"],
	testRegex: "(/__tests__/.*|(\\.|/)(test|spec))\\.(jsx?|tsx?)$",
	testPathIgnorePatterns: ["/node_modules/"],
	moduleNameMapper: {
		"^obsidian$": "<rootDir>/src/__mocks__/obsidian.ts",
	},
	transform: {
		"^.+\\.tsx?$": ["ts-jest", { tsconfig: { isolatedModules: true } }],
	},
};
