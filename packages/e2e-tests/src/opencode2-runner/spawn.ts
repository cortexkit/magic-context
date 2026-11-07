import { createE2ETempDir, cleanupE2ETempDir } from "../temp-dir";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { hostExtractCache } from '../host-extract-cache';
import { pinMockAgents } from "../mock-routing";
import { seedModelsCatalog } from "../models-catalog";
import { prepareContextDatabase } from "../prepare-context-db";
import { pinnedOpenCode2Version, resolveOpenCode2CLI, sharedOpenCode2Root } from "./cli-resolution";
import { isolateStoreDirectories } from "./store-directories";
import { assertWriteFenceUnchanged, snapshotWriteFence } from "./write-fence";
import { MockProvider, type MockResponse } from "../mock-provider/server";
import { OpenCode } from "@opencode/client";
import { setHarness } from "../../../plugin/src/shared/harness";
import { prepareSchemaGuard, requireSchemaGuard } from "./schema-guard";
import {
	awaitPluginActivation,
	type PluginActivationClient,
} from "./plugin-activation";

export const OPENCODE2_NO_BACKGROUND_SERVICE_FLAG: string = "--standalone";
export const ROOT_KEYS = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_RUNTIME_DIR",
	"CARGO_HOME",
	"RUSTUP_HOME",
] as const;
// The GA CLI is a devDependency of packages/plugin. Bun's isolated linker puts its
// bin under the package's own node_modules; the hoisted linker (the release e2e
// container installs with --linker=hoisted) puts it under the workspace root. Take
// whichever exists so the lane does not depend on the linker choice.
//
// Before node_modules, local runs prefer the shared per-version install created by
// scripts/ensure-shared-opencode2.ts (see cli-resolution.ts for why). It is used only
// when its manifest reports exactly the pinned version; CI never creates it, so CI
// and the Docker lane keep resolving from node_modules.
//
// MC_E2E_OPENCODE2_CLI points the lane at a different GA build than the pinned
// devDependency. Host-behavior findings are version-specific — a defect that the
// pinned build tolerates can be fatal two patch releases later — so the lane has to
// be runnable against an arbitrary installed binary without touching node_modules.
function resolveCLI(): string {
	let pinnedVersion: string | null = null;
	try {
		pinnedVersion = pinnedOpenCode2Version();
	} catch {
		// Without a readable exact pin there is no version to match a shared install
		// against, so resolution falls through to node_modules as it always did.
	}
	return resolveOpenCode2CLI({
		override: process.env.MC_E2E_OPENCODE2_CLI,
		pinnedVersion,
		sharedRoot: sharedOpenCode2Root(),
		nodeModulesCandidates: [
			resolve(import.meta.dir, "../../../plugin/node_modules/.bin/opencode2"),
			resolve(import.meta.dir, "../../../../node_modules/.bin/opencode2"),
		],
	});
}
export const CLI = resolveCLI();
export const PLUGIN = resolve(import.meta.dir, "../../../plugin");
const groups = new Set<number>();
function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}
process.prependOnceListener("exit", () => {
	for (const pid of groups) killGroup(pid);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.once(signal, () => {
		for (const pid of groups) killGroup(pid);
		process.exit(1);
	});
}
export interface OpenCode2Isolation {
	root: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** Original project directories from the store, retained to detect writes outside the test root after host shutdown. */
	referencedDirectories?: string[];
}

export function isolation(): OpenCode2Isolation {
	// The retrospective gate counts only the selected host's root sessions.
	// Match the OpenCode 2 host for in-process database probes, but do not select
	// a host when importing utilities that OpenCode 1 tests also use.
	setHarness("opencode2");
	const root = createE2ETempDir("mc-opencode2-");
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		OPENCODE_DB: "opencode2.db",
		TMPDIR: hostExtractCache(),
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
	};
	for (const key of ROOT_KEYS) {
		env[key] = join(root, key);
		mkdirSync(env[key]);
	}
	const cwd = join(root, "work");
	// Foundation's HTTP cache uses this home instead of HOME/XDG on macOS.
	env.CFFIXED_USER_HOME = env.HOME;
	mkdirSync(cwd);
	env.MAGIC_CONTEXT_STORAGE_DIR = join(env.XDG_DATA_HOME!, "cortexkit", "magic-context");
	// Magic Context writes its diagnostics to this file and never to the host's
	// stderr, so a test that checks a diagnostic reads it here (see readPluginLog).
	env.MAGIC_CONTEXT_LOG_PATH = join(root, "magic-context.log");
	return { root, env, cwd };
}

