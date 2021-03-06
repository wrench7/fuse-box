import { WorkFlowContext } from "./WorkflowContext";
import * as path from "path";
import { ensureUserPath, findFileBackwards, ensureFuseBoxPath, ensureAbsolutePath, tsKeyPath2RegExp } from "../Utils";
import { ScriptTarget } from "./File";
import * as fs from "fs";
import { Config } from "../Config";
import * as ts from "typescript";

const CACHED: { [path: string]: any } = {};

/**
 * Typecheck custom tsconfig provided as array.
 * It's Compiler options but replaced enums to equivalent strings keys
 * as it'd be seen in a `tsconfig.json` file
 * Check `typescript.d.ts`:
 * - `CompilerOptionsValue`
 * - `CompilerOptions`
 * e.g:
 * - Instead of `target: 1`, user can input `target: 'ES5'`
 */
export type rawScriptTarget = Exclude<keyof typeof ts.ScriptTarget, "JSON" | "Latest">;
export type rawCompilerOptions = {
	[key in keyof ts.CompilerOptions]: key extends "maxNodeModuleJsDepth"
		? number
		: ts.CompilerOptions[key] extends ts.ScriptTarget
			? rawScriptTarget
			: ts.CompilerOptions[key] extends ts.JsxEmit
				? "react" | "preserve" | "react-native"
				: ts.CompilerOptions[key] extends ts.ModuleKind
					? keyof typeof ts.ModuleKind
					: ts.CompilerOptions[key] extends ts.ModuleResolutionKind
						? keyof typeof ts.ModuleResolutionKind
						: ts.CompilerOptions[key] extends ts.NewLineKind
							? "CRLF" | "LF"
							: ts.CompilerOptions[key] extends ts.MapLike<string[]>
								? ts.MapLike<string[]>
								: ts.CompilerOptions[key] extends string[]
									? string[]
									: ts.CompilerOptions[key] extends string
										? ts.CompilerOptions[key]
										: ts.CompilerOptions[key] extends boolean
											? ts.CompilerOptions[key]
											: ts.CompilerOptions[key] extends number ? number : any
};

export function getScriptLevelNumber(level: any): ScriptTarget & number | undefined {
	if (Number.isNaN(Number(level)) && typeof level === "string") {
		const key = Object.keys(ScriptTarget)
			.filter(k => !["json", "latest"].includes(k.toLowerCase()))
			.find(t => t.toLowerCase() === level.toLowerCase());
		return key ? ScriptTarget[key] : undefined;
	}
	if (Number(level) in ScriptTarget && ScriptTarget.JSON !== Number(level)) {
		return Number(level);
	}
}

export function getScriptLevelString(level: any): rawScriptTarget | undefined {
	if (Number(level) in ScriptTarget) {
		const key = Object.keys(ScriptTarget)
			.filter(k => !["json", "latest"].includes(k.toLowerCase()))
			.find(t => ScriptTarget[t] === Number(level));
		return key as rawScriptTarget;
	}
}

export interface ICategorizedDiagnostics {
	errors: ReadonlyArray<ts.Diagnostic & { category: ts.DiagnosticCategory.Error }>;
	warnings: ReadonlyArray<ts.Diagnostic & { category: ts.DiagnosticCategory.Warning }>;
	messages: ReadonlyArray<ts.Diagnostic & { category: ts.DiagnosticCategory.Message }>;
	suggestions: ReadonlyArray<ts.Diagnostic & { category: ts.DiagnosticCategory.Suggestion }>;
}

export interface TSParsedConfig {
	errors: Array<ts.Diagnostic | ts.DiagnosticWithLocation> | ts.SortedReadonlyArray<ts.Diagnostic>;
	compilerOptions: ts.CompilerOptions;
	compileOnSave?: boolean;
	projectReferences?: ReadonlyArray<ts.ProjectReference>;
	raw?: rawCompilerOptions;
	typeAcquisition?: ts.TypeAcquisition;
	wildcardDirectories?: ts.MapLike<ts.WatchDirectoryFlags>;
}

