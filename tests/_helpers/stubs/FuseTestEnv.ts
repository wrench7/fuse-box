import * as appRoot from "app-root-path";
import { fork } from "child_process";
import * as fs from "fs-extra";
import * as path from "path";
import { Bundle, BundleProducer, FuseBox } from "../../../src";
import { UserOutputResult } from "../../../src/core/UserOutput";
import { removeFolder } from "../../../src/Utils";

const jsdom = require("jsdom");

function createTestFolders(customFolder: string): { root; homeDir; dist } {
	let root = path.join(
		appRoot.path,
		".fusebox",
		"tests",
		new Date().getTime().toString() + "_" + Math.random() + "_" + Math.random(),
	);
	fs.ensureDirSync(root);

	const homeDir = path.join(root, "src");
	fs.ensureDirSync(homeDir);

	const output = path.join(root, "dist");
	fs.ensureDirSync(output);
	return {
		root: root,
		homeDir: homeDir,
		dist: output,
	};
}

function createFiles(dir: string, files: any) {
	for (let name in files) {
		const content = files[name];
		const filePath = path.join(dir, name);
		fs.ensureDirSync(path.dirname(filePath));
		fs.writeFileSync(filePath, content);
	}
}
export function createRealNodeModule(name: string, files: any) {
	const path2Module = path.join(appRoot.path, "node_modules", name);
	if (fs.existsSync(path2Module)) {
		removeFolder(path2Module);
	}
	fs.ensureDirSync(path2Module);
	createFiles(path2Module, files);
}

export class ScriptTest {
	public contents: string;
	constructor(public result: UserOutputResult) {}

	private load() {
		if (!this.contents) {
			this.contents = fs.readFileSync(this.result.path).toString();
		}
	}

	public getContents() {
		this.load();
		return this.contents;
	}

	public shouldFindString(str: string) {
		this.load();
		if (this.contents.indexOf(str) === -1) {
			throw new Error(`Expected string "${str}" was not found`);
		}
	}

	public shouldNotFindString(str: string) {
		this.load();
		if (this.contents.indexOf(str) > -1) {
			throw new Error(`Expected string "${str}" was not expected to be found`);
		}
	}
}
export class FuseTestEnv {
	public fuse: FuseBox;
	public window: any;
	public producer: BundleProducer;
	public dirs: { root; homeDir; dist };
	public scripts = new Map<string, ScriptTest>();

	constructor(config: any) {
		this.dirs = createTestFolders(config.testFolder);
		const basicConfig = {
			homeDir: this.dirs.homeDir,
			log: false,
			output: `${this.dirs.dist}/$name.js`,
		};
		config.project = config.project || {};
		config.ensureTsConfig = false;

		if (config.project.fromStubs) {
			basicConfig.homeDir = path.join(appRoot.path, "tests/_helpers/stubs/cases/", config.project.fromStubs);
			this.dirs.homeDir = basicConfig.homeDir;
		} else {
			createFiles(this.dirs.homeDir, config.project.files);
		}

		if (config.project.distFiles) {
			createFiles(this.dirs.dist, config.project.distFiles);
		}

		config = Object.assign(basicConfig, config.project || {});
		this.fuse = FuseBox.init(config);
	}

	public simple(instructions: string = "> index.ts", conf?: (bundle: Bundle) => void): Promise<FuseTestEnv> {
		const bundle = this.fuse.bundle("app").instructions(instructions);
		if (conf) {
			conf(bundle);
		}
		return this.fuse.run().then(producer => {
			this.producer = producer;
			return this;
		});
	}

	public config(fn: { (fuse: FuseBox): any }): Promise<FuseTestEnv> {
		return Promise.resolve(fn(this.fuse))
			.then(() => this.fuse.run())
			.then(producer => {
				this.producer = producer;
				return this;
			});
	}