/** The Magic Context log of a host spawned with this isolation, or "" before the first flush. */
export function readPluginLog(env: NodeJS.ProcessEnv): string {
	const path = env.MAGIC_CONTEXT_LOG_PATH;
	return path && existsSync(path) ? readFileSync(path, "utf8") : "";
}

/**
 * Wait for a line to reach the Magic Context log. The plugin buffers log
 * writes for up to half a second, so a line logged during the turn a test just
 * awaited may not be on disk yet.
 */
export async function waitForPluginLog(
	env: NodeJS.ProcessEnv,
	text: string,
	timeoutMs = 5_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const content = readPluginLog(env);
		if (content.includes(text) || Date.now() >= deadline) return content;
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
}
export function assertIsolation(root: string, env: NodeJS.ProcessEnv): void {
	if (!OPENCODE2_NO_BACKGROUND_SERVICE_FLAG.trim())
		throw new Error(
			"Missing OPENCODE2_NO_BACKGROUND_SERVICE_FLAG literal; refusing v2 boot",
		);
	if (env.OPENCODE_DB !== "opencode2.db")
		throw new Error("OPENCODE_DB must be opencode2.db before boot");
	// Private roots isolate host state, cache, runtime files, and native toolchain state.
	// GA CLI 2.0.5 also honours OPENCODE_DB as observed by the placement probe.
	const base = realpathSync(root);
	for (const key of ROOT_KEYS) {
		const value = env[key];
		if (!value)
			throw new Error(`${key} must point at a throwaway directory before boot`);
		const suffix = relative(base, realpathSync(value));
		if (!suffix || suffix.startsWith("..") || resolve(value) === homedir())
			throw new Error(`${key} is not a throwaway directory before boot`);
	}
	if (!env.MAGIC_CONTEXT_STORAGE_DIR || relative(base, resolve(env.MAGIC_CONTEXT_STORAGE_DIR)).startsWith(".."))
		throw new Error("MAGIC_CONTEXT_STORAGE_DIR must be under the throwaway root");
	if (env.OPENCODE_DISABLE_DEFAULT_PLUGINS !== "true")
		throw new Error("Default plugins must be disabled");
}
const sha = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
export function snapshotFile(path: string) {
	if (!existsSync(path)) return null;
	const stat = statSync(path);
	const fd = openSync(path, "r");
	const edge = (position: number) => {
		const buffer = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
		const count = readSync(fd, buffer, 0, buffer.length, position);
		if (count !== buffer.length)
			throw new Error(`Short live-store snapshot read: ${path}`);
		return sha(buffer);
	};
	try {
		return {
			size: stat.size,
			mtime: stat.mtimeMs,
			first: edge(0),
			last: edge(Math.max(0, stat.size - 1024 * 1024)),
		};
	} finally {
		closeSync(fd);
	}
}
export function snapshotLive(home = homedir()) {
	const root = join(home, ".local/share/opencode");
	const log = join(root, "log");
	return {
		db: snapshotFile(join(root, "opencode.db")),
		logs: existsSync(log)
			? readdirSync(log)
					.sort()
					.map((name) => ({ name, ...snapshotFile(join(log, name)) }))
			: null,
	};
}
export function assertLiveUnchanged(
	before: ReturnType<typeof snapshotLive>,
	home = homedir(),
): void {
	if (JSON.stringify(before) !== JSON.stringify(snapshotLive(home)))
		throw new Error("Operator live store/log changed during v2 boot");
}
export function handoff(
	stdout: string,
): { url: string; password: string } | undefined {
	const match = stdout.match(
		/server listening on (https?:\/\/\S+)[\s\S]*?server password (\S+)/,
	);
	return match ? { url: match[1]!, password: match[2]! } : undefined;
}

/** Path the OpenCode client resolves the local service from; only `serve --service` writes it. */
export function serviceRegistrationPath(env: NodeJS.ProcessEnv): string {
	return join(env.XDG_STATE_HOME!, "opencode", "service.json");
}

/**
 * A service-mode host keeps its password out of stdout and puts it in the registration file
 * instead, so that file is where the handoff comes from.
 */