export const IGNORED_DIAGNOSTICS = new Set([
	6059, // "'rootDir' is expected to contain all source files. -> FuseBox contains all source files"
	18002, // "The 'files' list in config file is empty. -> Again, FuseBox ..."
	18003, // "No inputs were found in config file. -> Again, FuseBox ..."
]);
export function makePathDoesNotExistDiagnostic(path: string): ts.Diagnostic {
	return {
		code: 5058, // Specified path does not exist
		category: ts.DiagnosticCategory.Error,
		messageText: `The specified path does not exist: '${path}'.`,
		file: undefined,
		length: undefined,
		start: undefined,
	};
}

export class TypescriptConfig {
	// the actual typescript config
	private config: TSParsedConfig;
	private customTsConfig: string | rawCompilerOptions[];
	private configFile: string;
	private formatDiagnosticsHost: ts.FormatDiagnosticsHost;

	constructor(public context: WorkFlowContext) {
		this.formatDiagnosticsHost = {
			getCanonicalFileName: file => file,
			getCurrentDirectory: () => context.homeDir,
			getNewLine: () => ts.sys.newLine,
		};
	}

	public getConfig() {
		this.read();
		return this.config;
	}

	public normalizeDiagnostics(diagnostics: ts.Diagnostic[]): ts.SortedReadonlyArray<ts.Diagnostic> {
		return ts.sortAndDeduplicateDiagnostics(diagnostics.filter(x => !IGNORED_DIAGNOSTICS.has(x.code)));
	}

	private findConfigFileBackwards(tsConfigFilePath: string): string {
		return findFileBackwards(tsConfigFilePath, this.context.appRoot);
	}

	private resolveBaseUrl(baseUrl?: string): string {
		return (
			baseUrl &&
			ensureAbsolutePath(
				ensureFuseBoxPath(
					baseUrl
						? path.normalize(baseUrl)
						: this.configFile
						? path.normalize(path.dirname(this.configFile))
						: this.context.homeDir,
				),
			)
		);
	}

	private normalizeTSPaths() {
		const options = this.config.compilerOptions;
		const globalPathsMatch: string[] = [];
		const normalizedPaths: ts.MapLike<string[]> = {};
		const log: string[] = [];
		const absHomeDir = ensureAbsolutePath(ensureFuseBoxPath(this.context.homeDir));

		if (typeof options.paths === "object" || options.paths == null) {
			if (!options.baseUrl.includes(absHomeDir)) {
				this.context.warning(
					`Automatic aliasing cannot be applied because the "baseUrl" path in your tsconfig file is outside of "homeDir"`,
				);
				return;
			}

			if (typeof options.paths === "object" && options.paths != null) {
				for (let key in options.paths) {
					const lookupArray = options.paths[key];
					const normalizedLookup = [];
					const logPath = [];

					if (/\*{2,}/g.test(key)) {
						this.context.warning(`Cannot resolve invalid TS path "${key}". A TS path can have at most one star`);
						break;
					}

					if (!Array.isArray(lookupArray)) {
						this.context.warning(
							`Cannot resolve invalid TS path "${key}". Expected an array of files or directory names but instead got "${lookupArray}"`,
						);
						break;
					}

					for (let i = 0; i < lookupArray.length; i++) {
						const lookupPath = String(lookupArray[i]).replace(/\\/g, "/");

						if (/\*{2,}/g.test(lookupPath)) {
							this.context.warning(
								`Cannot resolve invalid TS path "${key}". A lookup file/dir "${lookupPath}" can have at most one star`,
							);
							break;
						}

						normalizedLookup.push(lookupPath);
						logPath.push(`~/${lookupPath.replace("./", "")}`);
					}

					if (normalizedLookup.length) {
						log.push(`\t${key} => ${logPath.join(", ")}`);
						normalizedPaths[key] = normalizedLookup;
						globalPathsMatch.push(`(${tsKeyPath2RegExp(key).source})`);
					}
				}
			} else {
				options.paths = {};
			}

			fs.readdirSync(options.baseUrl).forEach(file => {
				// skip files that start with .
				if (file[0] === ".") {
					return;
				}

				const absPath = path.resolve(options.baseUrl, file);

				if (ts.sys.directoryExists(absPath)) {
					const dirKey = `${file}/*`;

					if (options.paths[dirKey]) return;

					const lookupDir = `./${file}/*`;

					options.paths[dirKey] = [lookupDir];
					globalPathsMatch.push(`(${tsKeyPath2RegExp(dirKey).source})`);
					log.push(`\t${dirKey} => ~/${file}/*`);

					return;
				}

				if (ts.sys.fileExists(absPath)) {
					const extension = path.extname(file);

					if (
						!extension ||
						(options.allowJs && (extension === ".js" || extension === ".jsx")) || // jsconfig file or explicit `allowJs`
						extension === ".ts" ||
						extension === ".tsx"
					) {
						let name = extension ? file.substr(0, file.length - extension.length) : file;

						if (options.paths[name]) return;

						log.push(`\t${name} => ~/${name}`);
						globalPathsMatch.push(`(${tsKeyPath2RegExp(name).source})`);
						options.paths[name] = [`./${name}`];
					}
				}
			});

			options.paths = normalizedPaths;

			if (globalPathsMatch.length) {
				this.context.log.echoInfo(`Applying automatic alias relative to baseUrl in tsconfig.json`);
				this.context.log.echoInfo(`\n${log.join("\n")}`);
				this.context.tsPathsRegExp = new RegExp(globalPathsMatch.join("|"));
				this.context.tsModuleResolutionCache = ts.createModuleResolutionCache(this.context.homeDir, f => f);
			}
		}
	}

