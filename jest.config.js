process.env.TZ = "UTC";

module.exports = {
	testEnvironment: "node",
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