export function serviceHandoff(
	env: NodeJS.ProcessEnv,
): { url: string; password: string } | undefined {
	const path = serviceRegistrationPath(env);
	if (!existsSync(path)) return undefined;
	try {
		const info = JSON.parse(readFileSync(path, "utf8")) as {
			url?: string;
			password?: string;
		};
		return info.url && info.password
			? { url: info.url, password: info.password }
			: undefined;
	} catch {
		return undefined;
	}
}

/** OpenCode 2.0.5 removed awaitActivation; inventory is authoritative and plugin.updated invalidates it. */
export async function waitForPluginActive(
	client: PluginActivationClient,
	directory: string,
	pluginID = "opencode-magic-context",
	timeoutMs = 60_000,
): Promise<void> {
	await awaitPluginActivation(client, directory, pluginID, timeoutMs);
    await requireSchemaGuard(client, directory);
}

export interface OpenCode2Handoff {
    url: string;
    password: string;
    root: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    pid?: number;
    mock: MockProvider;
    stderr(): string;
    stop(): Promise<void>;
}

export interface OpenCode2SpawnOptions {
    thinkingScope?: (body: Record<string, unknown>) => string | undefined;
    prefixBinding?: boolean;
    /** Observe transport startup while plugins are still loading. This is not
     * fixture readiness: spawn still requires the schema guard before returning.
     */
    onHandoff?(host: OpenCode2Handoff): void;
    /** Explicit host binary for a same-store upgrade scenario. */
    cli?: string;
    /** Built plugin snapshot used before a same-store upgrade. */
    magicContextPlugin?: string;
	probePlugin?: string;
	/** Absolute path to a plugin loaded before Magic Context, so its session hooks
	 * shape the draft Magic Context receives, the way another user plugin listed
	 * ahead of it would. */
	prePlugin?: string;
	providerID?: string;
	probeStandalone?: boolean;
	defaultModelID?: string;
    visionModel?: boolean;
	additionalModelIDs?: string[];
	mockResponse?: MockResponse;
	extraConfig?: Record<string, unknown>;
	magicContextConfig?: Record<string, unknown>;
	includeMagicContext?: boolean;
	modelContextLimit?: number;
	modelOutputLimit?: number;
	/**
	 * Register a second mock model and pin the historian to it, so a scenario can
	 * keep a small window on the session model while the historian gets a window
	 * large enough to hold its prompt, as it does for real users. Its output limit
	 * follows `modelOutputLimit`. Default: the historian uses the session model.
	 */
	historianModel?: { id: string; contextLimit: number };
	/**
	 * A second provider on the mock, pinned as the historian's model while the session
	 * keeps `providerID`. `package` selects its wire format.
	 */
	historianProvider?: { providerID: string; modelID: string; package: string };
	/** models.dev catalogue copied into the throwaway host cache before boot. */
	modelsCatalog?: string;
	compactionAuto?: boolean;
	existingIsolation?: OpenCode2Isolation;
	existingMock?: { mock: MockProvider; baseURL: string };
	/**
	 * Boot the way a user's TUI boots its host: `serve --service`, which registers the endpoint in
	 * the client's discovery file. Only this mode writes that file.
	 */
	serviceMode?: boolean;
	/**
	 * False leaves the isolated context.db exactly as the test seeded it, for a
	 * scenario that needs the host itself to meet an older schema.
	 */
	prepareContextDatabase?: boolean;
}