	public readJsonConfigFile(): TSParsedConfig {
		const config: TSParsedConfig = { compilerOptions: {}, errors: [] };

		this.configFile =
			typeof this.customTsConfig === "string"
				? ensureUserPath(this.customTsConfig)
				: this.findConfigFileBackwards(path.join(this.context.homeDir, "tsconfig.json"));

		if (this.configFile) {
			if (!ts.sys.fileExists(this.configFile)) {
				config.errors = [makePathDoesNotExistDiagnostic(this.configFile)];
				return config;
			}
			const configFileRelPath = this.configFile.replace(this.context.appRoot, "");
			this.context.log.echoInfo(`Typescript config file:  ${configFileRelPath}`);

			// Note: if tsconfig file contains e.g: `extends: "othertsconfig.json"`
			// this is handled automatically by `readJsonConfigFile`
			const JSONSourceFile = ts.readJsonConfigFile(this.configFile, ts.sys.readFile);
			const parsedJSONFile = ts.parseConfigFileTextToJson(this.configFile, JSONSourceFile.getFullText());

			// Report syntax errors in tsconfig file
			// Parsed using TS' own JSON parser
			if (parsedJSONFile.error) {
				config.errors = [parsedJSONFile.error];
				return config;
			}

			// Report errors in tsconfig file (settings / options)
			// Parse the `JSONSourceFile` as TS config JSON file.
			// Better than `ts.convertCompilerOptionsFromJson`,
			// it can map diagnostics to line | column
			const parsedJSONConfigFile = ts.parseJsonSourceFileConfigFileContent(
				JSONSourceFile,
				ts.sys,
				path.dirname(this.configFile),
			);

			if (parsedJSONConfigFile.errors.length) {
				const errors = this.normalizeDiagnostics(parsedJSONConfigFile.errors);
				if (errors.length) {
					config.errors = errors;
					return config;
				}
			}

			Object.assign(config, {
				compilerOptions: parsedJSONConfigFile.options,
				compileOnSave: parsedJSONConfigFile.compileOnSave,
				projectReferences: parsedJSONConfigFile.projectReferences,
				raw: parsedJSONConfigFile.raw,
				typeAcquisition: parsedJSONConfigFile.typeAcquisition,
				wildcardDirectories: parsedJSONConfigFile.wildcardDirectories,
			});
		}

		if (Array.isArray(this.customTsConfig)) {
			const tsConfigOverrideCompilerOptions = {};
			this.customTsConfig.forEach(config => {
				if (typeof config === "object" && config !== null) {
					Object.assign(tsConfigOverrideCompilerOptions, config);
				} else {
					/** TODO! unknown type */
				}
			});

			const parsedVirtualJSONConfig = ts.convertCompilerOptionsFromJson(
				tsConfigOverrideCompilerOptions,
				this.context.cwd,
				"",
			);

			const virtualJSONSourceFile = ts.parseJsonText("[FuseBoxOptions.tsConfig]", JSON.stringify(this.customTsConfig));

			const errors = this.normalizeDiagnostics(parsedVirtualJSONConfig.errors);
			if (errors.length) {
				const flattenError = errors[0];
				flattenError.file = virtualJSONSourceFile;
				flattenError.start = 0;
				flattenError.length = virtualJSONSourceFile.getFullText().length;

				for (let i = 1; i < errors.length; i++) {
					const error = errors[i];
					flattenError.messageText += "\n" + this.formatDiagnostic(error, false);
				}

				config.errors = [flattenError];
				return config;
			}
		}

		config.compilerOptions.module = ts.ModuleKind.CommonJS;

		if (config.compilerOptions.baseUrl) {
			config.compilerOptions.baseUrl = this.resolveBaseUrl(config.compilerOptions.baseUrl);
		}

		if (!("target" in config.compilerOptions)) {
			config.compilerOptions.target = this.context.languageLevel;
		}

		if (
			config.compilerOptions.allowSyntheticDefaultImports !== undefined &&
			this.context.fuse &&
			this.context.fuse.producer
		) {
			this.context.fuse.producer.allowSyntheticDefaultImports = config.compilerOptions.allowSyntheticDefaultImports;
		}

		// if (config.compilerOptions.baseUrl === this.resolveBaseUrl(".")) {
		// 	this.baseURLAutomaticAlias = true;
		// }

		return config;
	}

