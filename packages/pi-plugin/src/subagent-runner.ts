import * as childProcess from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	resolve as resolvePath,
	sep,
} from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
	createDreamTokenBudget,
	TOKEN_BUDGET_FINALIZE_MESSAGE,
	TOKEN_BUDGET_TOOL_REFUSAL,
} from "@magic-context/core/features/magic-context/dreamer/token-budget";
import { probeChildSpawnFence } from "@magic-context/core/features/magic-context/schema-fence-probe";
import { openDatabase } from "@magic-context/core/features/magic-context/storage";
import type { SubagentKind } from "@magic-context/core/features/magic-context/storage-subagent-invocations";
import { recordChildInvocation } from "@magic-context/core/features/magic-context/subagent-token-capture";
import {
	ompModelRefToCanonical,
	piModelRefToCanonical,
	resolveModelRefForOmp,
	resolveModelRefForPi,
} from "@magic-context/core/shared/harness-provider-map";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { ResolvedModelEntry } from "@magic-context/core/shared/model-resolution";
import { piHarnessKindFromExecutable } from "@magic-context/core/shared/pi-executable";
import {
	formatRunTokenLog,
	runTokenLog,
} from "@magic-context/core/shared/run-token-log";
import type {
	CompletedSubagentToolCall,
	SubagentProgressEvent,
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";
import { summarizeChildStderr } from "@magic-context/core/shared/summarize-child-stderr";
import { type PiHarnessKind, resolvePiHarnessKind } from "./pi-harness-kind";
import { SubagentTelemetry, subagentStepCap } from "./subagent-telemetry";

const PI_CODING_AGENT_MODULE = "@earendil-works/pi-coding-agent";
const PI_CODING_AGENT_PACKAGE_NAMES = new Set([
	PI_CODING_AGENT_MODULE,
	"@oh-my-pi/pi-coding-agent",
]);
const BUN_VIRTUAL_SCRIPT_PREFIX = "/$bunfs/root/";
const WINDOWS_PI_EXTENSIONS = [".EXE", ".COM", ".CMD", ".BAT", ".PS1"];

interface PiResolutionFs {
	existsSync: (path: string) => boolean;
	statSync: (path: string) => { isFile: () => boolean };
	realpathSync: (path: string) => string;
	readFileSync: (path: string, encoding: "utf8") => string;
}

const DEFAULT_PI_RESOLUTION_FS: PiResolutionFs = {
	existsSync,
	statSync,
	realpathSync,
	readFileSync,
};

interface FoundPiPackage {
	dir: string;
	manifest: Record<string, unknown>;
}

interface PiCliResolution {
	cliPath: string | null;
	targetHarness: PiHarnessKind | null;
	checkedPaths: string[];
}

/** How to spawn a Pi child: the binary plus any fixed leading args. Always
 *  spawned without a shell (see {@link resolvePiInvocation}). */
interface PiInvocation {
	command: string;
	prefixArgs: string[];
	/** The resolved CLI package or executable that will parse prefixArgs and argv. */
	targetHarness: PiHarnessKind;
	/** Present only after the resolver fell through to a PATH-based invocation. */
	fallbackDiagnostic?: string;
}

interface ResolvePiInvocationOptions {
	execPath?: string;
	argv1?: string;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	fs?: Partial<PiResolutionFs>;
	/** Override used by tests to control package.json resolution from the running entry's Node module paths. */
	resolvePackageJson?: (from: string | undefined) => string | null;
}

function packageHarnessKind(packageName: unknown): PiHarnessKind | undefined {
	if (packageName === "@oh-my-pi/pi-coding-agent") return "omp";
	return typeof packageName === "string" &&
		PI_CODING_AGENT_PACKAGE_NAMES.has(packageName)
		? "pi"
		: undefined;
}

function readPiManifest(
	packageJsonPath: string,
	fs: PiResolutionFs,
): Record<string, unknown> | null {
	try {
		const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		return manifest && typeof manifest === "object"
			? (manifest as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Find the containing Pi package for a running entry. The dist/package.json
 * copied by Pi's binary build has the same name as the package root, so retain
 * the parent-root correction instead of resolving `dist/dist/...`.
 */
function findPiPackageRoot(
	startDir: string,
	fs: PiResolutionFs,
): FoundPiPackage | null {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const manifest = readPiManifest(join(dir, "package.json"), fs);
		if (
			manifest?.name &&
			typeof manifest.name === "string" &&
			PI_CODING_AGENT_PACKAGE_NAMES.has(manifest.name)
		) {
			if (basename(dir) === "dist") {
				const parentDir = dirname(dir);
				const parentManifest = readPiManifest(
					join(parentDir, "package.json"),
					fs,
				);
				if (
					typeof parentManifest?.name === "string" &&
					parentManifest.name === manifest.name
				) {
					return { dir: parentDir, manifest: parentManifest };
				}
			}
			return { dir, manifest };
		}
		dir = dirname(dir);
	}
	return null;
}

function pathIsInside(root: string, candidate: string): boolean {
	return candidate !== root && candidate.startsWith(`${root}${sep}`);
}

/**
 * Resolve the package's declared CLI bin rather than assuming a dist layout.
 * Pi declares `bin.pi`; OMP declares `bin.omp` (same package family —
 * `@oh-my-pi/pi-coding-agent` is in the allowlist above but ships no `pi` bin).
 * Keep the containment guard: a package manifest may select only a
 * file below its own root, including after symlinks are canonicalized.
 */
function resolvePiBin(
	found: FoundPiPackage,
	fs: PiResolutionFs,
	checkedPaths: string[],
): string | null {
	const bin = found.manifest.bin;
	const binKeys = ["pi", "omp"];
	let binEntry: string | undefined;
	for (const key of binKeys) {
		if (typeof bin === "string" && key === "pi") {
			binEntry = bin;
			break;
		}
		if (
			bin &&
			typeof bin === "object" &&
			typeof (bin as Record<string, unknown>)[key] === "string"
		) {
			binEntry = (bin as Record<string, string>)[key];
			break;
		}
	}
	if (!binEntry) return null;

	const packageRoot = resolvePath(found.dir);
	const candidate = resolvePath(packageRoot, binEntry);
	checkedPaths.push(candidate);
	if (isAbsolute(binEntry) || !pathIsInside(packageRoot, candidate)) {
		return null;
	}
	try {
		if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
			return null;
		}
		const realRoot = fs.realpathSync(packageRoot);
		const realCandidate = fs.realpathSync(candidate);
		return pathIsInside(realRoot, realCandidate) ? realCandidate : null;
	} catch {
		return null;
	}
}

function resolvePiCliFromPackageJson(
	packageJsonPath: string,
	fs: PiResolutionFs,
	checkedPaths: string[],
): PiCliResolution {
	checkedPaths.push(packageJsonPath);
	const manifest = readPiManifest(packageJsonPath, fs);
	const targetHarness = packageHarnessKind(manifest?.name);
	if (!manifest || targetHarness === undefined) {
		return { cliPath: null, targetHarness: null, checkedPaths };
	}
	return {
		cliPath: resolvePiBin(
			{ dir: dirname(packageJsonPath), manifest },
			fs,
			checkedPaths,
		),
		targetHarness,
		checkedPaths,
	};
}

/**
 * Positively identify a running Pi entry by its containing package manifest.
 * This recognizes dist/cli.js, dist/bundle/cli.js, and bin-shim symlinks without
 * encoding any of those layouts in the predicate.
 */
function resolvePiCliFromRunningEntry(
	entry: string | undefined,
	fs: PiResolutionFs,
): PiCliResolution {
	const checkedPaths = [entry ?? "process.argv[1] (missing)"];
	if (!entry || entry.startsWith(BUN_VIRTUAL_SCRIPT_PREFIX)) {
		return { cliPath: null, targetHarness: null, checkedPaths };
	}
	try {
		if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
			return { cliPath: null, targetHarness: null, checkedPaths };
		}
		const realEntry = fs.realpathSync(entry);
		if (realEntry !== entry) checkedPaths.push(realEntry);
		const found = findPiPackageRoot(dirname(realEntry), fs);
		if (!found) return { cliPath: null, targetHarness: null, checkedPaths };
		return {
			cliPath: resolvePiBin(found, fs, checkedPaths),
			targetHarness: packageHarnessKind(found.manifest.name) ?? null,
			checkedPaths,
		};
	} catch {
		return { cliPath: null, targetHarness: null, checkedPaths };
	}
}

function defaultResolvePiPackageJson(from: string | undefined): string | null {
	const requesters = [from, import.meta.url];
	for (const requester of requesters) {
		try {
			const require_ = requester
				? createRequire(
						requester.startsWith("file:") ? requester : resolvePath(requester),
					)
				: createRequire(import.meta.url);
			return require_.resolve(`${PI_CODING_AGENT_MODULE}/package.json`);
		} catch {
			// If the package is absent from the running entry's module paths, try this plugin's module paths.
		}
	}
	return null;
}

function resolveBundledPiCli(
	from: string | undefined,
	fs: PiResolutionFs,
	resolvePackageJson: (from: string | undefined) => string | null,
	checkedPaths: string[],
): PiCliResolution {
	const packageJsonPath = resolvePackageJson(from);
	if (!packageJsonPath) {
		checkedPaths.push(
			`${PI_CODING_AGENT_MODULE}/package.json (unresolvable from running module paths)`,
		);
		return { cliPath: null, targetHarness: null, checkedPaths };
	}
	return resolvePiCliFromPackageJson(packageJsonPath, fs, checkedPaths);
}

interface WindowsPiCommandResolution {
	path: string | null;
	extension: string | null;
	checkedPaths: string[];
}

/**
 * Resolve a Windows command without `shell: true`. PATHEXT is respected first,
 * then the Pi shims npm commonly writes are appended so a PowerShell-only Pi
 * install remains discoverable even when PATHEXT omits .PS1.
 */
function resolveWindowsPiCommand(
	env: NodeJS.ProcessEnv,
	fs: PiResolutionFs,
): WindowsPiCommandResolution {
	const pathValue = env.PATH ?? env.Path;
	if (!pathValue) return { path: null, extension: null, checkedPaths: [] };
	const pathExt = env.PATHEXT ?? env.PathExt ?? "";
	const extensions: string[] = [];
	for (const value of pathExt.split(";")) {
		const extension = value.trim().toUpperCase();
		if (
			WINDOWS_PI_EXTENSIONS.includes(extension) &&
			!extensions.includes(extension)
		) {
			extensions.push(extension);
		}
	}
	for (const extension of WINDOWS_PI_EXTENSIONS) {
		if (!extensions.includes(extension)) extensions.push(extension);
	}

	const checkedPaths: string[] = [];
	for (const rawDir of pathValue.split(";")) {
		const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
		if (!dir) continue;
		for (const extension of extensions) {
			const candidate = join(dir, `pi${extension.toLowerCase()}`);
			checkedPaths.push(candidate);
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
					return { path: candidate, extension, checkedPaths };
				}
			} catch {
				// A bad PATH entry must not stop the remaining PATHEXT walk.
			}
		}
	}
	return { path: null, extension: null, checkedPaths };
}

function isGenericRuntimeExecutable(execPath: string): boolean {
	return /^(node(?:js)?\d*|bun)(\.exe)?$/.test(
		basename(execPath).toLowerCase(),
	);
}

function formatCheckedPaths(checkedPaths: readonly string[]): string {
	const unique = [...new Set(checkedPaths)];
	const visible = unique.slice(0, 12);
	return unique.length > visible.length
		? `${visible.join(", ")} (+${unique.length - visible.length} more)`
		: visible.join(", ");
}