/** Event-driven, bounded startup; no readiness polling. CLI contract: AFT playbook:54-64. */
export async function spawnOpencode2(options: OpenCode2SpawnOptions = {}) {
	setHarness("opencode2");
	const providerID = options.providerID ?? "openai";
	const fixture = options.existingIsolation ?? isolation();
	fixture.env.MAGIC_CONTEXT_LOG_SYNC = "1";
	try {
		assertIsolation(fixture.root, fixture.env);
		const references = isolateStoreDirectories(fixture.root, join(fixture.env.XDG_DATA_HOME!, "opencode", fixture.env.OPENCODE_DB!), join(fixture.env.MAGIC_CONTEXT_STORAGE_DIR ?? join(fixture.env.XDG_DATA_HOME!, "cortexkit", "magic-context"), "context.db"));
		fixture.referencedDirectories = [...new Set([...(fixture.referencedDirectories ?? []), ...references])];
		const fence = snapshotWriteFence(fixture.referencedDirectories);
		// Do not open the operator's live database, even for a read-only snapshot.
		// Check the host's writable descriptors and protected directory metadata instead.
		if (options.prepareContextDatabase !== false)
			prepareContextDatabase(fixture.env.XDG_DATA_HOME!);
		if (
			options.includeMagicContext !== false &&
			!existsSync(join(PLUGIN, "dist/v2/server.js"))
		) {
			throw new Error("Build the plugin before booting v2");
		}
		const mock = options.existingMock?.mock ?? new MockProvider();
		const provider = options.existingMock ?? await mock.start({ thinkingScope: options.thinkingScope, prefixBinding: options.prefixBinding });
		// 2.0.5 title generation hits the mock on session.create, before tests
		// install matchers, and uses a host title model rather than mock-model.
	    if (!options.existingMock) {
	        mock.setDefault({
	            text: "fixture reply",
	            usage: { input_tokens: 100, output_tokens: 10 },
	        });
	        if (options.mockResponse) mock.setDefault(options.mockResponse);
	    }
		const schemaTrace = join(fixture.root, "llm-schema-guard.jsonl");
		fixture.env.MC_E2E_SCHEMA_TRACE_PATH = schemaTrace;
        const schemaGuard = await prepareSchemaGuard(options.cli ?? CLI, fixture.root, fixture.env);
		const defaultModelID = options.defaultModelID ?? "mock-model";
		const modelIDs = new Set([
			defaultModelID,
			...(options.additionalModelIDs ?? []),
			...(options.historianModel ? [options.historianModel.id] : []),
			// A historian on the session's own provider is one more model on that provider.
			...(options.historianProvider?.providerID === providerID
				? [options.historianProvider.modelID]
				: []),
		]);
		writeFileSync(
			join(fixture.cwd, "opencode.json"),
			JSON.stringify({
				...options.extraConfig,
				plugins: [
					...(options.prePlugin ? [options.prePlugin] : []),
					...(options.includeMagicContext === false ? [] : [options.magicContextPlugin ?? PLUGIN]),
					...(options.probePlugin ? [options.probePlugin] : []),
					schemaGuard,
				],
				model: `${providerID}/${defaultModelID}`,
				compaction: { auto: options.compactionAuto ?? true, buffer: 1024, keep: { tokens: 1024 } },
				providers: {
					[providerID]: {
						settings: { baseURL: provider.baseURL, apiKey: "mock-key" },
						models: Object.fromEntries(
							[...modelIDs].map((id) => [
								id,
								{
									name: id,
	                                ...(options.visionModel ? { modalities: { input: ["text", "image"], output: ["text"] } } : {}),
									limit: {
										// 2.0.5 required() is unchanged, but 16k minus a 32k output
										// makes the first-request ceiling negative. Ordinary turns
										// stay large; fold scenarios pass 16k/1024 explicitly.
										context:
											id === options.historianModel?.id
												? options.historianModel.contextLimit
												: (options.modelContextLimit ?? 200_000),
										output: options.modelOutputLimit ?? 32768,
									},
								},
							]),
						),
					},
					...(options.historianProvider && options.historianProvider.providerID !== providerID
						? {
								[options.historianProvider.providerID]: {
									package: options.historianProvider.package,
									settings: { baseURL: provider.baseURL, apiKey: "mock-key" },
									models: {
										[options.historianProvider.modelID]: {
											name: options.historianProvider.modelID,
											limit: {
												context: options.modelContextLimit ?? 200_000,
												output: options.modelOutputLimit ?? 32768,
											},
										},
									},
								},
							}
						: {}),
				},
			}),
		);
		if (options.magicContextConfig !== undefined) {
			const configDir = join(fixture.env.XDG_CONFIG_HOME!, "cortexkit");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "magic-context.jsonc"),
				JSON.stringify(
					{
						auto_update: false,
						execute_threshold_percentage: 40,
						history_budget_percentage: 0.15,
						embedding: { provider: "off" },
						...pinMockAgents(
							options.magicContextConfig,
							`${providerID}/${defaultModelID}`,
							// Both OpenCode host generations use the `agents.*.opencode` config block.
							"opencode",
							options.historianProvider
								? {
										historian: `${options.historianProvider.providerID}/${options.historianProvider.modelID}`,
									}
								: options.historianModel
									? { historian: `${providerID}/${options.historianModel.id}` }
									: {},
						),
					},
					null,
					2,
				),
			);
		}
		if (options.modelsCatalog) {
			seedModelsCatalog(fixture.env.XDG_CACHE_HOME!, options.modelsCatalog);
			fixture.env.OPENCODE_DISABLE_MODELS_FETCH = "1";
		}
		// serve owns its server directly; --standalone is a TUI/run flag, not a serve option.
		const child = spawn(
			options.cli ?? CLI,
			[
				"serve",
				"--hostname",
				"127.0.0.1",
				"--port",
				"0",
				...(options.probeStandalone
					? [OPENCODE2_NO_BACKGROUND_SERVICE_FLAG]
					: []),
				...(options.serviceMode ? ["--service"] : []),
				"--print-logs",
			],
			{
				cwd: fixture.cwd,
				env: fixture.env,
				detached: true,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		if (child.pid) groups.add(child.pid);
		let stdout = "";
		let stderr = "";
		const exited = new Promise<void>((resolveExit) =>
			child.once("close", () => resolveExit()),
		);
		let hostStopped = false;
		const stopHost = async () => {
			if (hostStopped) return;
			hostStopped = true;
			let safetyError: unknown;
			try {
				if (child.pid && child.exitCode === null && child.signalCode === null)
					inspectOpenFiles(child.pid, fixture.root, fixture.env);
			} catch (error) {
				safetyError = error;
			}
			if (child.pid) killGroup(child.pid);
			await exited;
			if (child.pid) groups.delete(child.pid);
			assertWriteFenceUnchanged(fence);
			if (safetyError) throw safetyError;
			if (existsSync(schemaTrace)) {
				const failures = readFileSync(schemaTrace, "utf8").split("\n").filter((line) => line.startsWith("FAIL "));
				if (failures.length) throw new Error(`OC2 LLM schema guard rejected returned drafts:\n${failures.join("\n")}`);
			}
		};
		const stop = async () => {
			try {
				await stopHost();
			} finally {
				try { await mock.stop(); } finally {
	            if (!options.existingIsolation) cleanupE2ETempDir(fixture.root);
	        }
			}
		};
		try {
			const ready = await new Promise<{ url: string; password: string }>(
				(resolveReady, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`v2 handoff timed out\n${stdout}\n${stderr}`)),
						30000,
					);
					let poll: ReturnType<typeof setInterval> | undefined;
					const finish = (error?: Error) => {
						clearTimeout(timer);
						if (poll) clearInterval(poll);
						if (error) reject(error);
					};
					if (options.serviceMode) {
						poll = setInterval(() => {
							const value = serviceHandoff(fixture.env);
							if (!value) return;
							finish();
							resolveReady(value);
						}, 25);
					}
					child.stdout.on("data", (chunk) => {
						stdout += chunk.toString();
						if (options.serviceMode) return;
						const value = handoff(stdout);
						if (value) {
							finish();
							resolveReady(value);
						}
					});
					child.stderr.on("data", (chunk) => {
						stderr += chunk.toString();
					});
					child.once("error", (error) => finish(error));
					child.once("close", (code) =>
						finish(new Error(`v2 exited ${code}\n${stdout}\n${stderr}`)),
					);
				},
			);
			if (child.pid) inspectOpenFiles(child.pid, fixture.root, fixture.env);
            options.onHandoff?.({ ...ready, ...fixture, pid: child.pid, mock, stderr: () => stderr, stop });
            const readinessClient = OpenCode.make({
                baseUrl: ready.url,
                headers: { authorization: `Basic ${btoa(`opencode:${ready.password}`)}` },
            });
            await requireSchemaGuard(readinessClient, fixture.cwd);
			return {
				...ready,
				...fixture,
				pid: child.pid,
				mock,
				mockBaseURL: provider.baseURL,
				stopHost,
				stop,
				stdout: () => stdout,
				stderr: () => stderr,
				pluginLog: () => readPluginLog(fixture.env),
			};
		} catch (error) {
			await stop();
			throw error;
		}
	} catch (error) {
		if (!options.existingIsolation) cleanupE2ETempDir(fixture.root);
		throw error;
	}
}

