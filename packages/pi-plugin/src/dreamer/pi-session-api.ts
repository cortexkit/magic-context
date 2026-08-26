import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
	basename,
	dirname,
	extname,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Shared resolver for pi-coding-agent's session APIs, used by every Pi dreamer
 * provider that reads historical JSONL sessions (retrospective, refresh-primers).
 *
 * ONE resolver on purpose: the session-listing API drifted once already
 * (`SessionManager.listSessions` never existed publicly; listing is
 * `SessionManager.listAll`, and `loadEntriesFromFile` is not exported — entries
 * come from `readFileSync` + `parseSessionEntries`). When each provider carried
 * its own copy of this lookup, one copy got fixed and the other kept probing the
 * nonexistent API, so its feature silently degraded. Any future Pi API drift
 * should break exactly one resolver and one test.
 */
export interface PiSessionApi {
	listSessions: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile: (filePath: string) => unknown[] | Promise<unknown[]>;
}

const PI_CODING_AGENT_MODULE = "@earendil-works/pi-coding-agent";

// Script-like entries: explicit JS/TS extensions, or no extension at all
// (bin-style entry scripts such as an extensionless `dist/cli`). Anything
// with another extension (.json, .png, ...) is a CLI argument, not an entry.
const SCRIPT_ENTRY_PATTERN = /\.(mjs|cjs|mts|cts|js|ts|tsx|jsx)$/i;
const TS_ENTRY_PATTERN = /\.(mts|cts|ts|tsx)$/i;

function isScriptEntry(filePath: string): boolean {
	return SCRIPT_ENTRY_PATTERN.test(filePath) || extname(filePath) === "";
}

interface FoundPackage {
	dir: string;
	pkg: Record<string, unknown>;
}