function resolvePiInvocation(
	options: ResolvePiInvocationOptions = {},
): PiInvocation {
	const fs = { ...DEFAULT_PI_RESOLUTION_FS, ...options.fs } as PiResolutionFs;
	const execPath = options.execPath ?? process.execPath;
	const currentScript = options.argv1 ?? process.argv[1];
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const resolvePackageJson =
		options.resolvePackageJson ?? defaultResolvePiPackageJson;
	const running = resolvePiCliFromRunningEntry(currentScript, fs);
	const checkedPaths = [...running.checkedPaths];

	if (running.cliPath) {
		return {
			command: execPath,
			prefixArgs: [running.cliPath],
			targetHarness:
				running.targetHarness ??
				piHarnessKindFromExecutable(running.cliPath) ??
				resolvePiHarnessKind(),
		};
	}

	if (!isGenericRuntimeExecutable(execPath)) {
		// For a packaged single-file CLI, the executable itself parses argv.
		return {
			command: execPath,
			prefixArgs: [],
			targetHarness:
				piHarnessKindFromExecutable(execPath) ?? resolvePiHarnessKind(),
		};
	}

	const bundled = resolveBundledPiCli(
		currentScript,
		fs,
		resolvePackageJson,
		checkedPaths,
	);
	if (bundled.cliPath) {
		return {
			command: execPath,
			prefixArgs: [bundled.cliPath],
			targetHarness:
				bundled.targetHarness ??
				piHarnessKindFromExecutable(bundled.cliPath) ??
				resolvePiHarnessKind(),
		};
	}

	const detectionMiss = `script-detection miss on ${formatCheckedPaths(checkedPaths)}`;
	if (platform === "win32") {
		const resolved = resolveWindowsPiCommand(env, fs);
		if (resolved.path && resolved.extension) {
			const diagnostic = `${detectionMiss}; Windows PATHEXT resolved ${resolved.path}`;
			if (resolved.extension === ".CMD" || resolved.extension === ".BAT") {
				const command = env.ComSpec?.trim() || env.COMSPEC?.trim() || "cmd.exe";
				return {
					command,
					prefixArgs: ["/d", "/s", "/c", resolved.path],
					targetHarness: piHarnessKindFromExecutable(resolved.path) ?? "pi",
					fallbackDiagnostic: diagnostic,
				};
			}
			if (resolved.extension === ".PS1") {
				const command = env.SystemRoot
					? join(
							env.SystemRoot,
							"System32",
							"WindowsPowerShell",
							"v1.0",
							"powershell.exe",
						)
					: "powershell.exe";
				return {
					command,
					prefixArgs: [
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-File",
						resolved.path,
					],
					targetHarness: piHarnessKindFromExecutable(resolved.path) ?? "pi",
					fallbackDiagnostic: diagnostic,
				};
			}
			return {
				command: resolved.path,
				prefixArgs: [],
				targetHarness: piHarnessKindFromExecutable(resolved.path) ?? "pi",
				fallbackDiagnostic: diagnostic,
			};
		}
		checkedPaths.push(...resolved.checkedPaths);
	}

	return {
		command: "pi",
		prefixArgs: [],
		targetHarness: "pi",
		fallbackDiagnostic: `script-detection miss on ${formatCheckedPaths(checkedPaths)}`,
	};
}

function isPiCliScript(scriptPath: string): boolean {
	return (
		resolvePiCliFromRunningEntry(scriptPath, DEFAULT_PI_RESOLUTION_FS)
			.cliPath !== null
	);
}

function describeSpawnFailure(
	error: unknown,
	invocation: PiInvocation,
): string {
	const message = error instanceof Error ? error.message : String(error);
	return invocation.fallbackDiagnostic
		? `${message} after ${invocation.fallbackDiagnostic}`
		: message;
}