export function assertOpenPaths(
	paths: string[],
	root: string,
	allowed: string[] = [],
	writable: string[] = [],
): void {
	const under = (path: string, base: string) =>
		path === base || path.startsWith(`${base}/`);
	const home = homedir();
	// Opt-in only after lsof identifies Foundation's per-user HTTP cache on
	// macOS. Exempt this exact SQLite file and its handles, never a directory,
	// an application store, or a similarly named database elsewhere.
	const httpCacheDb = process.env.MC_E2E_FOUNDATION_HTTP_CACHE_DB;
	const verifiedHttpCacheDb = process.platform === "darwin" && httpCacheDb &&
		(/^\/private\/var\/folders\/[^/]+\/[^/]+\/C\/opencode\/Cache\.db$/.test(httpCacheDb) ||
			/^\/Users\/[^/]+\/Library\/Caches\/opencode\/Cache\.db$/.test(httpCacheDb))
		? httpCacheDb : undefined;
	const isHttpCacheHandle = (path: string) => verifiedHttpCacheDb !== undefined &&
		(path === verifiedHttpCacheDb || path === `${verifiedHttpCacheDb}-wal` || path === `${verifiedHttpCacheDb}-shm`);
	const protectedRoots = [
		join(home, ".local/share/opencode"),
		join(home, ".local/share/cortexkit/magic-context"),
		join(home, ".config/opencode"),
		join(home, ".config/cortexkit"),
		join(home, ".local/state/opencode"),
	];
	for (const path of paths) {
		if (!path.startsWith("/")) continue; // lsof socket/pipe labels are not filesystem paths.
		if (protectedRoots.some((base) => under(path, base)) ||
			(/\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path) && !under(path, root) && !isHttpCacheHandle(path)) ||
			// Config and state live under the home XDG roots; a source file that merely sits
			// in a directory named `config` (the plugin's own src/config/index.ts, which the
			// TUI loads) is not operator configuration.
			((under(path, join(home, ".config")) ||
				under(path, join(home, ".local/state"))) &&
				!under(path, root)))
			throw new Error(`v2 process holds a forbidden open path: ${path}`);
	}
	for (const path of writable) {
		if (!path.startsWith("/")) continue;
		if (![root, ...allowed].some((base) => under(path, base)) && !isHttpCacheHandle(path))
			throw new Error(`v2 process holds a forbidden writable path: ${path}`);
	}
}