function readManifest(pkgJsonPath: string): Record<string, unknown> | null {
	try {
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
		return pkg && typeof pkg === "object"
			? (pkg as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * In a `bun build --compile` binary the pi-coding-agent code is embedded in the
 * executable ($bunfs) and process.execPath IS that executable: there is no
 * on-disk package to walk to, and process.argv[1] is a user-controlled CLI
 * argument (e.g. `pi --print`), not an entry script. Detect this layout
 * explicitly so the walker falls through to the next loader instead of walking
 * up from an arbitrary user-supplied path.
 */
function isCompiledBunBinary(): boolean {
	if (!process.versions.bun) {
		return false;
	}
	const exe = basename(process.execPath).toLowerCase();
	return exe !== "bun" && exe !== "bun.exe";
}

/**
 * Determine the on-disk file the running Pi was started from, or null when
 * there is none. The Pi binary is spawned with `process.argv[1]` pointing at
 * the host `cli.js` (see subagent-runner resolvePiInvocation); when Pi is
 * launched through a bin shim, argv[1] is a SYMLINK to the real cli.js
 * (node/bun preserve the invocation path), so resolve the real path first.
 * Only script-like files are accepted: anything else (absent argv[1], a CLI
 * argument, a Jiti VIRTUAL module with no physical path) means there is no
 * usable entry and the caller falls back to process.execPath.
 */
function resolveRunningEntry(): string | null {
	const argv1 = process.argv[1];
	if (argv1 && existsSync(argv1) && statSync(argv1).isFile()) {
		const real = realpathSync(argv1);
		if (isScriptEntry(real)) {
			return real;
		}
	}
	return null;
}

/**
 * Walk up from `startDir` to the pi-coding-agent package root.
 *
 * Pi's `build:binary` copies Bun's metadata into `dist/package.json`, and that
 * manifest ALSO carries the pi-coding-agent name. Stopping there would resolve
 * an entry like `./dist/index.js` against `dist/`, producing
 * `dist/dist/index.js`. Mirror Pi's own `findNodePackageDir` (dist/config.js):
 * when a matching manifest sits in a `dist/` directory whose parent also owns
 * a matching manifest, the parent is the package root.
 */
function findPackageRoot(startDir: string): FoundPackage | null {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const pkg = readManifest(join(dir, "package.json"));
		if (pkg?.name === PI_CODING_AGENT_MODULE) {
			if (basename(dir) === "dist") {
				const parentDir = dirname(dir);
				const parentPkg = readManifest(join(parentDir, "package.json"));
				if (parentPkg?.name === PI_CODING_AGENT_MODULE) {
					return { dir: parentDir, pkg: parentPkg };
				}
			}
			return { dir, pkg };
		}
		dir = dirname(dir);
	}
	return null;
}

/**
 * Resolve a conditional/array exports target to a concrete path, mirroring
 * Node's condition resolution for ESM imports: "import" first, then "node",
 * then "default" ("types" is TypeScript-only and never a runtime target).
 * Arrays are fallback lists — the first resolvable entry wins. Shapes we
 * cannot interpret return undefined; the caller then falls through to
 * module/main and ultimately to the bare-import loader (the designed
 * safety valve).
 */
function resolveExportsTarget(target: unknown): string | undefined {
	if (typeof target === "string") {
		return target;
	}
	if (Array.isArray(target)) {
		for (const item of target) {
			const resolved = resolveExportsTarget(item);
			if (resolved !== undefined) {
				return resolved;
			}
		}
		return undefined;
	}
	if (target && typeof target === "object") {
		const conditions = target as Record<string, unknown>;
		for (const condition of ["import", "node", "default"]) {
			if (condition in conditions) {
				const resolved = resolveExportsTarget(conditions[condition]);
				if (resolved !== undefined) {
					return resolved;
				}
			}
		}
	}
	return undefined;
}

/**
 * Resolve the package's ESM entry from its manifest, mirroring Node's own
 * export-target validation: the target must be relative ("./"-prefixed)
 * and must stay inside the package root. The "./" requirement applies to
 * EVERY manually joined target, not just exports: module/main entries are
 * joined by hand here, so a non-prefixed "dist/index.js" must not skip the
 * relative-path requirement. We import the file directly, bypassing the
 * loader's built-in validation, so a broken or malicious manifest must not
 * be able to point us at an arbitrary path.
 */
function resolveManifestEntry(found: FoundPackage): string {
	const pkg = found.pkg as {
		exports?: { "."?: unknown };
		module?: unknown;
		main?: unknown;
	};
	const entryRel =
		resolveExportsTarget(pkg.exports?.["."]) ??
		(typeof pkg.module === "string" ? pkg.module : undefined) ??
		(typeof pkg.main === "string" ? pkg.main : undefined);
	if (!entryRel) {
		throw new Error(`No ESM entry found in ${found.dir}/package.json`);
	}
	if (!entryRel.startsWith("./")) {
		throw new Error(
			`Invalid entry "${entryRel}" in ${found.dir}/package.json: targets must start with "./"`,
		);
	}
	const root = resolve(found.dir);
	const resolved = resolve(root, entryRel);
	if (resolved !== root && !resolved.startsWith(root + sep)) {
		throw new Error(
			`Invalid entry "${entryRel}" in ${found.dir}/package.json: target escapes the package root`,
		);
	}
	return resolved;
}

/**
 * Map a build-output entry (dist/index.js) back to its source counterpart
 * (src/index.ts). Returns null when the entry does not follow the dist→src
 * layout.
 */
function toSourceEntry(entryPath: string, pkgDir: string): string | null {
	const rel = relative(pkgDir, entryPath);
	const srcRel = rel
		.replace(/^dist[/\\]/, "src/")
		.replace(/\.mjs$/, ".mts")
		.replace(/\.cjs$/, ".cts")
		.replace(/\.jsx$/, ".tsx")
		.replace(/\.js$/, ".ts");
	if (srcRel === rel) {
		return null;
	}
	return join(pkgDir, srcRel);
}

export interface ModuleLoader {
	name: string;
	load: () => Promise<unknown>;
}

export const defaultLoaders: ModuleLoader[] = [
	{
		// Resolve from the running Pi binary FIRST so the dreamer loads the SAME
		// pi-coding-agent version that owns the live session format. A stale or
		// mismatched copy in an extension tree (e.g. a host peer that was
		// auto-installed once and never updated) can drift from the live session
		// API and break retrospective / refresh-primers.
		name: "Resolve from running Pi binary entry",
		load: async () => {
			if (isCompiledBunBinary()) {
				throw new Error(
					"Running inside a compiled Bun binary: pi-coding-agent is embedded in the executable and argv[1] is a user CLI argument, so there is no on-disk package entry to resolve",
				);
			}
			// argv[1] may be absent, a non-script CLI argument, or a Jiti VIRTUAL
			// module with no on-disk path — in those cases fall back to the
			// interpreter binary (process.execPath) and walk from there.
			const entry = resolveRunningEntry() ?? process.execPath;
			if (!entry) {
				throw new Error(
					"Neither process.argv[1] nor process.execPath is available",
				);
			}
			// pi-coding-agent ships ESM-only exports (no "require" condition), so
			// createRequire(...).resolve("<pkg>") fails with
			// ERR_PACKAGE_PATH_NOT_EXPORTED. Walk up from the resolved entry to find
			// the package by name and import its ESM entry directly.
			const found = findPackageRoot(dirname(entry));
			if (!found) {
				// `entry` may be the execPath fallback (when argv[1] is a CLI arg,
				// a virtual module, or absent), so the message names the path
				// actually walked instead of interpolating `undefined`.
				throw new Error(
					`Could not locate ${PI_CODING_AGENT_MODULE} package.json from ${entry}`,
				);
			}
			const entryPath = resolveManifestEntry(found);
			// Source checkouts (tsx/jiti running src/cli.ts): the manifest entry
			// points at build output under dist/, which can be STALE relative to
			// the running sources. When the running entry is TypeScript, load the
			// matching source file; if none exists, refuse to silently select
			// stale build output and fall through to the next loader.
			if (TS_ENTRY_PATTERN.test(entry)) {
				const srcEntry = toSourceEntry(entryPath, found.dir);
				if (srcEntry && existsSync(srcEntry)) {
					return await import(pathToFileURL(srcEntry).href);
				}
				throw new Error(
					`Pi is running from TypeScript source (${entry}) but no source counterpart of ${entryPath} exists; refusing to load possibly stale build output`,
				);
			}
			return await import(pathToFileURL(entryPath).href);
		},
	},
	{
		name: "Bare import",
		load: async () => await import(/* @vite-ignore */ PI_CODING_AGENT_MODULE),
	},
];

let cachedModulePromise: Promise<unknown> | null = null;

export function clearCachedModule(): void {
	cachedModulePromise = null;
}

export async function resolvePiCodingAgentModule(
	loaders?: ModuleLoader[],
): Promise<unknown> {
	if (cachedModulePromise) {
		return cachedModulePromise;
	}

	const activeLoaders = loaders ?? defaultLoaders;
	const promise = (async () => {
		const errors: Error[] = [];
		for (const loader of activeLoaders) {
			try {
				return await loader.load();
			} catch (err: unknown) {
				errors.push(err as Error);
			}
		}
		throw new Error(
			`Failed to resolve ${PI_CODING_AGENT_MODULE} via all strategies:\n` +
				errors
					.map((e, i) => `  - ${activeLoaders[i].name}: ${e.message || e}`)
					.join("\n") +
				"\nLikely cause: symlinked or nonstandard install layout.",
		);
	})();

	cachedModulePromise = promise;
	promise.catch(() => {
		if (cachedModulePromise === promise) {
			cachedModulePromise = null;
		}
	});

	return promise;
}

export async function loadDefaultPiSessionApi(
	loaders?: ModuleLoader[],
): Promise<PiSessionApi> {
	const mod = (await resolvePiCodingAgentModule(loaders)) as {
		SessionManager?: {
			listAll?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
		};
		loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
		parseSessionEntries?: (content: string) => unknown[];
	};
	const listSessions = mod.SessionManager?.listAll;
	if (typeof listSessions !== "function") {
		throw new Error(
			"Pi session APIs unavailable: expected SessionManager.listAll on pi-coding-agent",
		);
	}
	// loadEntriesFromFile is NOT part of pi-coding-agent's public API — fall back
	// to readFileSync + parseSessionEntries (both exported).
	const loadEntriesFromFile: PiSessionApi["loadEntriesFromFile"] =
		mod.loadEntriesFromFile ??
		((filePath: string) => {
			const content = readFileSync(filePath, "utf8");
			return mod.parseSessionEntries?.(content) ?? [];
		});
	return {
		listSessions: listSessions.bind(mod.SessionManager),
		loadEntriesFromFile,
	};
}