	public server(message, fn: { (response): any }, preloadScriptPath?: string): Promise<FuseTestEnv> {
		return new Promise((resolve, reject) => {
			const scripts = [];

			if (preloadScriptPath) {
				scripts.push(fs.readFileSync(path.join(appRoot.path, preloadScriptPath)).toString());
			}

			const bundles = this.producer.sortBundles();
			bundles.forEach(bundle => {
				if (bundle.webIndexed) {
					let contents = fs.readFileSync(bundle.context.output.lastPrimaryOutput.path).toString();
					scripts.push(contents);
				}
			});
			scripts.push(message);
			const forkedFile = path.join(this.dirs.dist, "__isolated_fork.js");
			fs.writeFileSync(forkedFile, scripts.join("\n"));
			const proc = fork(forkedFile);
			proc.on("message", m => {
				return resolve(fn(m));
			});
			proc.on("data", data => {
				console.log(`stdout: ${data}`);
			});
		});
	}

	public getScript(name: string): ScriptTest {
		return this.scripts.get(name);
	}

	public fileShouldExist(name: string) {
		const f = path.join(this.dirs.dist, name);
		if (!fs.existsSync(f)) {
			throw new Error(`File ${f} was not found`);
		}
		return f;
	}

	public getDistContent(name: string) {
		const f = this.fileShouldExist(name);
		return fs.readFileSync(f).toString();
	}

	public scriptShouldExist(name: string) {
		if (!this.getScript(name)) {
			throw new Error(`Script ${name} should exist`);
		}
	}
	public scriptShouldNotExist(name: string) {
		if (this.getScript(name)) {
			throw new Error(`Script ${name} should not exist`);
		}
	}

	public delay(ms = 100) {
		return new Promise((resolve, reject) => {
			setTimeout(() => {
				return resolve(ms);
			}, ms);
		});
	}

	public async browser(
		fn: { (window: any, test: FuseTestEnv): any },
		preloadScriptPath?: string,
	): Promise<FuseTestEnv> {
		const scripts = [path.join(appRoot.path, "tests/_helpers/stubs/DummyXMLHttpRequest.js")];
		const bundles = this.producer.sortBundles();

		if (preloadScriptPath) {
			scripts.push(path.join(appRoot.path, preloadScriptPath));
		}

		bundles.forEach(bundle => {
			this.scripts.set(
				bundle.context.output.lastPrimaryOutput.relativePath,
				new ScriptTest(bundle.context.output.lastPrimaryOutput),
			);
			if (bundle.webIndexed) {
				scripts.push(bundle.context.output.lastPrimaryOutput.path);
			}
		});
		const webIndexFile = path.join(this.dirs.dist, "index.html");
		let indexContent = `<html>
		<head>
		</head><body></body></html>
`;

		await this.delay(20);
		if (fs.existsSync(webIndexFile)) {
			indexContent = fs.readFileSync(webIndexFile).toString();
		}

		return new Promise<any>((resolve, reject) => {
			jsdom.env({
				html: indexContent,
				scripts: scripts,
				//virtualConsole: jsdom.createVirtualConsole().sendTo(console),
				done: (err, window) => {
					window.loadLinkTags = () => {
						return new Promise((resolve, reject) => {
							setTimeout(() => {
								const items = window.document.querySelectorAll("link");
								const links = [];
								for (const i in items) {
									const item = items[i];
									if (item.attributes && item.attributes.href) {
										links.push(item.attributes.href.value);
									}
								}
								return resolve(links);
							}, 50);
						});
					};
					window.__ajax = (url, fn) => {
						if (/^http(s)\:/.test(url)) {
							return fn(
								200,
								`module.exports = {  someText : "External lib", from : () => {}, someFunction : () => {}}`,
							);
						}
						const target = path.join(this.dirs.dist, url);
						if (fs.existsSync(target)) {
							return fn(200, fs.readFileSync(target).toString());
						}
						return fn(404, "Not found");
					};
					if (err) {
						return reject(err);
					}
					return resolve(fn(window, this));
				},
			});
		});
	}

	public static create(config) {
		return new FuseTestEnv(config);
	}
}