/** Resolve an optional child extension bundled beside the Pi plugin entry. */
function resolveSiblingEntryPath(fileName: string): string | undefined {
	try {
		// Source tests run before these sibling bundles exist. Production packaging
		// emits both entries beside index.js, so missing files safely mean "skip" only
		// in that pre-build environment.
		const here = dirname(fileURLToPath(import.meta.url));
		const candidate = resolvePath(here, fileName);
		return existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

const SUBAGENT_ENTRY_PATH = resolveSiblingEntryPath("subagent-entry.js");
const HISTORIAN_CALIBRATION_ENTRY_PATH = resolveSiblingEntryPath(
	"historian-calibration-extension.js",
);

/**
 * Grace period (ms) after we detect the terminal assistant message_end
 * before we SIGTERM the Pi child. Pi's print mode often finishes the agent
 * loop and emits agent_end / a clean stopReason but doesn't actually exit
 * the process for many seconds (sometimes never on its own). Without this
 * drain, every successful run would wait the full configured timeoutMs.
 *
 * 2s gives the child enough time to flush remaining stdout buffers and
 * shut down its stdio writers cleanly on the happy path; on the (frequent)
 * unhappy path we SIGTERM and recover the assembled result we already have.
 */
const TERMINAL_DRAIN_GRACE_MS = 2_000;

/**
 * How long (ms) the runner waits for the child's stdio to close after the
 * child process itself has exited. Node fires `close` only once every process
 * holding the child's stdout/stderr has let go, and Pi can start processes
 * that inherit those pipes and outlive it (a user extension's helper, an MCP
 * stdio server). Without this bound such a process would keep the run
 * unsettled forever. One second is ample for the pipe to deliver the output
 * Pi wrote before it exited.
 */
const EXIT_STDIO_GRACE_MS = 1_000;

export const MAGIC_CONTEXT_PI_SUBAGENT_ENV = "MAGIC_CONTEXT_PI_SUBAGENT";

function isOmpHostProcess(): boolean {
	return resolvePiHarnessKind() === "omp";
}

function normalizedOmpProfile(): string | undefined {
	const raw = (process.env.OMP_PROFILE ?? process.env.PI_PROFILE)?.trim();
	return raw && raw !== "default" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw)
		? raw
		: undefined;
}

// OMP exposes a profile/custom agent directory via PI_CODING_AGENT_DIR.
// A named profile is authoritative and deliberately ignores a stale/custom
// override, matching OMP path resolution. Plain Pi also supports the same
// variable, so consume it only when the child target is positively OMP.
function getHostAgentSettingsDir(targetHarness: PiHarnessKind): string {
	if (targetHarness !== "omp") return join(homedir(), ".pi", "agent");
	const configRoot = join(
		homedir(),
		process.env.PI_CONFIG_DIR?.trim() || ".omp",
	);
	const profile = normalizedOmpProfile();
	if (profile) return join(configRoot, "profiles", profile, "agent");
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured ? resolvePath(configured) : join(configRoot, "agent");
}

function modelRefToCanonicalForTarget(
	ref: string,
	targetHarness: PiHarnessKind,
): string {
	return targetHarness === "omp"
		? ompModelRefToCanonical(ref)
		: piModelRefToCanonical(ref);
}

function resolveModelRefForTarget(
	ref: string,
	targetHarness: PiHarnessKind,
): string {
	return targetHarness === "omp"
		? resolveModelRefForOmp(ref)
		: resolveModelRefForPi(ref);
}
let configuredSubagentExtensions: readonly string[] | undefined;

/** Configure the user-tier extension allowlist used by new Pi child runners. */
export function configurePiSubagentExtensions(
	extensions: readonly string[] | undefined,
): void {
	configuredSubagentExtensions = extensions?.slice();
}

function resolveSubagentExtensionEntry(
	entry: string,
	targetHarness: PiHarnessKind,
): string {
	const trimmed = entry.trim();
	const isNpmSource = trimmed.startsWith("npm:");
	return !isNpmSource && !isAbsolute(trimmed)
		? resolvePath(getHostAgentSettingsDir(targetHarness), trimmed)
		: trimmed;
}

const PI_READ_ONLY_BUILTINS = ["read", "grep", "find", "ls"] as const;
const PI_AFT_READ_TOOLS = ["aft_outline", "aft_zoom", "aft_search"] as const;
const PI_BUILTIN_TOOL_NAMES: Readonly<Record<string, true>> = {
	read: true,
	grep: true,
	find: true,
	ls: true,
	bash: true,
	edit: true,
	write: true,
};
let configuredHostToolNames: (() => readonly string[] | undefined) | undefined;
const loggedUnavailableBuiltinTools = new Set<string>();

/** Read the host's live tool registry when building each child invocation. */
export function configurePiSubagentHostTools(
	getToolNames: (() => readonly string[] | undefined) | undefined,
): void {
	configuredHostToolNames = getToolNames;
}

/**
 * Set of subagent agent ids that get ctx_memory in the lean child extension.
 * Only dreamer-equivalent agents need memory mutation/list capabilities.
 *
 * Membership uses the SAME agent strings the Pi callers actually pass
 * (see e.g. `dreamer/index.ts` passing `"magic-context-dreamer"`). If
 * a new dreamer-equivalent caller is added, register its agent id
 * here too. Mismatched agent strings silently disable the elevated
 * action surface.
 */
const DREAMER_ACTION_AGENTS: ReadonlySet<string> = new Set([
	"dreamer",
	"magic-context-dreamer",
]);
const SEARCH_ONLY_SUBAGENT_TOOL_AGENTS: ReadonlySet<string> = new Set([
	"dreamer-retrospective",
	// Loads the lean extension so ctx_search is REGISTERED (the strict allow-list
	// only gates an existing registration). Deliberately NOT in
	// DREAMER_ACTION_AGENTS — that would add ctx_memory, whose mutations bump the
	// project memory epoch and bust m[0], breaking the primers cache-neutral
	// contract.
	"dreamer-primer-investigator",
]);

/**
 * Agents that must run under a HARD tool allow-list (`pi --tools <names>`), not
 * just a narrowed extension. The allow-list is a registry-build filter in Pi
 * (AgentSession._refreshToolRegistry): a tool enters the registry ONLY if its
 * name is in the set, so it strips Pi's built-ins (read/bash/edit/write) AND any
 * other extension tool, leaving exactly the named tools. This is the Pi mirror of
 * OpenCode's per-agent locked allow-list — every dreamer TASK agent runs under a
 * tight, per-task tool budget. The allow-list only KEEPS an existing
 * registration; for the ctx_* tools the lean extension must still have registered
 * them (see the *_SUBAGENT_TOOL_AGENTS sets above). For aft_* tools, Pi tolerates
 * names that no extension registered: unknown names are absent from the registry
 * after filtering, so listing optional AFT read tools is safe when AFT is not
 * installed while still allowing them when an AFT provider extension is present.
 *
 * HOST CAVEAT — this is a capability boundary on Pi only. OMP applies
 * `--tools` to built-ins and then appends discovered extension tools, so on
 * OMP these entries describe the intended budget rather than an enforced
 * extension-tool sandbox.
 */
const STRICT_TOOL_ALLOWLIST_ENTRIES: readonly (readonly [
	string,
	readonly string[],
])[] = [
	["dreamer-retrospective", ["ctx_search"]],
	["smart-note-compiler", []],
	// First pass, repair, recomp and editor prompts transform supplied text into XML without tools.
	["magic-context-historian", []],
	["historian", []],
	["historian-recomp", []],
	["historian-editor", []],
	// classify-memories: a pure metadata transform (prompt in → XML out). ZERO
	// tools — it scores from the memory text and the host applies the columns.
	["dreamer-classifier", []],
	// review-user-memories: a pure JSON reviewer of behavioral observations. It
	// calls NO tools — the host applies its verdict — so zero tools (mirrors the
	// classifier). Not in any *_SUBAGENT_TOOL_AGENTS set → no extension loaded.
	["dreamer-reviewer", []],
	// refresh-primers code investigator: read-only investigation of the CURRENT
	// source. Pi's own canonical read-only set is {read, grep, find, ls}
	// (createReadOnlyToolDefinitions), plus ctx_search and the optional AFT read
	// navigation tools OpenCode grants. NO bash/edit/write and NO ctx_memory.
	[
		"dreamer-primer-investigator",
		[...PI_READ_ONLY_BUILTINS, ...PI_AFT_READ_TOOLS, "ctx_search"],
	],
	// map-memories / verify reader: read-only check against the CURRENT LOCAL
	// source. Same read-only lock as the primer investigator but WITHOUT ctx_search
	// — these tasks read local code, not cross-session recall. The host applies the
	// manifest's DB writes, so no ctx_memory is needed.
	["dreamer-memory-mapper", [...PI_READ_ONLY_BUILTINS, ...PI_AFT_READ_TOOLS]],
	// Docs proposals use read-only source investigation; the host handles validation.
	["dreamer-docs", [...PI_READ_ONLY_BUILTINS, ...PI_AFT_READ_TOOLS]],
	// curate (base `dreamer`): memory-pool hygiene via ctx_memory ONLY. It is in
	// DREAMER_ACTION_AGENTS so the lean extension registers ctx_memory; this
	// allow-list then strips ALL 7 built-ins, leaving only the extension-provided
	// ctx_memory plus ctx_memory_list (curate never reads code — a separate verify task owns that).
	["dreamer", ["ctx_memory", "ctx_memory_list"]],
	// Pi dreamer facade default when body.agent is absent (`dreamer/index.ts`).
	// Same memory-tool-only lock as `dreamer`; must stay in sync with
	// DREAMER_ACTION_AGENTS (every member needs a strict entry).
	["magic-context-dreamer", ["ctx_memory", "ctx_memory_list"]],
];

const STRICT_TOOL_ALLOWLIST: ReadonlyMap<string, readonly string[]> = new Map(
	STRICT_TOOL_ALLOWLIST_ENTRIES,
);

const ZERO_TOOL_PROMPT_REQUIRED_AGENTS: ReadonlySet<string> = new Set(
	STRICT_TOOL_ALLOWLIST_ENTRIES.filter(([, tools]) => tools.length === 0).map(
		([agent]) => agent,
	),
);

/**
 * OMP validates `--tools` against built-in names before extensions register.
 * Translate Pi-only built-ins, discard extension tool names that cannot be
 * addressed by this flag, and deduplicate aliases. When the host registry is
 * available, keep only built-ins that are registered in the current session.
 *
 * This narrows OMP's built-in surface only. OMP does not set
 * `restrictToolNames`, so discovered AFT/MCP/ctx tools remain available.
 */
const OMP_TOOL_ALIASES: Readonly<Record<string, string>> = {
	find: "glob",
	ls: "glob",
};

const OMP_ALLOWLISTABLE_TOOLS: Readonly<Record<string, true>> = {
	read: true,
	grep: true,
	glob: true,
	bash: true,
	edit: true,
	write: true,
};

function resolveHostToolAllowlist(
	tools: readonly string[],
	ompHost: boolean = isOmpHostProcess(),
	hostToolNames?: readonly string[],
): readonly string[] {
	return resolveHostToolAllowlistDetails(tools, ompHost, hostToolNames).tools;
}

function resolveHostToolAllowlistDetails(
	tools: readonly string[],
	ompHost: boolean,
	hostToolNames?: readonly string[],
): { tools: readonly string[]; dropped: readonly string[] } {
	const candidates: string[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		const mapped = ompHost ? (OMP_TOOL_ALIASES[tool] ?? tool) : tool;
		if (ompHost && OMP_ALLOWLISTABLE_TOOLS[mapped] !== true) continue;
		if (seen.has(mapped)) continue;
		seen.add(mapped);
		candidates.push(mapped);
	}
	if (hostToolNames === undefined) return { tools: candidates, dropped: [] };

	const registered = new Set(hostToolNames);
	const available: string[] = [];
	const dropped: string[] = [];
	for (const tool of candidates) {
		const isBuiltin = ompHost
			? OMP_ALLOWLISTABLE_TOOLS[tool] === true
			: PI_BUILTIN_TOOL_NAMES[tool] === true;
		if (isBuiltin && !registered.has(tool)) {
			dropped.push(tool);
			continue;
		}
		available.push(tool);
	}
	return { tools: available, dropped };
}

const KNOWN_PI_SUBAGENT_AGENTS = [
	"magic-context-historian",
	"historian",
	"historian-recomp",
	"historian-editor",
	"dreamer-retrospective",
	"smart-note-compiler",
	"dreamer-classifier",
	"dreamer-reviewer",
	"dreamer-primer-investigator",
	"dreamer-memory-mapper",
	"dreamer-docs",
	"dreamer",
	"magic-context-dreamer",
] as const;

function inferAccountingSubagent(agent: string): SubagentKind {
	if (agent.includes("retrospective")) return "dreamer";
	if (agent.includes("dreamer")) return "dreamer";
	if (agent.includes("compressor")) return "compressor";
	if (agent.includes("recomp")) return "recomp";
	return "historian";
}

type FailedRunResult = Extract<SubagentRunResult, { ok: false }>;

type PiRunMode = {
	disableDiscoveredExtensions: boolean;
};

const ALREADY_PROCESSING_PREFIX = "Agent is already processing";
// Logged when the one-shot isolated retry (--no-extensions for discovered user
// extensions) fires because a loaded extension started its own agent turn
// before the child's prompt could run (issue #222). The text is asserted
// verbatim by the subagent-runner tests; keep it stable.
const ISOLATED_RETRY_COLLISION_LOG_MESSAGE =
	"pi subagent: a loaded Pi extension started an agent turn before the child's prompt could run; retrying with an isolated extension set (user extensions disabled for this run)";
// Logged when the same isolated retry fires for the issue #238 signature: the
// child exited 0 but produced no protocol output at all (no agent_end / zero
// stdout), which certain user extension sets cause in Pi --print mode.
const ISOLATED_RETRY_SILENT_LOG_MESSAGE =
	"pi subagent: child exited successfully but emitted no protocol output (no agent_end, zero stdout); a loaded Pi extension likely broke print mode; retrying with an isolated extension set (user extensions disabled for this run)";
const ISOLATED_RETRY_MODEL_UNAVAILABLE_MESSAGE =
	"model unavailable in isolated retry: it is provided by a disabled extension; configure it through models.json or add a built-in/provider-configured fallback";
const MODEL_RESOLUTION_ERROR_PATTERNS = [
	/unknown model/i,
	/unknown provider/i,
	/model.+not found/i,
	/provider.+not found/i,
	/could not resolve model/i,
	/no models? (matched|available|configured)/i,
	/model.+not configured/i,
] as const;

/** Canonical provider prefix -> the Pi provider form that last succeeded. */
const PI_PROVIDER_FORM_CACHE = new Map<string, string>();

type ProviderModelAttempt = {
	canonicalRef: string;
	canonicalProvider: string;
	modelRef: string;
	attemptedProvider: string;
	translated: boolean;
};

type ExtensionRetryResult = {
	result: SubagentRunResult;
	extensionRetryUsed: boolean;
};

/**
 * Pi-side implementation of `SubagentRunner`.
 *
 * Spawns `pi --print --mode json` as a child process and consumes its
 * NDJSON event stream over stdout until the `agent_end` event delivers
 * the full final message array. We extract the last assistant message's
 * concatenated text content and return it as the run result.
 *
 * Why subprocess instead of in-process?
 * - Pi's @earendil-works/pi-coding-agent has no in-process child-session
 *   API equivalent to OpenCode's `client.session.create() / .prompt()`.
 *   Sessions are tied to a SessionManager that runs the interactive UI
 *   loop, and the agent loop expects to own stdout/stderr.
 * - The print-mode subprocess path is the *only* officially supported
 *   single-shot invocation in Pi today, and it's stable: it emits a
 *   well-typed NDJSON event stream regardless of which provider/model
 *   is targeted. Spawning is more expensive (cold-start ~500ms) but
 *   subagent invocations already amortize that against many seconds of
 *   model latency, so the overhead is in the noise.
 *
 * Output protocol (each stdout line is one JSON object):
 *
 *   { type: "session", id, version, timestamp, cwd }
 *   { type: "agent_start" }
 *   { type: "turn_start" }
 *   { type: "message_start", message: { role, content, ... } }
 *   { type: "message_end",   message: { role, content, ... } }
 *   ... possibly more turn_start / message_start / message_end / turn_end on tool calls ...
 *   { type: "agent_end", messages: [ ... full final message array ... ] }
 *
 * The `agent_end` event is the authoritative final state. We ignore
 * intermediate `message_*` events for result extraction (we only need
 * the last assistant message's text).
 *
 * Failure modes we handle explicitly:
 * - `agent_end` arrives but the last assistant message has stopReason
 *   "error" or "aborted" → `model_failed` with the embedded errorMessage.
 * - Process exits non-zero before `agent_end` is observed → `non_zero_exit`.
 * - Process exits zero with no assistant result → `no_assistant`.
 * - Malformed JSON output before completion → `parse_failed`.
 * - Spawn itself fails (binary missing, permission denied) → `spawn_failed`.
 * - Caller's AbortSignal fires → kill the child + return `abort`.
 * - `timeoutMs` elapses before `agent_end` → kill + return `timeout`.
 *
 * What we deliberately don't expose:
 * - Tool call streaming. Subagents in Magic Context are configured with
 *   their own narrowed tool sets; if a model emits tool calls during a
 *   subagent run, those tools execute inside Pi's child process just
 *   fine — we just don't surface intermediate state to the caller.
 * - Per-turn token usage. Pi reports usage in each `message_end`, but
 *   the runner contract only returns the final assistant text. If the
 *   historian/dreamer ever needs token accounting, we'll add
 *   a `usage` field to `SubagentRunResult.meta` rather than changing
 *   the core contract.
 */
export class PiSubagentRunner implements SubagentRunner {
	readonly harness = resolvePiHarnessKind();

	/**
	 * How to invoke a Pi subagent (command + fixed leading args + shell flag).
	 * Resolved once at construction in the host process so `process.argv[1]`
	 * points at the host `cli.js`. See {@link resolvePiInvocation} for the
	 * cross-platform order; an explicit `options.piBinary` overrides it (test
	 * seam + advanced users who point at their own pi build).
	 */
	private readonly invocation: PiInvocation;
	private readonly spawnImpl: typeof childProcess.spawn;
	private readonly platform: NodeJS.Platform;
	private readonly extraArgs: readonly string[];
	/** `undefined` means preserve Pi's normal extension discovery behavior. */
	private readonly subagentExtensions: readonly string[] | undefined;
	private readonly getHostToolNames:
		| (() => readonly string[] | undefined)
		| undefined;

	constructor(
		options: {
			piBinary?: string;
			/** Override used by tests to provide command and prefix arguments instead of resolving them. */
			invocation?: PiInvocation;
			platform?: NodeJS.Platform;
			extraArgs?: readonly string[];
			/** User-tier explicit extension allowlist; an empty list disables all discovered extensions. */
			subagentExtensions?: readonly string[];
			/** Test override for the built-in tools exposed by the current host session. */
			getHostToolNames?: () => readonly string[] | undefined;
			/** Test seam for subprocess lifecycle tests. Production uses child_process.spawn. */
			spawnImpl?: typeof childProcess.spawn;
		} = {},
	) {
		this.invocation =
			options.invocation ??
			(options.piBinary
				? {
						command: options.piBinary,
						prefixArgs: [],
						targetHarness:
							piHarnessKindFromExecutable(options.piBinary) ??
							resolvePiHarnessKind(),
					}
				: resolvePiInvocation({ platform: options.platform }));
		this.spawnImpl = options.spawnImpl ?? childProcess.spawn;
		this.platform = options.platform ?? process.platform;
		this.extraArgs = options.extraArgs ?? [];
		this.subagentExtensions =
			options.subagentExtensions ?? configuredSubagentExtensions;
		this.getHostToolNames = options.getHostToolNames;
	}

	async run(options: SubagentRunOptions): Promise<SubagentRunResult> {
		const providerAttempt = resolveProviderModelAttempt(
			options.model,
			this.invocation.targetHarness,
		);
		const firstOptions = providerAttempt
			? { ...options, model: providerAttempt.canonicalRef }
			: options;
		const firstRun = await this.runWithExtensionRetry(
			firstOptions,
			providerAttempt?.modelRef,
		);
		if (!providerAttempt) return firstRun.result;
		if (firstRun.result.ok) {
			PI_PROVIDER_FORM_CACHE.set(
				providerAttempt.canonicalProvider,
				providerAttempt.attemptedProvider,
			);
			return firstRun.result;
		}
		if (!isProviderCredentialFailure(firstRun.result, providerAttempt)) {
			return firstRun.result;
		}

		// The canonical prefix is the second Pi choice for ambiguous providers.
		// If the extension retry already ran, keep its isolated mode for this
		// provider retry instead of starting a second independent retry tree.
		const fallbackOptions = {
			...options,
			model: providerAttempt.canonicalRef,
		};
		const fallbackRun: ExtensionRetryResult = firstRun.extensionRetryUsed
			? {
					result: await this.runModelChain(
						fallbackOptions,
						{ disableDiscoveredExtensions: true },
						providerAttempt.canonicalRef,
					),
					extensionRetryUsed: true,
				}
			: await this.runWithExtensionRetry(
					fallbackOptions,
					providerAttempt.canonicalRef,
				);
		if (fallbackRun.result.ok) {
			PI_PROVIDER_FORM_CACHE.set(
				providerAttempt.canonicalProvider,
				providerAttempt.canonicalProvider,
			);
		}
		return fallbackRun.result;
	}

	private async runWithExtensionRetry(
		options: SubagentRunOptions,
		modelRefOverride?: string,
	): Promise<ExtensionRetryResult> {
		const primaryRunMode: PiRunMode = { disableDiscoveredExtensions: false };
		const primaryResult = await this.runModelChain(
			options,
			primaryRunMode,
			modelRefOverride,
		);
		if (
			this.spawnUsesNoExtensions(primaryRunMode) ||
			!isIsolatedRetryTrigger(primaryResult)
		) {
			return { result: primaryResult, extensionRetryUsed: false };
		}

		const sessionId = options.accountingSessionId ?? "pi-subagent";
		sessionLog(sessionId, isolatedRetryLogMessage(primaryResult));
		const isolatedResult = await this.runModelChain(
			options,
			{ disableDiscoveredExtensions: true },
			modelRefOverride,
		);
		if (!isolatedResult.ok && isIsolatedRetryModelUnavailable(isolatedResult)) {
			sessionLog(sessionId, ISOLATED_RETRY_MODEL_UNAVAILABLE_MESSAGE);
			return {
				result: annotateIsolatedRetryModelUnavailable(isolatedResult),
				extensionRetryUsed: true,
			};
		}
		return { result: isolatedResult, extensionRetryUsed: true };
	}

	private async runModelChain(
		options: SubagentRunOptions,
		runMode: PiRunMode,
		primaryModelRef?: string,
	): Promise<SubagentRunResult> {
		const attempts: Array<ResolvedModelEntry | undefined> = [];
		const seenAttempts = new Set<string>();
		const appendAttempt = (candidate: ResolvedModelEntry): void => {
			if (!candidate.model) return;
			const key = `${candidate.model}\u0000${candidate.qualifier ?? ""}`;
			if (seenAttempts.has(key)) return;
			seenAttempts.add(key);
			attempts.push(candidate);
		};
		if (options.model) {
			appendAttempt({
				model: options.model,
				...(options.thinkingLevel ? { qualifier: options.thinkingLevel } : {}),
			});
		}
		for (const candidate of options.fallbackModels ?? []) {
			appendAttempt(
				typeof candidate === "string" ? { model: candidate } : candidate,
			);
		}
		if (attempts.length === 0) attempts.push(undefined);
		let lastResult: SubagentRunResult | null = null;
		for (let index = 0; index < attempts.length; index += 1) {
			const attempt = attempts[index];
			const attemptOptions = {
				...options,
				model: attempt?.model,
				// A fallback's qualifier belongs only to that fallback. A bare
				// fallback deliberately clears the primary --thinking level.
				thinkingLevel: attempt?.qualifier,
				fallbackModels: undefined,
			};
			const result = await this.runOnce(
				attemptOptions,
				runMode,
				index === 0 ? primaryModelRef : undefined,
			);
			if (result.ok) return result;
			lastResult = result;
			// Pi print mode discovers extensions before reading stdin, and a loaded
			// user extension can break the run in two ways that both look like the
			// extension set is at fault:
			//  1. (#222) it starts its own agent turn during startup, so the child
			//     hits a prompt conflict before it can accept Magic Context's input
			//     (non-zero exit + "Agent is already processing" on stderr);
			//  2. (#238) it makes Pi --print exit 0 with NO protocol output at all
			//     (no agent_end / zero stdout), classified as no_assistant.
			// Either way, stop this extension-enabled attempt on the first model and
			// let the outer caller retry the same run once with discovered extensions
			// disabled, instead of burning every fallback model on the same doomed
			// primary. Later top-level runs still start with extensions enabled (the
			// degrade is per-attempt, not cached) so extension-provided models keep
			// working normally.
			if (
				!this.spawnUsesNoExtensions(runMode) &&
				isIsolatedRetryTrigger(result)
			) {
				return result;
			}
			if (index >= attempts.length - 1 || !isFallbackEligible(result.reason)) {
				return result;
			}
		}
		return (
			lastResult ??
			this.runOnce(
				{ ...options, fallbackModels: undefined },
				runMode,
				primaryModelRef,
			)
		);
	}

	private spawnUsesNoExtensions(runMode: PiRunMode): boolean {
		return (
			runMode.disableDiscoveredExtensions ||
			this.subagentExtensions !== undefined ||
			hasNoExtensionsArg([...this.invocation.prefixArgs, ...this.extraArgs])
		);
	}

	private readHostToolNames(): readonly string[] | undefined {
		// Only OMP rejects disabled built-ins in --tools. Pi must keep its normal
		// allow-list and must not consult a possibly unbound host action API.
		if (this.invocation.targetHarness !== "omp") return undefined;
		try {
			return this.getHostToolNames?.() ?? configuredHostToolNames?.();
		} catch {
			// SDK loaders can evaluate an extension without binding a runner. An
			// unavailable registry is not an empty registry: retain the normal tools.
			return undefined;
		}
	}

	private async runOnce(
		options: SubagentRunOptions,
		runMode: PiRunMode,
		modelRefOverride?: string,
	): Promise<SubagentRunResult> {
		const startTime = Date.now();
		let recordedAccounting = false;
		const cap = subagentStepCap(options.agent);
		const budget = options.tokenBudget
			? createDreamTokenBudget(options.tokenBudget)
			: undefined;
		const telemetry = new SubagentTelemetry(options.systemPrompt, (line) =>
			sessionLog(options.accountingSessionId ?? "subagent", line),
		);
		let loggedTelemetry = false;
		const recordAccounting = (
			result: SubagentRunResult,
			messages: unknown[] = [],
		) => {
			if (!loggedTelemetry) {
				loggedTelemetry = true;
				telemetry.finish(
					options.agent,
					result.ok ? "completed" : result.reason,
					cap,
				);
			}
			if (!options.accountingSessionId || recordedAccounting) return;
			recordedAccounting = true;
			recordChildInvocation({
				db: openDatabase(),
				parentSessionId: options.accountingSessionId,
				harness: this.harness,
				subagent:
					options.accountingSubagent ?? inferAccountingSubagent(options.agent),
				task: options.accountingTask ?? null,
				startedAt: startTime,
				status: result.ok
					? "completed"
					: result.reason === "abort"
						? "aborted"
						: result.reason === "timeout"
							? "timed_out"
							: result.reason === "no_assistant" ||
									result.reason === "truncated"
								? "empty"
								: "failed",
				messages,
				providerId:
					typeof options.model === "string"
						? options.model.split("/")[0]
						: null,
				modelId:
					typeof options.model === "string"
						? options.model.split("/").slice(1).join("/")
						: null,
				error: result.ok ? null : result.error,
				parentInvocationId: options.accountingParentInvocationId ?? null,
			});
		};
		if (options.signal?.aborted) {
			const result: SubagentRunResult = {
				ok: false,
				reason: "abort",
				error: "pi subagent aborted by caller",
				durationMs: Date.now() - startTime,
			};
			// Same best-effort contract as settle(): accounting must never throw
			// out of the return path (a DB write failure here would propagate to
			// the caller as a spurious spawn error). Telemetry is best-effort.
			try {
				recordAccounting(result);
			} catch (err) {
				sessionLog(
					options.accountingSessionId ?? "subagent",
					`subagent accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return result;
		}

		const failBeforeSpawn = (
			reason: Extract<SubagentRunResult, { ok: false }>["reason"],
			error: string,
			transient = false,
		): SubagentRunResult => {
			const result: SubagentRunResult = {
				ok: false,
				reason,
				error,
				durationMs: Date.now() - startTime,
				...(transient ? { transient: true } : {}),
			};
			try {
				recordAccounting(result);
			} catch (err) {
				sessionLog(
					options.accountingSessionId ?? "subagent",
					`subagent accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return result;
		};

		// A zero-tool child cannot receive its task instructions unless a system
		// prompt is provided. Refuse before spawning so Pi cannot substitute a
		// persisted user-mode prompt.
		if (
			ZERO_TOOL_PROMPT_REQUIRED_AGENTS.has(options.agent) &&
			options.systemPrompt.trim().length === 0
		) {
			return failBeforeSpawn(
				"invalid_prompt",
				`zero-tool Pi subagent "${options.agent}" requires a non-empty system prompt`,
				true,
			);
		}

		const fence = probeChildSpawnFence(openDatabase());
		if (!fence.allowSpawn) {
			return failBeforeSpawn(
				"spawn_failed",
				`Magic Context: plugin build is older than its database (database=v${fence.failure.persistedVersion}, supported_fence=v${fence.failure.supportedVersion}) — restart Pi.`,
			);
		}

		// Large prompts (e.g. a ~50K-token historian chunk ≈ 200 KB) overflow
		// Linux's per-argv-entry limit (MAX_ARG_STRLEN, 128 KiB) and make spawn()
		// fail with E2BIG. Windows is stricter: CreateProcess caps the ENTIRE
		// command line at 32,767 chars, so even small user prompts should stay out
		// of argv there to leave room for flags and the temp-file system prompt.
		// Pi's print mode concatenates stdin into the initial message, so when we
		// pipe the prompt we must omit the positional argv to avoid duplication.
		const promptBytes = Buffer.byteLength(options.userMessage, "utf8");
		const budgetToolGuardAvailable =
			SUBAGENT_ENTRY_PATH !== undefined ||
			this.subagentExtensions?.some(
				(extension) => basename(extension) === "subagent-entry.js",
			) === true;
		const rpcBudget =
			options.tokenBudget !== undefined &&
			this.invocation.targetHarness === "pi" &&
			budgetToolGuardAvailable;
		const deliverViaStdin =
			!rpcBudget &&
			(promptBytes > PROMPT_ARGV_MAX_BYTES || this.platform === "win32");
		let systemPromptTempDir: string | undefined;
		let systemPromptPath: string | undefined;
		const cleanupSystemPromptFile = () => {
			if (!systemPromptTempDir) return;
			const tempDir = systemPromptTempDir;
			systemPromptTempDir = undefined;
			systemPromptPath = undefined;
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Temp-file cleanup is best-effort and must never mask the run result.
			}
		};
		if (options.systemPrompt.length > 0) {
			try {
				systemPromptTempDir = mkdtempSync(join(tmpdir(), "mc-pi-prompt-"));
				systemPromptPath = join(systemPromptTempDir, "system-prompt.txt");
				writeFileSync(systemPromptPath, options.systemPrompt, "utf8");
			} catch (error) {
				cleanupSystemPromptFile();
				return failBeforeSpawn(
					"spawn_failed",
					`failed to prepare pi system prompt file: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (rpcBudget && !systemPromptTempDir) {
			try {
				systemPromptTempDir = mkdtempSync(join(tmpdir(), "mc-pi-prompt-"));
			} catch (error) {
				return failBeforeSpawn(
					"spawn_failed",
					`failed to prepare pi budget guard: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const budgetGuardFile =
			rpcBudget && systemPromptTempDir
				? join(systemPromptTempDir, "budget-guard")
				: undefined;
		if (budgetGuardFile) {
			try {
				writeFileSync(budgetGuardFile, "", "utf8");
			} catch (error) {
				cleanupSystemPromptFile();
				return failBeforeSpawn(
					"spawn_failed",
					`failed to write pi budget guard: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const args = buildArgs(options, {
			targetHarness: this.invocation.targetHarness,
			disableDiscoveredExtensions: runMode.disableDiscoveredExtensions,
			subagentExtensions: this.subagentExtensions,
			hostToolNames: this.readHostToolNames(),
			omitPositionalMessage: deliverViaStdin || rpcBudget,
			systemPromptPath,
			modelRef: modelRefOverride,
			rpc: rpcBudget,
		});

		// The model spec is `provider/model` — Pi accepts that directly via
		// `--model provider/id` (no separate `--provider` flag needed). When a
		// fallback chain is configured, `buildArgs` emits Pi's `--models a,b,c`.

		return new Promise<SubagentRunResult>((resolve) => {
			let accountingMessages: unknown[] = [];
			// Track whether we've already resolved so timeout/abort/exit don't
			// double-resolve. JS promises tolerate double-resolve silently but
			// we want explicit control so we can distinguish "timeout fired
			// during normal completion race" from "timeout actually decided
			// the outcome."
			let settled = false;
			const settle = (result: SubagentRunResult) => {
				if (settled) return;
				settled = true;
				if (
					accountingMessages.length > 0 &&
					/historian|dreamer|classify/i.test(options.agent)
				) {
					const last = [...accountingMessages]
						.reverse()
						.find(
							(message) =>
								message !== null &&
								typeof message === "object" &&
								(message as { role?: string }).role === "assistant",
						) as
						| { usage?: unknown; stopReason?: string; content?: unknown[] }
						| undefined;
					const responseChars = result.ok
						? result.assistantText.length
						: (last?.content
								?.filter(
									(part): part is { type: string; text: string } =>
										typeof part === "object" &&
										part !== null &&
										(part as { type?: string }).type === "text" &&
										typeof (part as { text?: unknown }).text === "string",
								)
								.reduce((sum, part) => sum + part.text.length, 0) ?? 0);
					const tokenDetails = formatRunTokenLog(
						runTokenLog(last?.usage, options.maxOutputTokens, last?.stopReason),
					);
					if (!result.ok && result.reason === "truncated") {
						result = { ...result, error: `${result.error}; ${tokenDetails}` };
					}
					sessionLog(
						options.accountingSessionId ?? "subagent",
						`${options.agent} response_chars=${responseChars} ${tokenDetails}`,
					);
				}
				const outcome: SubagentRunResult = budget
					? {
							...result,
							meta: { ...result.meta, tokenBudget: budget.snapshot() },
						}
					: result;
				cleanupSystemPromptFile();
				// recordAccounting must never block resolution: a throw here (e.g.
				// a DB write failure during token accounting) would leave the
				// promise unresolved and hang the caller (historian/dreamer).
				// Accounting is best-effort telemetry; resolve regardless.
				try {
					recordAccounting(outcome, accountingMessages);
				} catch (err) {
					sessionLog(
						options.accountingSessionId ?? "subagent",
						`subagent accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				resolve(outcome);
			};

			// Helper that wraps the optional caller-provided progress
			// callback so we never throw on its mistakes — historian/dreamer
			// log handlers must not be allowed to crash the runner.
			const emitProgress = (event: SubagentProgressEvent) => {
				if (!options.onProgress) return;
				try {
					options.onProgress(event);
				} catch {
					// progress callbacks are non-critical
				}
			};

			let child: ReturnType<typeof childProcess.spawn>;
			try {
				child = this.spawnImpl(
					this.invocation.command,
					[...this.invocation.prefixArgs, ...this.extraArgs, ...args],
					{
						windowsHide: true,
						cwd: options.cwd,
						// Merge over the parent env so PATH/HOME/auth variables flow
						// through for provider extensions. The guard only disables Magic
						// Context's full entry; it must not replace the process env.
						env: {
							...process.env,
							[MAGIC_CONTEXT_PI_SUBAGENT_ENV]: "1",
							MAGIC_CONTEXT_SUBAGENT_PROMPT_FILE: systemPromptPath,
							MAGIC_CONTEXT_SUBAGENT_BUDGET_GUARD_FILE: budgetGuardFile,
							MAGIC_CONTEXT_SUBAGENT_PROVENANCE_ONLY:
								/^(magic-context-)?historian(?:-recomp|-editor)?$/.test(
									options.agent,
								)
									? undefined
									: "1",
							...(options.temperature !== undefined
								? {
										MAGIC_CONTEXT_HISTORIAN_TEMPERATURE: String(
											options.temperature,
										),
									}
								: {}),
							...(options.maxOutputTokens !== undefined
								? {
										MAGIC_CONTEXT_HISTORIAN_MAX_OUTPUT_TOKENS: String(
											options.maxOutputTokens,
										),
									}
								: {}),
						},
						// stdout = JSON events; stderr = diagnostics. stdin is a pipe
						// when we deliver the user message there (always on Windows, or
						// for oversized prompts elsewhere). Otherwise it stays closed
						// because the message rides in argv and print-mode would block
						// reading an open, idle stdin.
						stdio: [
							deliverViaStdin || rpcBudget ? "pipe" : "ignore",
							"pipe",
							"pipe",
						],
					},
				);
			} catch (error) {
				cleanupSystemPromptFile();
				settle({
					ok: false,
					reason: "spawn_failed",
					error: describeSpawnFailure(error, this.invocation),
					durationMs: Date.now() - startTime,
				});
				return;
			}

			if (options.signal?.aborted) {
				terminateChild(child);
				settle({
					ok: false,
					reason: "abort",
					error: "pi subagent aborted by caller",
					durationMs: Date.now() - startTime,
				});
				return;
			}

			emitProgress({ type: "spawned", argv: args, pid: child.pid });

			// Stdin-delivery path: feed the message through stdin, then close it so
			// Pi's print-mode stdin read resolves (it waits for EOF). Guarded by
			// child.stdin presence (only opened when deliverViaStdin).
			if (rpcBudget && child.stdin) {
				child.stdin.on("error", (error) => {
					terminateChild(child);
					settle({
						ok: false,
						reason: budget?.snapshot().finalizeFired
							? "token_budget"
							: "spawn_failed",
						error: `Pi RPC input failed: ${error.message}`,
						durationMs: Date.now() - startTime,
					});
				});
				child.stdin.write(
					`${JSON.stringify({
						type: "prompt",
						message: options.userMessage,
						id: "dreamer-initial",
					})}\n`,
				);
			} else if (deliverViaStdin && child.stdin) {
				// A pipe failure (child exited early / was terminated mid-write)
				// surfaces as an async "error" event on the stream, NOT via the
				// try/catch around .end(). Without a listener, an EPIPE would
				// become an unhandled 'error' that can crash the host process.
				// Attach the no-throw listener BEFORE writing; the real failure
				// reason is reported by the exit/stderr/timeout handlers below.
				child.stdin.on("error", () => {
					// EPIPE / destroyed-stream: non-fatal runner noise.
				});
				try {
					child.stdin.end(options.userMessage, "utf8");
				} catch {
					// Synchronous throw (e.g. already-destroyed stream); exit/stderr
					// handlers below surface the actual failure.
				}
			}

			// Capture stderr so we can attach it to error reasons. Pi prints
			// unrecoverable errors (auth failures, network) here before the
			// process exits. Also forward each chunk to the progress channel
			// so historian failure logs see the message immediately rather
			// than only at child exit (a hung child wouldn't surface this
			// otherwise).
			let stderr = "";
			let stderrLine = "";
			// Pipe chunks split anywhere, including inside a multibyte UTF-8
			// character; the decoder carries the partial bytes into the next chunk.
			const stderrDecoder = new StringDecoder("utf8");
			child.stderr?.on("data", (chunk: Buffer) => {
				const text = stderrDecoder.write(chunk);
				if (text.length === 0) return;
				// Pi 0.87 redirects extension stdout writes to stderr to protect its
				// protocol. Accept only our content-free provenance event there.
				stderrLine += text;
				const lines = stderrLine.split("\n");
				stderrLine = (lines.pop() ?? "").slice(-4096);
				for (const line of lines) {
					if (settled || !line.startsWith('{"type":"mc_system_prompt"'))
						continue;
					const parsed = parsePiEventLine(line);
					if (parsed.ok) telemetry.observe(parsed.event);
				}
				stderr += text;
				// Cap to prevent unbounded growth on chatty failures.
				if (stderr.length > 16_000) {
					stderr = `…[truncated]${stderr.slice(-16_000)}`;
				}
				emitProgress({ type: "stderr", chunk: text });
			});
			// A pipe 'error' (EPIPE/ECONNRESET on the child's stderr, e.g. child
			// died mid-write) emits on the stream; with no listener Node rethrows
			// it as an unhandled exception and crashes the HOST process. Swallow
			// it — child death is already handled via 'close'/'error' on the child.
			child.stderr?.on("error", () => {});

			// Track the final assistant text from `agent_end`. We don't
			// resolve eagerly on `agent_end` — we wait for child exit so
			// the OS has fully reaped the process before the caller's
			// next action (preserving the "no zombie processes" property
			// even if the caller immediately spawns another subagent).
			let finalAssistantText: string | null = null;
			let finalErrorMessage: string | null = null;
			let finalStopReason: string | null = null;
			let sawAgentEnd = false;
			let preserveDrainedResult = false;
			let parseError: string | null = null;
			// Tool-invocation count for the grounding gate (refresh-primers:
			// 0 tool calls = closed-book paraphrase, rejected). Derived at settle
			// from the accumulated assistant message CONTENT (toolCall parts) via
			// countToolCalls — NOT from a discrete tool-event, since Pi's --print
			// stdout has no reliable tool-completion event name. The authoritative
			// source is agent_end's full message array when present, else the
			// accumulated message_end messages.
			let agentEndMessages: unknown[] | null = null;

			// Terminal-drain state. Set when we detect the final assistant
			// turn, used to short-circuit the full-timeout wait on Pi's
			// often-doesn't-exit print-mode shutdown.
			let drainTimerStarted = false;
			let drainTimerHandle: ReturnType<typeof setTimeout> | undefined;

			// child.stdout/stderr can be null only when the corresponding stdio
			// slot is "ignore"/"inherit"/<fd>. We always pass "pipe" for both
			// (above), so they're guaranteed Readable streams here. Still treat
			// a missing stream as a hard parse_failed rather than crashing — this
			// guards against future stdio-config changes that drop the pipe.
			if (!child.stdout) {
				settle({
					ok: false,
					reason: "parse_failed",
					error: "pi child process did not expose stdout (stdio misconfigured)",
					durationMs: Date.now() - startTime,
				});
				return;
			}
			// Same host-crash guard as stderr: an unguarded 'error' on the stdout
			// pipe (child died mid-stream) would rethrow as an unhandled exception.
			// readline does not attach its own error listener to the input stream.
			child.stdout.on("error", () => {});
			const rl = createInterface({
				input: child.stdout,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			// Track event progress so a timeout can report whether the
			// subagent was actively producing output (model hung on a
			// long generation) vs silent (auth/network/spawn problem).
			let eventCount = 0;
			let lastEventType: string | null = null;
			let lastEventTimestamp = 0;

			// Accumulate every assistant message we see. Pi's print mode in
			// JSON output emits `message_end` events for both intermediate
			// (tool-call) and terminal turns, with the final assistant
			// message carrying stopReason="stop" and no toolCall content.
			//
			// Some Pi-compatible print streams omit `agent_end`, so completion
			// cannot depend on receiving it. Accumulate the message_end stream
			// and accept agent_end's complete transcript when available.
			//
			// We detect run completion the same way Pi itself does: watch
			// `message_end` for the final assistant turn (stopReason="stop"
			// + no toolCall content), then drain until natural child exit.
			const accumulatedMessages: unknown[] = [];
			accountingMessages = accumulatedMessages;
			const captureFinalAssistant = (messages: unknown[]) => {
				const result = extractFinalAssistant(messages);
				finalAssistantText = result.text;
				finalStopReason = result.stopReason;
				finalErrorMessage = result.errorMessage;
				const lastAssistant = [...messages]
					.reverse()
					.find(
						(message) =>
							typeof message === "object" &&
							message !== null &&
							(message as { role?: unknown }).role === "assistant",
					);
				// Capturing terminal text starts the drain below. Its SIGTERM can
				// produce empty aborted turns; those are shutdown noise, not a new
				// answer. Keep length-capped text too, so it still reports truncated.
				preserveDrainedResult =
					(result.stopReason === "stop" || result.stopReason === "length") &&
					!!result.text?.trim() &&
					countToolCalls([lastAssistant]) === 0;
				return result;
			};

			rl.on("line", (line) => {
				if (settled || line.length === 0) return;
				const parsed = parsePiEventLine(line);
				if (!parsed.ok) {
					// Non-JSON stdout noise from co-loaded extensions is
					// skipped silently. A malformed JSON event line is
					// recorded but doesn't abort yet, so we can still
					// consume the final message_end if it arrives intact
					// later. If we never see one, this becomes parse_failed.
					if ("noise" in parsed) return;
					parseError = parsed.error;
					return;
				}
				const event = parsed.event;

				if (typeof event !== "object" || event === null) return;
				const e = event as {
					type?: string;
					messages?: unknown;
					message?: unknown;
				};

				if (
					rpcBudget &&
					e.type === "response" &&
					(event as { command?: string; success?: boolean }).success === false
				) {
					const reply = event as { command?: string; error?: string };
					if (
						reply.command === "prompt" ||
						(reply.command === "steer" && !sawAgentEnd)
					) {
						terminateChild(child);
						settle({
							ok: false,
							reason:
								reply.command === "steer" ? "token_budget" : "model_failed",
							error: reply.error ?? `Pi RPC ${reply.command} failed`,
							durationMs: Date.now() - startTime,
						});
						return;
					}
				}
				telemetry.observe(event);
				if (budget && e.type === "message_end") {
					const message = e.message as
						| {
								role?: string;
								stopReason?: string;
								content?: unknown[];
								usage?: {
									input?: number;
									cacheRead?: number;
									cacheWrite?: number;
								};
						  }
						| undefined;
					if (message?.role === "assistant") {
						const usage = message.usage;
						const finished =
							message.stopReason === "stop" &&
							!(
								Array.isArray(message.content) &&
								message.content.some(
									(part) =>
										typeof part === "object" &&
										part !== null &&
										(part as { type?: string }).type === "toolCall",
								)
							);
						let decision = budget.charge(
							usage?.input ?? 0,
							usage?.cacheRead ?? 0,
							usage?.cacheWrite ?? 0,
							finished,
							rpcBudget,
						);
						// Reserve two turns: one for a queued investigation/refusal and
						// one for the manifest. Keep the 60-step runaway ceiling intact.
						if (
							decision === "continue" &&
							!finished &&
							rpcBudget &&
							options.agent.replace(/^magic-context-/, "") ===
								"dreamer-memory-mapper" &&
							cap !== undefined &&
							telemetry.steps >= cap - 2
						) {
							decision = budget.finalize();
						}
						if (
							decision === "stop" ||
							(decision === "finalize" && !rpcBudget)
						) {
							terminateChild(child);
							settle({
								ok: false,
								reason: "token_budget",
								error: "MC-D11: Pi dreamer exceeded its prompt-token budget",
								durationMs: Date.now() - startTime,
								meta: { tokenBudget: budget.snapshot() },
							});
							return;
						}
						if (decision === "finalize" && rpcBudget) {
							try {
								if (!budgetGuardFile)
									throw new Error("missing budget guard file");
								writeFileSync(budgetGuardFile, "finalize", "utf8");
							} catch {
								terminateChild(child);
								settle({
									ok: false,
									reason: "token_budget",
									error: "MC-D11: Pi could not activate its tool guard",
									durationMs: Date.now() - startTime,
								});
								return;
							}
							child.stdin?.write(
								`${JSON.stringify({
									type: "steer",
									message: TOKEN_BUDGET_FINALIZE_MESSAGE,
									id: "dreamer-finalize",
								})}\n`,
							);
						}
					}
				}
				const resultParts = (
					event as { result?: { content?: Array<{ text?: string }> } }
				).result?.content;
				if (
					budget?.snapshot().finalizeFired &&
					e.type === "tool_execution_end" &&
					resultParts?.some((part) => part.text === TOKEN_BUDGET_TOOL_REFUSAL)
				) {
					const refusal = budget.refuseTool();
					if (refusal?.hardStopped) {
						terminateChild(child);
						settle({
							ok: false,
							reason: "token_budget",
							error: "MC-D11: Pi dreamer made two calls after finalize",
							durationMs: Date.now() - startTime,
							meta: { tokenBudget: budget.snapshot() },
						});
						return;
					}
				}
				if (cap !== undefined && telemetry.steps > cap) {
					if (e.type === "message_end") accumulatedMessages.push(e.message);
					if (e.type === "agent_end" && Array.isArray(e.messages))
						accountingMessages = e.messages;
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (drainTimerHandle) clearTimeout(drainTimerHandle);
					terminateChild(child);
					settle({
						ok: false,
						reason: "step_limit",
						error: `MC-D10: Pi subagent ${options.agent} exceeded its ${cap}-step limit`,
						durationMs: Date.now() - startTime,
						meta: { cap, steps: telemetry.steps },
					});
					return;
				}

				const isFirstEvent = eventCount === 0;
				eventCount += 1;
				lastEventTimestamp = Date.now();
				if (typeof e.type === "string") lastEventType = e.type;

				const elapsedMs = Date.now() - startTime;

				if (isFirstEvent && typeof e.type === "string") {
					emitProgress({
						type: "first_event",
						eventType: e.type,
						ms: elapsedMs,
					});
				}

				// Forward the full parsed event so debug callers can write
				// a complete trace to the log. Emitted unconditionally and
				// before any branch-specific handling so even unexpected
				// event types end up in the log.
				emitProgress({
					type: "raw_event",
					eventType: typeof e.type === "string" ? e.type : undefined,
					event,
					ms: elapsedMs,
				});

				// Pi retries a transient provider error (429, 529, 5xx) inside the
				// same child: the failed attempt's message_end and agent_end (with
				// willRetry: true) are followed by auto_retry_start, a backoff of
				// retry.baseDelayMs (2 s by default) and a fresh attempt. The failed
				// turn is not the run's answer, so forget it, stop the drain before
				// it kills the retry, and restore the hard timeout for the time left.
				// The retried attempt's own terminal turn arms the drain again.
				if (
					e.type === "auto_retry_start" ||
					(e.type === "agent_end" &&
						(event as { willRetry?: unknown }).willRetry === true)
				) {
					sawAgentEnd = false;
					preserveDrainedResult = false;
					finalAssistantText = null;
					finalStopReason = null;
					finalErrorMessage = null;
					agentEndMessages = null;
					drainTimerStarted = false;
					if (drainTimerHandle) {
						clearTimeout(drainTimerHandle);
						drainTimerHandle = undefined;
					}
					armHardTimeout();
					return;
				}

				// Accept a complete transcript unless a usable terminal result is
				// already draining. Shutdown events must not replace that result.
				if (
					e.type === "agent_end" &&
					Array.isArray(e.messages) &&
					!preserveDrainedResult
				) {
					sawAgentEnd = true;
					agentEndMessages = e.messages;
					// agent_end is authoritative when a Pi-compatible child emits it;
					// retain its complete assistant-message list so usage is accounted
					// even when no message_end events were printed.
					accountingMessages = e.messages;
					const result = captureFinalAssistant(e.messages);
					emitProgress({
						type: "terminal",
						stopReason: result.stopReason ?? undefined,
						textLength: result.text?.length ?? 0,
						hasToolCall: false,
						ms: elapsedMs,
					});
				}

				// Live path: accumulate every assistant/tool message Pi
				// emits via session.subscribe. The terminal assistant turn
				// is detected by Pi's stopReason vocabulary
				// ("stop" | "length" | "toolUse" | "error" | "aborted")
				// being a non-toolUse value AND no toolCall content in the
				// assistant message body. "length" means the model hit its
				// max-tokens cap mid-response — still terminal, but we
				// surface it as truncated so callers can react.
				if (e.type === "message_end" && e.message) {
					// Every assistant message_end is retained. recordChildInvocation
					// sums message.usage here, matching OpenCode's per-assistant
					// info.tokens accounting rather than using only the final turn.
					accumulatedMessages.push(e.message);
					const m = e.message as {
						role?: string;
						content?: unknown;
						stopReason?: string;
						errorMessage?: string;
					};
					if (m.role === "assistant") {
						const hasToolCall =
							Array.isArray(m.content) &&
							m.content.some(
								(c) =>
									typeof c === "object" &&
									c !== null &&
									(c as { type?: unknown }).type === "toolCall",
							);
						const isTerminalStopReason =
							typeof m.stopReason === "string" &&
							(m.stopReason === "stop" ||
								m.stopReason === "length" ||
								m.stopReason === "error" ||
								m.stopReason === "aborted");
						if (
							isTerminalStopReason &&
							!hasToolCall &&
							!preserveDrainedResult
						) {
							sawAgentEnd = true;
							const result = captureFinalAssistant(accumulatedMessages);
							emitProgress({
								type: "terminal",
								stopReason: m.stopReason,
								textLength: result.text?.length ?? 0,
								hasToolCall: false,
								ms: elapsedMs,
							});
						}
					}
				}

				// Pi's print mode finishes the agent loop but does NOT always
				// exit the child process cleanly afterwards — observed
				// pattern: assistant message_end with stopReason="stop"
				// arrives at ~30s, then the child sits idle until killed.
				// This isn't unique to one provider; it appears to be a
				// generic Pi print-mode shutdown gap.
				//
				// To avoid waiting on the full timeoutMs (typically 5+
				// minutes) every time, start a short drain timer the moment
				// we detect a terminal assistant turn. Give the child 2s
				// grace to flush + exit naturally; if it's still alive,
				// SIGTERM it. This matches the upstream pi-subagents
				// drain-after-stop pattern.
				if (sawAgentEnd && !drainTimerStarted) {
					drainTimerStarted = true;
					if (timeoutHandle) {
						clearTimeout(timeoutHandle);
						timeoutHandle = undefined;
					}
					drainTimerHandle = setTimeout(() => {
						if (settled) return;
						terminateChild(child);
					}, TERMINAL_DRAIN_GRACE_MS);
					if (typeof drainTimerHandle.unref === "function") {
						drainTimerHandle.unref();
					}
				}
			});

			// Hard timeout. We use SIGTERM first so the child can flush
			// stdout cleanly, with SIGKILL as a backstop in case it hangs.
			// The deadline is fixed at spawn: the drain timer replaces it once a
			// terminal turn arrives, and a Pi auto-retry re-arms it for whatever
			// time is left, so a retrying child stays bounded by timeoutMs.
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const hardDeadline =
				typeof options.timeoutMs === "number" && options.timeoutMs > 0
					? Date.now() + options.timeoutMs
					: undefined;
			const onHardTimeout = () => {
				if (settled) return;
				terminateChild(child);
				// Build a diagnostic suffix so callers can tell whether
				// the subagent was hung silent (auth/network/no events)
				// vs actively producing output but slow (model just
				// taking too long). Without this, every timeout looks
				// the same and operators can't distinguish them.
				const sinceLastEvent =
					lastEventTimestamp > 0 ? Date.now() - lastEventTimestamp : -1;
				const progressSuffix =
					eventCount === 0
						? " — no events received from child (silent hang: spawn/auth/network or model never started streaming)"
						: ` — saw ${eventCount} events; last event type=${lastEventType ?? "?"} ${sinceLastEvent}ms before timeout (model was emitting events but no terminal stopReason reached)`;
				settle({
					ok: false,
					reason: "timeout",
					error: `pi subagent timed out after ${options.timeoutMs}ms${progressSuffix}${stderr.length > 0 ? ` | stderr: ${summarizeChildStderr(stderr)}` : ""}`,
					durationMs: Date.now() - startTime,
					meta: {
						stderr: stderr.length > 0 ? stderr : undefined,
						eventCount,
						lastEventType: lastEventType ?? undefined,
						msSinceLastEvent: sinceLastEvent,
					},
				});
			};
			const armHardTimeout = () => {
				if (hardDeadline === undefined || timeoutHandle) return;
				timeoutHandle = setTimeout(
					onHardTimeout,
					Math.max(0, hardDeadline - Date.now()),
				);
			};
			armHardTimeout();

			// Caller-driven abort (e.g. dreamer lease loss).
			const onAbort = () => {
				if (settled) return;
				terminateChild(child);
				settle({
					ok: false,
					reason: "abort",
					error: "pi subagent aborted by caller",
					durationMs: Date.now() - startTime,
				});
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });

			child.on("error", (error) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (drainTimerHandle) clearTimeout(drainTimerHandle);
				options.signal?.removeEventListener("abort", onAbort);
				settle({
					ok: false,
					reason: "spawn_failed",
					error: describeSpawnFailure(error, this.invocation),
					durationMs: Date.now() - startTime,
				});
			});

			let exitGraceHandle: ReturnType<typeof setTimeout> | undefined;
			let childExitHandled = false;
			const finishAfterChildExit = (
				code: number | null,
				signal: NodeJS.Signals | null,
			) => {
				if (childExitHandled) return;
				childExitHandled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (drainTimerHandle) clearTimeout(drainTimerHandle);
				if (exitGraceHandle) clearTimeout(exitGraceHandle);
				options.signal?.removeEventListener("abort", onAbort);
				emitProgress({
					type: "child_exit",
					code,
					signal,
					ms: Date.now() - startTime,
				});
				if (settled) return;

				const settleCompletedToolOnlyDreamer = (
					messages: unknown[],
					completedMemoryCalls: CompletedSubagentToolCall[],
				): boolean => {
					if (
						!DREAMER_ACTION_AGENTS.has(options.agent) ||
						completedMemoryCalls.length === 0
					) {
						return false;
					}
					settle({
						ok: true,
						assistantText: "",
						toolCallCount: countToolCalls(messages),
						completedToolCalls: completedMemoryCalls,
						durationMs: Date.now() - startTime,
						meta: { stderr: stderr.length > 0 ? stderr : undefined },
					});
					return true;
				};

				// Common case: terminal assistant message_end was observed.
				// Pi print-mode often needs our drain SIGTERM after producing
				// the final turn, so the captured stopReason/text is the source
				// of truth; a signaled close here must not turn a valid answer
				// into a fake subprocess failure.
				if (sawAgentEnd) {
					const outputMessages = agentEndMessages ?? accumulatedMessages;
					const completedCalls = extractCompletedToolCalls(outputMessages);
					const completedMemoryCalls = completedCalls.filter(
						(call) => call.name === "ctx_memory",
					);
					const trimmedAssistantText = finalAssistantText?.trim() ?? null;
					if (
						trimmedAssistantText === null ||
						trimmedAssistantText.length === 0
					) {
						if (
							settleCompletedToolOnlyDreamer(
								outputMessages,
								completedMemoryCalls,
							)
						)
							return;
						const emptyAssistantReason =
							trimmedAssistantText === null
								? "pi agent_end did not include an assistant message"
								: "pi assistant produced empty text";
						settle({
							ok: false,
							reason: "no_assistant",
							error: finalErrorMessage
								? `${emptyAssistantReason} (provider error: ${finalErrorMessage})`
								: emptyAssistantReason,
							durationMs: Date.now() - startTime,
							// Pi machinery worked (agent_end / terminal message_end seen);
							// the model just returned empty text. Mark protocol output as
							// present so this legitimate empty response is NOT mistaken for
							// the #238 silent failure and does not fire the isolated retry.
							meta: {
								stderr: stderr.length > 0 ? stderr : undefined,
								sawProtocolOutput: true,
							},
						});
						return;
					}
					if (
						finalStopReason === "error" ||
						finalStopReason === "aborted" ||
						finalStopReason === "length"
					) {
						settle({
							ok: false,
							reason:
								finalStopReason === "length" ? "truncated" : "model_failed",
							error:
								finalErrorMessage ??
								`pi assistant stopped with reason "${finalStopReason}"`,
							durationMs: Date.now() - startTime,
							meta: { stderr: stderr.length > 0 ? stderr : undefined },
						});
						return;
					}
					settle({
						ok: true,
						assistantText: trimmedAssistantText,
						// Prefer agent_end's authoritative full array; else the
						// accumulated message_end stream. Counting toolCall content
						// parts is event-name-independent (see countToolCalls).
						toolCallCount: countToolCalls(outputMessages),
						...(completedMemoryCalls.length > 0
							? { completedToolCalls: completedMemoryCalls }
							: {}),
						durationMs: Date.now() - startTime,
						meta: { stderr: stderr.length > 0 ? stderr : undefined },
					});
					return;
				}

				// No agent_end. Either Pi crashed before completing the
				// turn, or stdout was malformed. Distinguish based on
				// exit code and parseError.
				if (parseError !== null) {
					settle({
						ok: false,
						reason: "parse_failed",
						error: parseError,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							exitCode: code,
							signal,
						},
					});
					return;
				}

				if (code !== 0 || signal !== null) {
					settle({
						ok: false,
						reason: "non_zero_exit",
						error: `pi exited (code=${code}, signal=${signal}) without emitting agent_end. stderr: ${summarizeChildStderr(stderr) || "(empty)"}`,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							exitCode: code,
							signal,
						},
					});
					return;
				}

				const completedMemoryCalls = extractCompletedToolCalls(
					accumulatedMessages,
				).filter((call) => call.name === "ctx_memory");
				if (
					settleCompletedToolOnlyDreamer(
						accumulatedMessages,
						completedMemoryCalls,
					)
				)
					return;

				settle({
					ok: false,
					reason: "no_assistant",
					error: `pi exited successfully without emitting agent_end. stderr: ${summarizeChildStderr(stderr) || "(empty)"}`,
					durationMs: Date.now() - startTime,
					meta: {
						stderr: stderr.length > 0 ? stderr : undefined,
						exitCode: code,
						signal,
						// #238: distinguish the silent failure (zero JSON stdout lines,
						// no agent_end) from a partial run that emitted some events but
						// never completed a turn. Only the zero-output case fires the
						// isolated retry; eventCount counts parsed protocol lines.
						sawProtocolOutput: eventCount > 0,
					},
				});
			};

			child.on("close", finishAfterChildExit);

			// The child has exited but its stdio may still be held open by a
			// process it started. Give the pipes a short grace to deliver what
			// Pi wrote, then stop reading and settle from the exit status.
			child.on("exit", (code, signal) => {
				if (settled || exitGraceHandle) return;
				exitGraceHandle = setTimeout(() => {
					if (settled) return;
					rl.close();
					child.stdout?.destroy();
					child.stderr?.destroy();
					finishAfterChildExit(code, signal);
				}, EXIT_STDIO_GRACE_MS);
				if (typeof exitGraceHandle.unref === "function") {
					exitGraceHandle.unref();
				}
			});
		});
	}
}

function getResultStderr(result: FailedRunResult): string {
	const stderr = result.meta?.stderr;
	return typeof stderr === "string" ? stderr : "";
}

function hasNoExtensionsArg(args: readonly string[]): boolean {
	return args.includes("--no-extensions");
}

function isPiExtensionCollisionFailure(
	result: SubagentRunResult,
): result is FailedRunResult {
	return (
		!result.ok &&
		result.reason === "non_zero_exit" &&
		getResultStderr(result).includes(ALREADY_PROCESSING_PREFIX)
	);
}

/**
 * Issue #238 signature: the child exited 0 but produced NO protocol output
 * (no agent_end and zero JSON stdout lines), so it was classified
 * `no_assistant`. Certain user extension sets make Pi --print silently exit
 * this way. `runOnce` marks this case with `meta.sawProtocolOutput === false`.
 *
 * Deliberately NOT triggered by a legitimate empty model response: when Pi's
 * machinery worked (agent_end / terminal message_end observed) but the model
 * returned empty text, `sawProtocolOutput` is true and the failure is a plain
 * `no_assistant` that should fall through to fallback models, not an isolated
 * retry.
 */
function isSilentNoAssistantFailure(
	result: SubagentRunResult,
): result is FailedRunResult {
	return (
		!result.ok &&
		result.reason === "no_assistant" &&
		result.meta?.sawProtocolOutput === false
	);
}

/**
 * Whether a failed primary attempt should fire the one-shot isolated retry
 * (--no-extensions for discovered user extensions). Covers both the #222
 * extension turn collision and the #238 silent exit-0 signature.
 */
function isIsolatedRetryTrigger(
	result: SubagentRunResult,
): result is FailedRunResult {
	return (
		isPiExtensionCollisionFailure(result) || isSilentNoAssistantFailure(result)
	);
}

/** Pick the accurate log message for whichever trigger fired the isolated retry. */
function isolatedRetryLogMessage(result: FailedRunResult): string {
	return isPiExtensionCollisionFailure(result)
		? ISOLATED_RETRY_COLLISION_LOG_MESSAGE
		: ISOLATED_RETRY_SILENT_LOG_MESSAGE;
}

function isIsolatedRetryModelUnavailable(
	result: SubagentRunResult,
): result is FailedRunResult {
	if (result.ok) return false;
	const diagnosticText = `${result.error}\n${getResultStderr(result)}`;
	return MODEL_RESOLUTION_ERROR_PATTERNS.some((pattern) =>
		pattern.test(diagnosticText),
	);
}

function annotateIsolatedRetryModelUnavailable(
	result: FailedRunResult,
): FailedRunResult {
	if (result.error.startsWith(ISOLATED_RETRY_MODEL_UNAVAILABLE_MESSAGE)) {
		return result;
	}
	return {
		...result,
		error: `${ISOLATED_RETRY_MODEL_UNAVAILABLE_MESSAGE}. Original failure: ${result.error}`,
	};
}

function isFallbackEligible(reason: string): boolean {
	return (
		reason === "model_failed" ||
		reason === "truncated" ||
		reason === "non_zero_exit" ||
		reason === "no_assistant"
	);
}

function providerPrefix(ref: string): string | undefined {
	const slash = ref.indexOf("/");
	return slash > 0 ? ref.slice(0, slash) : undefined;
}

function replaceProviderPrefix(ref: string, provider: string): string {
	const slash = ref.indexOf("/");
	return slash > 0 ? `${provider}${ref.slice(slash)}` : ref;
}

function resolveProviderModelAttempt(
	model: string | undefined,
	targetHarness: PiHarnessKind,
): ProviderModelAttempt | undefined {
	if (typeof model !== "string" || model.length === 0) return undefined;

	const canonicalRef = modelRefToCanonicalForTarget(model, targetHarness);
	const canonicalProvider = providerPrefix(canonicalRef);
	if (!canonicalProvider) return undefined;

	const translatedRef = resolveModelRefForTarget(canonicalRef, targetHarness);
	const translatedProvider = providerPrefix(translatedRef);
	const cachedProvider = PI_PROVIDER_FORM_CACHE.get(canonicalProvider);
	if (
		!translatedProvider ||
		(translatedProvider === canonicalProvider && cachedProvider === undefined)
	) {
		return undefined;
	}

	const attemptedProvider = cachedProvider ?? translatedProvider;
	return {
		canonicalRef,
		canonicalProvider,
		modelRef: replaceProviderPrefix(canonicalRef, attemptedProvider),
		attemptedProvider,
		translated: attemptedProvider !== canonicalProvider,
	};
}

function isProviderCredentialFailure(
	result: SubagentRunResult,
	attempt: ProviderModelAttempt,
): result is FailedRunResult {
	return (
		attempt.translated &&
		!result.ok &&
		result.reason === "non_zero_exit" &&
		getResultStderr(result).includes(
			`No API key found for ${attempt.attemptedProvider}`,
		)
	);
}

/**
 * Max bytes we will pass as the positional message argv argument. Linux caps a
 * SINGLE argv entry at MAX_ARG_STRLEN (128 KiB); a historian chunk clamps to
 * ~50K tokens (~200 KB), which overflows that limit and makes spawn() fail with
 * E2BIG on Linux. Above this threshold the prompt is delivered via piped stdin
 * instead (Pi's print mode concatenates stdin into the initial message — see
 * buildInitialMessage), and the positional arg is omitted to avoid duplication.
 * Set well below 128 KiB for multibyte/encoding headroom.
 */
export const PROMPT_ARGV_MAX_BYTES = 96 * 1024;

/**
 * Build the argv for one `pi --print --mode json` invocation.
 *
 * Argument ordering matters: print mode treats positional args as
 * messages, so the user prompt must come last.
 *
 * When `omitPositionalMessage` is set, the user prompt is NOT appended as a
 * positional — the caller delivers it via piped stdin instead (oversized prompt
 * path, or all win32 runs). Pi concatenates stdin + positional, so the
 * positional MUST be omitted when piping or the prompt would be duplicated.
 */
export function buildArgs(
	options: SubagentRunOptions,
	opts?: {
		targetHarness?: PiHarnessKind;
		disableDiscoveredExtensions?: boolean;
		subagentExtensions?: readonly string[];
		omitPositionalMessage?: boolean;
		subagentEntryPath?: string;
		systemPromptPath?: string;
		modelRef?: string;
		rpc?: boolean;
		historianCalibrationEntryPath?: string | null;
		hostToolNames?: readonly string[];
	},
): string[] {
	const targetHarness = opts?.targetHarness ?? resolvePiHarnessKind();
	const ompTarget = targetHarness === "omp";
	const args: string[] = [
		...(opts?.rpc ? [] : ["--print"]),
		"--mode",
		opts?.rpc ? "rpc" : "json",
		// `--no-session` makes Pi use SessionManager.inMemory() — no
		// JSONL is written to ~/.pi/agent/sessions/<cwd>/, so historian,
		// dreamer, recomp, and compressor child sessions never
		// show up in `pi resume` or the session picker. We don't need
		// the persisted JSONL anyway: the result comes back through the
		// `agent_end` event on stdout (see extractFinalAssistant). Maps
		// directly to OpenCode's "hidden subagent" pattern, which lets
		// historian etc. stay invisible to the user even though they're
		// real LLM rounds the user pays for.
		"--no-session",
		// Extension discovery is enabled by default so provider extensions can
		// register their models. A configured user allowlist adds --no-extensions
		// below and explicitly loads only its entries. Prevent recursive startup by
		// setting MAGIC_CONTEXT_PI_SUBAGENT=1 in the child environment, which makes
		// the main entry exit early before registering hooks, tools, or timers.
		// Disable skills and the project context surface because subagents only
		// need the minimal startup path.
		"--no-skills",
		// OMP rejects Pi's --no-prompt-templates and --no-context-files flags.
		// It folds AGENTS.md-style context into rules, so --no-rules is the
		// equivalent way to preserve the exact child system prompt.
		...(ompTarget
			? (["--no-rules"] as const)
			: (["--no-prompt-templates", "--no-context-files"] as const)),
		// --no-tools is applied below for unknown, explicitly zero-tool, or fully
		// filtered allow-lists.
		// Every known Magic Context child gets an explicit --tools allow-list so Pi's
		// discovered extension registry cannot leak unrelated tools into subagents.
	];
	if (
		opts?.disableDiscoveredExtensions ||
		opts?.subagentExtensions !== undefined
	) {
		// When an allowlist is active, or when the collision retry asks for an
		// isolated child, disable auto-discovered extensions. Explicit entries are
		// added below in their configured order.
		args.push("--no-extensions");
	}

	if (opts?.subagentExtensions !== undefined) {
		for (const extension of opts.subagentExtensions) {
			args.push(
				"--extension",
				resolveSubagentExtensionEntry(extension, targetHarness),
			);
		}
	}

	// Load Magic Context's lean subagent extension entry in children that need the
	// scoped ctx_* tools. With no allowlist, discovered extensions remain enabled
	// so provider and other auto-discovered extensions can register, while the full Magic Context entry sees
	// MAGIC_CONTEXT_PI_SUBAGENT=1 and returns before wiring recursive hooks. The
	// lean entry is explicitly loaded via --extension and is NOT guarded; it only
	// registers subagent-scoped tools and never historian/dreamer/event handlers.
	// When the bundle isn't present (e.g. running source from src/ without a build),
	// skip the flag — the affected subagent simply lacks Magic Context ctx_* tools.
	//
	// We use the long form `--extension` (not the `-e` short form) to
	// avoid clashes with extension-registered flags. Older Pi versions
	// also exposed `-x`, but that alias was removed in 0.71+ — newer
	// versions hard-fail with "Unknown option: -x".
	// Do not load the lean Magic Context extension for historian/compressor style
	// subagents. They do not use ctx_* tools, and loading the entry would add
	// startup cost and an avoidable tool-registration surface. Tool-using agents
	// Dreamer tool users still receive the lean entry.
	const subagentEntryPath = opts?.subagentEntryPath ?? SUBAGENT_ENTRY_PATH;
	const shouldLoadSubagentExtension =
		subagentEntryPath &&
		(opts?.rpc ||
			SEARCH_ONLY_SUBAGENT_TOOL_AGENTS.has(options.agent) ||
			DREAMER_ACTION_AGENTS.has(options.agent));
	if (shouldLoadSubagentExtension) {
		args.push("--extension", subagentEntryPath);

		// Only dreamer subagents get ctx_memory in the child extension. The flag is
		// read inside the subagent extension via `pi.getFlag(...)`.
		if (DREAMER_ACTION_AGENTS.has(options.agent)) {
			args.push("--magic-context-dreamer-actions");
		}
	}

	const historianCalibrationEntryPath =
		opts?.historianCalibrationEntryPath === undefined
			? HISTORIAN_CALIBRATION_ENTRY_PATH
			: opts.historianCalibrationEntryPath;
	if (
		subagentStepCap(options.agent) !== undefined &&
		historianCalibrationEntryPath
	) {
		args.push("--extension", historianCalibrationEntryPath);
	}

	// Every child receives an explicit built-in tool gate. Pi applies this as
	// hard registry isolation. OMP validates only built-in names and always
	// appends discovered extension tools, so its gate is a built-in budget only.
	const strictTools = STRICT_TOOL_ALLOWLIST.get(options.agent);
	if (strictTools === undefined) {
		sessionLog(
			options.accountingSessionId ?? "pi-subagent",
			`Pi subagent agent "${options.agent}" has no strict tool allow-list; forcing --no-tools`,
		);
		args.push("--no-tools");
	} else {
		// Only OMP refuses a child whose --tools names a built-in it has disabled.
		// Pi accepts the list, and its registry also reflects the parent session's
		// own --tools restriction, so filtering there would only take tools away.
		const resolution = resolveHostToolAllowlistDetails(
			strictTools,
			ompTarget,
			ompTarget ? opts?.hostToolNames : undefined,
		);
		const hostTools = resolution.tools;
		for (const tool of resolution.dropped) {
			const warningKey = `${options.agent}\u0000${tool}`;
			if (loggedUnavailableBuiltinTools.has(warningKey)) continue;
			loggedUnavailableBuiltinTools.add(warningKey);
			const degradation =
				tool === "read"
					? "This source-inspection task cannot read local files without read."
					: hostTools.includes("read")
						? `The agent can still read files with read, but its ${tool} search capability is unavailable.`
						: "The agent has no remaining built-in file-reading capability for this task.";
			sessionLog(
				options.accountingSessionId ?? "pi-subagent",
				`Pi subagent "${options.agent}" is dropping unavailable built-in "${tool}". ${degradation}`,
			);
		}
		if (hostTools.length > 0) {
			args.push("--tools", hostTools.join(","));
		} else {
			args.push("--no-tools");
		}
	}

	if (opts?.systemPromptPath) {
		// We intentionally use --system-prompt (replace) rather than
		// --append-system-prompt (chain) because subagents are one-shot
		// and have their own focused system prompt. Mixing in Pi's
		// default coding-assistant prompt would dilute the historian
		// / dreamer role guidance. The runner always writes that
		// prompt to a temp file and passes the ABSOLUTE path here because
		// Windows CreateProcess caps the whole command line at 32,767 chars
		// and the historian prompt alone is ~60 KB. A temp file also avoids
		// Pi's existsSync ambiguity because we always hand it a path we created.
		args.push("--system-prompt", opts.systemPromptPath);
	}

	if (typeof options.model === "string" && options.model.length > 0) {
		// Pi's --models flag scopes the model picker list; it is not an ordered
		// fallback chain. The runner implements fallback by spawning a fresh child
		// per model, so each invocation receives exactly one --model.
		//
		// The shared config stores the canonical (OpenCode) provider form; Pi
		// names a few auth-plugin providers differently (openai->openai-codex,
		// google->google-antigravity). Translate to Pi's form HERE, at the only
		// point the model reaches the spawned process, so options.model stays
		// canonical everywhere else (accounting, logging, fallback selection).
		args.push(
			"--model",
			opts?.modelRef ?? resolveModelRefForTarget(options.model, targetHarness),
		);
	}

	// Pass --thinking <level> only when explicitly configured.
	// Without an explicit level, Pi's own resolution runs (works for most
	// providers; may fail for e.g. github-copilot/gpt-5.4 which injects
	// "minimal" as a default that its own API then rejects). Users who hit
	// this must set `historian.thinking_level` in their Pi magic-context.jsonc.
	if (options.thinkingLevel) {
		args.push("--thinking", options.thinkingLevel);
	}

	// Positional message argument MUST come last in print-mode argv.
	// Pi 0.7x parses print-mode prompts after all known flags without needing
	// a `--` sentinel; newer builds hard-fail on that sentinel as an unknown
	// option, so pass the prompt directly.
	//
	// Omitted whenever the caller pipes the message via stdin (oversized prompt
	// path, or all win32 runs). Pi concatenates stdin + positional, so including
	// both would duplicate it.
	if (!opts?.omitPositionalMessage) {
		args.push(options.userMessage);
	}

	return args;
}

/**
 * Extract the final assistant message's text + status from a Pi `agent_end`
 * messages array.
 *
 * Pi's AgentMessage shape (from @earendil-works/pi-ai):
 *   {
 *     role: "user" | "assistant" | "toolResult",
 *     content: Array<{ type: "text" | "toolCall" | "toolResult", ... }>,
 *     stopReason?: "stop" | "error" | "aborted" | ...,
 *     errorMessage?: string,
 *     ...
 *   }
 *
 * The "final assistant message" is the last element of the array with
 * role === "assistant". Its text content is the concatenation of every
 * `{ type: "text", text }` block in `content`.
 */
export function extractFinalAssistant(messages: unknown[]): {
	text: string | null;
	stopReason: string | null;
	errorMessage: string | null;
} {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (typeof msg !== "object" || msg === null) continue;
		const m = msg as {
			role?: string;
			content?: unknown;
			stopReason?: string;
			errorMessage?: string;
		};
		if (m.role !== "assistant") continue;

		const text = Array.isArray(m.content)
			? m.content
					.filter((c): c is { type: string; text: string } => {
						if (typeof c !== "object" || c === null) return false;
						const cc = c as { type?: unknown; text?: unknown };
						return cc.type === "text" && typeof cc.text === "string";
					})
					.map((c) => c.text)
					.join("")
			: "";

		return {
			text,
			stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
			errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : null,
		};
	}
	return { text: null, stopReason: null, errorMessage: null };
}

/** Pair assistant invocations with non-error tool-result messages from Pi's transcript. */
export function extractCompletedToolCalls(
	messages: unknown[],
): CompletedSubagentToolCall[] {
	const invocations = new Map<
		string,
		{ name: string; arguments: Record<string, unknown> }
	>();
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const candidate = message as { role?: unknown; content?: unknown };
		if (candidate.role !== "assistant" || !Array.isArray(candidate.content))
			continue;
		for (const part of candidate.content) {
			if (typeof part !== "object" || part === null) continue;
			const call = part as {
				type?: unknown;
				id?: unknown;
				toolCallId?: unknown;
				name?: unknown;
				toolName?: unknown;
				arguments?: unknown;
			};
			if (call.type !== "toolCall") continue;
			const id = typeof call.id === "string" ? call.id : call.toolCallId;
			const name = typeof call.name === "string" ? call.name : call.toolName;
			if (typeof id !== "string" || typeof name !== "string") continue;
			const args =
				typeof call.arguments === "object" &&
				call.arguments !== null &&
				!Array.isArray(call.arguments)
					? (call.arguments as Record<string, unknown>)
					: {};
			invocations.set(id, { name, arguments: args });
		}
	}

	const completed: CompletedSubagentToolCall[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const result = message as {
			role?: unknown;
			toolCallId?: unknown;
			toolName?: unknown;
			isError?: unknown;
		};
		if (
			result.role !== "toolResult" ||
			typeof result.toolCallId !== "string" ||
			result.isError !== false ||
			seen.has(result.toolCallId)
		) {
			continue;
		}
		const invocation = invocations.get(result.toolCallId);
		if (!invocation) continue;
		if (
			typeof result.toolName === "string" &&
			result.toolName !== invocation.name
		)
			continue;
		seen.add(result.toolCallId);
		completed.push(invocation);
	}
	return completed;
}

/**
 * Count tool invocations across a run from the assistant messages themselves —
 * each `toolCall` content part is one invocation. We derive the count from
 * message CONTENT (which `message_end` always carries, and `agent_end` carries
 * in its final array) rather than a discrete tool-completion EVENT, because
 * Pi's --print stdout vocabulary is message_start / message_end /
 * tool_execution_* (no `tool_result_end`), so keying on an event name is
 * fragile. The grounding gate only needs "did the agent call tools at all"
 * (count > 0), so counting requested toolCall parts is the robust signal.
 */
export function countToolCalls(messages: unknown[]): number {
	let count = 0;
	for (const msg of messages) {
		if (typeof msg !== "object" || msg === null) continue;
		const m = msg as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const part of m.content) {
			if (
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "toolCall"
			) {
				count += 1;
			}
		}
	}
	return count;
}

