import { createOptimisedBundleEnv } from "../_helpers/stubs/TestEnvironment";

describe("FlatAPItest", () => {
	it("Should create a simple univeral API", () => {
		return createOptimisedBundleEnv({
			project: {
				files: {
					"index.js": `exports.something = require("./foo")`,
					"foo.js": "module.exports = { result : '1'}",
				},

				instructions: "index.js",
			},
		}).then(result => {
			const first = result.window.$fsx.r(0);
			expect(first).toEqual({ something: { result: "1" } });
		});
	});

	it("Should give directory name", () => {
		return createOptimisedBundleEnv({
			project: {
				files: {
					"index.js": `exports.out = __dirname`,
				},

				instructions: "index.js",
			},
		}).then(result => {
			const first = result.window.$fsx.r(0);
			expect(first).toEqual({ out: "." });
		});
	});

	it("Should give filename", () => {
		return createOptimisedBundleEnv({
			project: {
				files: {
					"index.js": `exports.out = __filename`,
				},

				instructions: "index.js",
			},
		}).then(result => {
			const first = result.window.$fsx.r(0);
			expect(first).toEqual({ out: "index.js" });
		});
	});

	it("Should execute an entry point", () => {
		let random = new Date().getTime().toString();
		return createOptimisedBundleEnv({
			project: {
				files: {
					"index.ts": `
                        window.executed = "${random}";
                        module.export = {hello : "world" }
                    `,
				},
				instructions: "> index.ts",
			},
		}).then(result => {
			expect(result.window.executed).toEqual(random);
		});
	});

	it("Should execute twice without errors", () => {
		return createOptimisedBundleEnv({
			project: {
				files: {
					"index.js": `exports.something = require("./foo")`,
					"foo.js": "module.exports = { result : '1'}",
				},
				instructions: "> index.js",
			},
		}).then(result => {
			const first = result.window.$fsx.r(0);
			expect(first).toEqual({ something: { result: "1" } });
		});
	});

	it("Should bundle a partial function", () => {
		// gets a module from src/tests/stubs/test_modules/fbjs
		return createOptimisedBundleEnv({
			stubs: true,
			project: {
				files: {
					"index.js": `exports.something = require("fbjs/lib/emptyFunction")()`,
				},
				instructions: "index.js",
			},
		}).then(result => {
			const first = result.window.$fsx.r(0);
			expect(first).toEqual({ something: "I am empty" });
		});
	});

	it("Should bundle a partial require on a scoped repository", () => {
		// gets a module from src/tests/stubs/test_modules/@bar
		return createOptimisedBundleEnv({
			stubs: true,
			project: {
				files: {
					"index.js": `exports.something = require("@bar/animations/browser")`,
				},
				instructions: "index.js",
			},
		}).then(result => {
			const first = result.window.$fsx.r(0);

			expect(first).toEqual({ something: { hello: "@bar/animations/browser" } });
		});
	});

	it("Should bundle a partial require on a scoped (with valid naming) repository", () => {
		// gets a module from src/tests/stubs/test_modules/@bar.foo
		return createOptimisedBundleEnv({
			stubs: true,
			project: {
				files: {
					"index.js": `exports.something = require("@bar.foo/animations/browser")`,
				},
				instructions: "index.js",
			},
		}).then(result => {
			const first = result.window.$fsx.r(0);
			expect(first).toEqual({ something: { hello: "@bar/animations/browser" } });
		});
	});
});