	private defaultSetup() {
		const compilerOptions = (this.config.compilerOptions = this.config.compilerOptions || {});

		if (this.configFile && path.basename(this.configFile).startsWith("jsconfig.")) {
			compilerOptions.allowJs = true;
		}
		compilerOptions.sourceMap = this.context.useSourceMaps;
		compilerOptions.inlineSources = this.context.useSourceMaps;

		if (this.context.forcedLanguageLevel) {
			this.forceCompilerTarget(this.context.forcedLanguageLevel);
		}
	}

	public forceCompilerTarget(level: ScriptTarget) {
		this.context.log.echoInfo(`Typescript forced script target: ${getScriptLevelString(level)}`);
		const compilerOptions = (this.config.compilerOptions = this.config.compilerOptions || {});
		compilerOptions.target = level;
	}

	public setConfigFile(customTsConfig: string | rawCompilerOptions[]) {
		this.customTsConfig = customTsConfig;
	}

	private initializeConfig() {
		if (!this.configFile && this.context.ensureTsConfig === true) {
			Object.assign(this.config.compilerOptions, {
				jsx: ts.JsxEmit.React,
				baseUrl: this.resolveBaseUrl(this.context.homeDir),
				importHelpers: true,
				emitDecoratorMetadata: true,
				experimentalDecorators: true,
				moduleResolution: ts.ModuleResolutionKind.NodeJs,
			} as ts.CompilerOptions);
			// Raw compiler options
			const compilerOptions: rawCompilerOptions = Object.assign(
				{},
				this.config.compilerOptions as any,
				{
					target: getScriptLevelString(this.config.compilerOptions.target),
					baseUrl: ".",
					module: "CommonJS",
					jsx: "react",
					moduleResolution: "NodeJs",
				} as rawCompilerOptions,
			);
			const targetFile = path.join(this.context.homeDir, "tsconfig.json");
			this.context.log.echoInfo(`Generating recommended tsconfig.json:  ${targetFile}`);
			fs.writeFileSync(targetFile, JSON.stringify({ compilerOptions }, null, 2));
		}
	}

	private verifyTsLib() {
		if (this.context.ensureTsConfig === true && this.config.compilerOptions.importHelpers === true) {
			const tslibPath = path.join(Config.NODE_MODULES_DIR, "tslib");
			if (!fs.existsSync(tslibPath)) {
				this.context.log.echoWarning(
					`You have enabled importHelpers. Please install tslib - https://github.com/Microsoft/tslib`,
				);
			}
		}
	}