export function parsePiEventLine(
	line: string,
):
	| { ok: true; event: unknown }
	| { ok: false; error: string }
	| { ok: false; noise: true } {
	// Pi's --print JSON event stream emits one JSON OBJECT per line. Since
	// subagent children load the user's full extension set (v0.30.4 dropped
	// --no-extensions), any co-loaded extension that writes plain text to
	// stdout (e.g. "[Worker] Ready") interleaves with the event stream.
	// Such lines are noise to skip, not protocol corruption — only a line
	// that CLAIMS to be an event (starts with "{") but fails to parse is a
	// real error worth recording.
	if (!line.trimStart().startsWith("{")) {
		return { ok: false, noise: true };
	}
	try {
		return { ok: true, event: JSON.parse(line) };
	} catch (error) {
		return {
			ok: false,
			error: `failed to parse event: ${error instanceof Error ? error.message : String(error)} | line=${line.slice(0, 200)}`,
		};
	}
}

function terminateChild(child: ReturnType<typeof childProcess.spawn>) {
	let exited = false;
	child.once("close", () => {
		exited = true;
	});
	child.once("exit", () => {
		exited = true;
	});
	child.kill("SIGTERM");
	const killHandle = setTimeout(() => {
		if (!exited && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}, 2000);
	if (typeof killHandle.unref === "function") {
		killHandle.unref();
	}
}

export const __test = {
	buildArgs,
	extractFinalAssistant,
	isGenericRuntimeExecutable,
	isPiCliScript,
	parsePiEventLine,
	resolvePiInvocation,
	resolveWindowsPiCommand,
	terminateChild,
	DREAMER_ACTION_AGENTS,
	KNOWN_PI_SUBAGENT_AGENTS,
	resolveHostToolAllowlist,
	STRICT_TOOL_ALLOWLIST,
	ZERO_TOOL_PROMPT_REQUIRED_AGENTS,
	resetProviderFormCache: () => PI_PROVIDER_FORM_CACHE.clear(),
	resetHostToolState: () => {
		configuredHostToolNames = undefined;
		loggedUnavailableBuiltinTools.clear();
	},
};