/** Retry only lsof's transient partial-inventory status, without treating it as success. */
export function resampleTransientInventory<T extends { status: number | null }>(sample: () => T): T {
    let result = sample();
    for (let retry = 0; result.status === 1 && retry < 2; retry++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        result = sample();
    }
    return result;
}

/** Sample the whole child process group, not an unrelated operator process's writes. */
export function inspectOpenFiles(
	pid: number,
	root: string,
	env: NodeJS.ProcessEnv,
): string[] {
	const sample = () => {
		const ps = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
		if (ps.status !== 0) throw new Error("Cannot inspect v2 process group");
		const pids = ps.stdout.trim().split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter(([, group]) => Number(group) === pid).map(([id]) => id);
		if (!pids.length) throw new Error("v2 process group disappeared before fd inspection");
		return spawnSync("lsof", ["-p", pids.join(","), "-Fin"], { encoding: "utf8" });
	};
	// A short-lived group member can exit between ps and lsof. Resample the whole
	// live group, but still require a successful inventory and the database inode.
	const result = resampleTransientInventory(sample);
	if (result.status !== 0)
		throw new Error(`Cannot inspect v2 open files: ${result.stderr}`);
	let fd = "";
	const paths: string[] = [];
	const writable: string[] = [];
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("f")) fd = line.slice(1);
		if (!line.startsWith("n")) continue;
		const path = line.slice(1);
		paths.push(path);
		// lsof's fd suffix is r, w or u (read/write). Program text, cwd,
		// shared libraries and TUI source files are read-only inputs, not leaks.
		if (/[0-9]+[wu]$/.test(fd)) writable.push(path);
	}
	// Mapped libraries and terminal-interface source files are read-only inputs.
	// Check database/config paths even when their descriptors are read-only.
	assertOpenPaths(paths, root, [], writable);
	const db = join(env.XDG_DATA_HOME!, "opencode", env.OPENCODE_DB!);
	const expected = statSync(db);
	let inode: number | undefined;
	const placements = result.stdout.split("\n").some((line) => {
		if (line.startsWith("i")) inode = Number(line.slice(1));
		return line === `n${db}` && inode === expected.ino;
	});
	if (!placements)
		throw new Error(
			"v2 child did not open its throwaway XDG_DATA_HOME database",
		);
	return paths;
}