	public categorizeDiagnostics(
		diagnostics: ReadonlyArray<ts.Diagnostic> | Readonly<ts.Diagnostic>,
	): ICategorizedDiagnostics {
		const errors = [];
		const warnings = [];
		const messages = [];
		const suggestions = [];
		const diagnosticsArray = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
		const size = diagnosticsArray.length;
		for (let i = 0; i < size; i++) {
			const diagnostic: ts.Diagnostic = diagnosticsArray[i];
			switch (diagnostic.category) {
				case ts.DiagnosticCategory.Error: {
					errors.push(diagnostic);
					break;
				}
				case ts.DiagnosticCategory.Warning: {
					warnings.push(diagnostic);
					break;
				}
				case ts.DiagnosticCategory.Message: {
					messages.push(diagnostic);
					break;
				}
				// Commented for documentation. Technically we shouldn't get this.
				// Displaying fails with "Error: Debug Failure. Should never get an Info diagnostic on the command line."
				// TODO: If you find a known case where this could happen, open an issue
				// case ts.DiagnosticCategory.Suggestion: {
				// 	suggestions.push(diagnostic);
				//	break;
				// }
			}
		}
		return { errors, warnings, messages, suggestions };
	}

	public formatDiagnostic(diagnostic: ts.Diagnostic, separator: boolean = true): string {
		// TODO! make a custom formatter instead
		diagnostic.messageText = `${diagnostic.messageText}\n`;
		const formatted = ts
			.formatDiagnosticsWithColorAndContext([diagnostic], this.formatDiagnosticsHost)
			.replace(/error|warning|message/, match => match.toUpperCase())
			.replace(/ - /, "\n")
			.split("\n")
			.filter(m => String(m).trim().length)
			.map((line, i) => (i === 0 ? line : separator ? `  │ ${line}` : line))
			.join("\n");

		return formatted;
	}

	public logDiagnosticsByCategory(diagnostics: ReadonlyArray<ts.Diagnostic>, category: ts.DiagnosticCategory): void {
		if (diagnostics.length) {
			const size = diagnostics.length;
			for (let i = 0; i < size; i++) {
				const diagnosticMsg = this.formatDiagnostic(diagnostics[i]);
				switch (category) {
					case ts.DiagnosticCategory.Error: {
						this.context.log.echoRed(`  → ${diagnosticMsg}`);
						break;
					}
					case ts.DiagnosticCategory.Warning: {
						this.context.log.echoYellow(`  → ${diagnosticMsg}`);
						break;
					}
					case ts.DiagnosticCategory.Message: {
						this.context.log.echoBlue(`  → ${diagnosticMsg}`);
						break;
					}
				}
			}
		}
	}

	public logAllDiagnostics(diagnostics: ReadonlyArray<ts.Diagnostic>) {
		const categorizedDiagnostics = this.categorizeDiagnostics(diagnostics);
		this.logDiagnosticsByCategory(categorizedDiagnostics.messages, ts.DiagnosticCategory.Message);
		this.logDiagnosticsByCategory(categorizedDiagnostics.warnings, ts.DiagnosticCategory.Warning);
		this.throwOnDiagnosticErrors(categorizedDiagnostics.errors);
	}

	public throwOnDiagnosticErrors(diagnostics: ReadonlyArray<ts.Diagnostic>): never | void {
		if (diagnostics.length) {
			this.logDiagnosticsByCategory(diagnostics, ts.DiagnosticCategory.Error);

			let errorMessage = `  └─ Invalid 'compilerOptions'`;

			this.context.log.echoBoldRed(`${errorMessage}\n`);
			process.exit(1);
		}
	}

	public read() {
		const cacheKey =
			(typeof this.customTsConfig === "string" ? this.customTsConfig : this.context.homeDir) +
			this.context.target +
			this.context.languageLevel;

		if (CACHED[cacheKey]) {
			this.config = CACHED[cacheKey];
			return;
		}

		const config = this.readJsonConfigFile();

		if (config.errors.length) {
			this.logAllDiagnostics(config.errors);
			return process.exit(1);
		}

		this.config = config;
		this.defaultSetup();
		this.initializeConfig();
		this.verifyTsLib();

		if (this.config.compilerOptions.baseUrl) {
			this.normalizeTSPaths();
		}

		this.context.log.echoInfo(`Typescript script target: ${getScriptLevelString(config.compilerOptions.target)}`);
		CACHED[cacheKey] = this.config;
	}
}
