import * as childProcess from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
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
} from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
import type {
	SubagentProgressEvent,
	SubagentRunner,
	SubagentRunOptions,
	SubagentRunResult,
} from "@magic-context/core/shared/subagent-runner";

/**
 * Resolve the Pi CLI entry that should be spawned for historian/dreamer/
 * sidekick subagents.
 *
 * Why this isn't just "pi": when the Pi plugin runs inside an interactive
 * `pi` session, that user has the `pi` binary on PATH and `spawn("pi", ...)`
 * works. But in other deployment shapes the plugin runs without that:
 *   - CI runners and e2e harnesses: Pi is installed only into node_modules
 *     via `bun install` / `npm install`. No `pi` symlink on PATH.
 *   - npm-only user installs: same shape — `@earendil-works/pi-coding-agent`
 *     is in node_modules but its bin entry isn't globally linked.
 *   - Any environment where the user uses `npx` rather than the
 *     globally-installed Pi CLI.
 *
 * Strategy: try to resolve `@earendil-works/pi-coding-agent`'s package.json
 * via Node's `require.resolve` rooted at this module, then spawn the
 * package's `dist/cli.js` directly. Pi's CLI ships with `#!/usr/bin/env node`
 * and npm sets the exec bit during install, so the OS spawns it under Node
 * with no extra runtime needed. Fall back to plain `pi` on PATH so the
 * happy path for interactive Pi users is unchanged.
 *
 * Returns null when resolution fails — caller falls back to "pi" on PATH.
 */
function resolveBundledPiCli(): string | null {
	try {
		const require_ = createRequire(import.meta.url);
		const pkgJson = require_.resolve(
			"@earendil-works/pi-coding-agent/package.json",
		);
		const cliPath = join(dirname(pkgJson), "dist/cli.js");
		if (existsSync(cliPath)) return cliPath;
		return null;
	} catch {
		return null;
	}
}

/** How to spawn a Pi child: the binary plus any fixed leading args. Always
 *  spawned without a shell (see {@link resolvePiInvocation}). */
interface PiInvocation {
	command: string;
	prefixArgs: string[];
}

/**
 * Resolve how to spawn a Pi subagent, robust across POSIX and Windows.
 *
 * The key fix (#177): never depend on a bare `pi` on PATH or on a POSIX
 * shebang. On Windows a global npm install puts `pi.cmd` / `pi.ps1` on PATH (not
 * a literal `pi`), and Node's `spawn("pi")` without a shell looks for a file
 * named exactly `pi`, so it ENOENTs; and Windows ignores the `#!/usr/bin/env
 * node` shebang entirely, so spawning `dist/cli.js` "directly" only works on
 * POSIX. When the host itself is Pi, the reliable, cross-platform approach is
 * to re-invoke the EXACT host CLI the user is already running:
 * `process.execPath` (the node/bun binary) plus `process.argv[1]` (the absolute
 * path to the running `cli.js`). That sidesteps shim resolution completely and
 * pins the child to the same Pi version/runtime. Embedded hosts such as pi-web
 * must not reuse their unrelated `argv[1]`.
 *
 * Mirrors Pi's own `getPiInvocation` reference. MUST be evaluated in the host
 * process: a Pi host has its `cli.js` in `argv[1]`; embedded hosts fall through
 * to bundled-Pi or PATH resolution.
 *
 * Resolution order:
 *   1. argv[1] belongs to an on-disk Pi package (and is not a bun-compiled
 *      `/$bunfs/root/` virtual path) -> `execPath cli.js ...`.
 *   2. execPath is a packaged binary (basename not node/bun) -> `execPath ...`
 *      (the compiled binary IS pi; no script arg).
 *   3. A bundled `@earendil-works/pi-coding-agent/dist/cli.js` resolves ->
 *      `execPath cli.js ...` (node + resolved cli.js).
 *   4. Last resort: bare `pi` on PATH.
 *
 * Everything is spawned WITHOUT a shell. The primary path (execPath + argv[1])
 * covers every real Pi CLI runtime; embedded hosts fall through rather than
 * accidentally re-running themselves. We do
 * NOT fall back to a shell for it (which on Windows would resolve the .cmd shim
 * but pass the prompt/task text through cmd.exe, exposing arg-escaping and
 * injection), and we don't pull in cross-spawn just for a dead path.
 */
function isPiCliScript(scriptPath: string): boolean {
	const normalized = scriptPath.replaceAll("\\", "/");
	return /\/@(?:earendil-works|oh-my-pi)\/pi-coding-agent\/dist\/cli\.js$/.test(
		normalized,
	);
}

function isGenericRuntimeExecutable(execPath: string): boolean {
	return /^(node(?:js)?\d*|bun)(\.exe)?$/.test(
		basename(execPath).toLowerCase(),
	);
}

function resolvePiInvocation(): PiInvocation {
	const execPath = process.execPath;
	const currentScript = process.argv[1];
	const isBunVirtualScript =
		currentScript?.startsWith("/$bunfs/root/") ?? false;

	if (
		currentScript &&
		!isBunVirtualScript &&
		existsSync(currentScript) &&
		isPiCliScript(currentScript)
	) {
		return { command: execPath, prefixArgs: [currentScript] };
	}

	if (!isGenericRuntimeExecutable(execPath)) {
		// A packaged single-file binary: execPath itself is pi.
		return { command: execPath, prefixArgs: [] };
	}

	const bundled = resolveBundledPiCli();
	if (bundled) {
		return { command: execPath, prefixArgs: [bundled] };
	}

	return { command: "pi", prefixArgs: [] };
}

/**
 * Resolve the path to the lean subagent extension entry that gets loaded
 * inside spawned Pi child processes. The bundle ships at
 * `dist/subagent-entry.js` next to `dist/index.js` (this module). We use
 * `import.meta.url` so the path resolves correctly regardless of where
 * the npm package is installed (or where it's symlinked from in dev).
 *
 * Falls back to undefined if the file isn't found at the expected
 * location — caller should treat that as a soft signal to skip the
 * `-x` flag (subagent will run without Magic Context tools, which is
 * acceptable for ctx_*-using agents in dev/test before the bundle exists).
 */
function resolveSubagentEntryPath(): string | undefined {
	try {
		// Resolve from the current module's directory. In dev (running
		// .ts via Bun) and in prod (running .js from dist/), this lands
		// in the same directory as the runner itself.
		const here = dirname(fileURLToPath(import.meta.url));
		const candidate = resolvePath(here, "subagent-entry.js");
		if (existsSync(candidate)) return candidate;

		// Dev fallback: when running source from packages/pi-plugin/src/
		// the .js bundle doesn't exist yet; skip the --extension flag so
		// tests running pre-build don't fail. Production builds always
		// have the bundle.
		return undefined;
	} catch {
		return undefined;
	}
}

const SUBAGENT_ENTRY_PATH = resolveSubagentEntryPath();

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

export const MAGIC_CONTEXT_PI_SUBAGENT_ENV = "MAGIC_CONTEXT_PI_SUBAGENT";

function packageRootIsOmp(packageRoot: string): boolean {
	try {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf-8"),
		) as { name?: unknown };
		return manifest.name === "@oh-my-pi/pi-coding-agent";
	} catch {
		return false;
	}
}

function expandHomePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return resolvePath(homedir(), value.slice(2));
	}
	return resolvePath(value);
}

/**
 * Positive OMP host identification. PI_CODING_AGENT_DIR alone is deliberately
 * insufficient because upstream Pi supports the same variable.
 */
function isOmpHostProcess(): boolean {
	const execName = basename(process.execPath).toLowerCase();
	if (/^omp(?:\.exe)?$/.test(execName)) return true;

	const packageOverride = process.env.PI_PACKAGE_DIR?.trim();
	if (packageOverride && packageRootIsOmp(expandHomePath(packageOverride))) {
		return true;
	}

	let current = process.argv[1] ? dirname(resolvePath(process.argv[1])) : "";
	while (current) {
		if (packageRootIsOmp(current)) return true;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
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
// variable, so never consume it without positive OMP host identification.
function getHostAgentSettingsDir(): string {
	if (!isOmpHostProcess()) return join(homedir(), ".pi", "agent");
	const configRoot = join(
		homedir(),
		process.env.PI_CONFIG_DIR?.trim() || ".omp",
	);
	const profile = normalizedOmpProfile();
	if (profile) return join(configRoot, "profiles", profile, "agent");
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured ? resolvePath(configured) : join(configRoot, "agent");
}

function modelRefToCanonicalForHost(ref: string): string {
	return isOmpHostProcess()
		? ompModelRefToCanonical(ref)
		: piModelRefToCanonical(ref);
}

function resolveModelRefForHost(ref: string): string {
	return isOmpHostProcess()
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

function resolveSubagentExtensionEntry(entry: string): string {
	const trimmed = entry.trim();
	const isNpmSource = trimmed.startsWith("npm:");
	return !isNpmSource && !isAbsolute(trimmed)
		? resolvePath(getHostAgentSettingsDir(), trimmed)
		: trimmed;
}

const PI_READ_ONLY_BUILTINS = ["read", "grep", "find", "ls"] as const;
const PI_AFT_READ_TOOLS = ["aft_outline", "aft_zoom", "aft_search"] as const;
const PI_HISTORIAN_TOOLS = [...PI_READ_ONLY_BUILTINS, "aft_search"] as const;

/**
 * Set of subagent agent ids that get ctx_memory in the lean child extension.
 * Sidekick is retrieval-only and uses ctx_search; only dreamer-equivalent
 * agents need memory mutation/list capabilities.
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
	"sidekick",
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
	// Pi's live historian runner uses this Magic Context-specific id for first
	// pass, repair, two-pass editor, recomp, and memory-migration prompts. It
	// summarizes/offloads host-rendered input and may inspect local files, but it
	// must not mutate source or memory. Keep only read-only Pi built-ins plus
	// aft_search (no aft_outline/aft_zoom, no ctx_* tools).
	["magic-context-historian", PI_HISTORIAN_TOOLS],
	// Shared OpenCode agent ids that can be passed by tests or future Pi callers.
	// Same historian surface as magic-context-historian: local read/search only,
	// optional aft_search, never writes or ctx_* tools.
	["historian", PI_HISTORIAN_TOOLS],
	["historian-recomp", PI_HISTORIAN_TOOLS],
	["historian-editor", PI_HISTORIAN_TOOLS],
	// Sidekick augments the user's prompt by retrieving memory. It needs the lean
	// ctx_search registration plus Pi's read-only built-ins for safe local context,
	// but no write/bash/ctx_memory surface.
	["sidekick", [...PI_READ_ONLY_BUILTINS, "ctx_search"]],
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
	// maintain-docs: explores the codebase and writes ARCHITECTURE.md/STRUCTURE.md.
	// All 7 Pi built-ins (read/grep/find/ls + bash/write/edit; git runs via bash),
	// plus optional AFT read navigation. Deliberately NO ctx_memory/ctx_search — it
	// edits docs, never the memory store. Not in any *_SUBAGENT_TOOL_AGENTS set, so
	// the lean extension is never loaded and ctx_memory cannot leak in.
	[
		"dreamer-docs",
		[...PI_READ_ONLY_BUILTINS, "bash", "write", "edit", ...PI_AFT_READ_TOOLS],
	],
	// curate (base `dreamer`): memory-pool hygiene via ctx_memory ONLY. It is in
	// DREAMER_ACTION_AGENTS so the lean extension registers ctx_memory; this
	// allow-list then strips ALL 7 built-ins, leaving only the extension-provided
	// ctx_memory (curate never reads code — a separate verify task owns that).
	["dreamer", ["ctx_memory"]],
	// Pi dreamer facade default when body.agent is absent (`dreamer/index.ts`).
	// Same ctx_memory-only lock as `dreamer`; must stay in sync with
	// DREAMER_ACTION_AGENTS (every member needs a strict entry).
	["magic-context-dreamer", ["ctx_memory"]],
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
 * addressed by this flag, and deduplicate aliases.
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
): readonly string[] {
	if (!ompHost) return tools;
	const resolved: string[] = [];
	const seen = new Set<string>();
	for (const tool of tools) {
		const mapped = OMP_TOOL_ALIASES[tool] ?? tool;
		if (OMP_ALLOWLISTABLE_TOOLS[mapped] !== true || seen.has(mapped)) continue;
		seen.add(mapped);
		resolved.push(mapped);
	}
	return resolved;
}

const KNOWN_PI_SUBAGENT_AGENTS = [
	"magic-context-historian",
	"historian",
	"historian-recomp",
	"historian-editor",
	"sidekick",
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
	if (agent.includes("sidekick")) return "sidekick";
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
 *   sidekick/historian/dreamer ever needs token accounting, we'll add
 *   a `usage` field to `SubagentRunResult.meta` rather than changing
 *   the core contract.
 */
export class PiSubagentRunner implements SubagentRunner {
	readonly harness = "pi";

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

	constructor(
		options: {
			piBinary?: string;
			platform?: NodeJS.Platform;
			extraArgs?: readonly string[];
			/** User-tier explicit extension allowlist; an empty list disables all discovered extensions. */
			subagentExtensions?: readonly string[];
			/** Test seam for subprocess lifecycle tests. Production uses child_process.spawn. */
			spawnImpl?: typeof childProcess.spawn;
		} = {},
	) {
		this.invocation = options.piBinary
			? { command: options.piBinary, prefixArgs: [] }
			: resolvePiInvocation();
		this.spawnImpl = options.spawnImpl ?? childProcess.spawn;
		this.platform = options.platform ?? process.platform;
		this.extraArgs = options.extraArgs ?? [];
		this.subagentExtensions =
			options.subagentExtensions ?? configuredSubagentExtensions;
	}

	async run(options: SubagentRunOptions): Promise<SubagentRunResult> {
		const providerAttempt = resolveProviderModelAttempt(options.model);
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

	private async runOnce(
		options: SubagentRunOptions,
		runMode: PiRunMode,
		modelRefOverride?: string,
	): Promise<SubagentRunResult> {
		const startTime = Date.now();
		let recordedAccounting = false;
		const recordAccounting = (
			result: SubagentRunResult,
			messages: unknown[] = [],
		) => {
			if (!options.accountingSessionId || recordedAccounting) return;
			recordedAccounting = true;
			recordChildInvocation({
				db: openDatabase(),
				parentSessionId: options.accountingSessionId,
				harness: "pi",
				subagent:
					options.accountingSubagent ?? inferAccountingSubagent(options.agent),
				task: options.accountingTask ?? null,
				startedAt: startTime,
				status: result.ok
					? "completed"
					: result.reason === "abort"
						? "aborted"
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
		const deliverViaStdin =
			promptBytes > PROMPT_ARGV_MAX_BYTES || this.platform === "win32";
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
		const args = buildArgs(options, {
			disableDiscoveredExtensions: runMode.disableDiscoveredExtensions,
			subagentExtensions: this.subagentExtensions,
			omitPositionalMessage: deliverViaStdin,
			systemPromptPath,
			modelRef: modelRefOverride,
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
				cleanupSystemPromptFile();
				// recordAccounting must never block resolution: a throw here (e.g.
				// a DB write failure during token accounting) would leave the
				// promise unresolved and hang the caller (historian/dreamer/
				// sidekick). Accounting is best-effort telemetry; resolve regardless.
				try {
					recordAccounting(result, accountingMessages);
				} catch (err) {
					sessionLog(
						options.accountingSessionId ?? "subagent",
						`subagent accounting failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				resolve(result);
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
						cwd: options.cwd,
						// Merge over the parent env so PATH/HOME/auth variables flow
						// through for provider extensions. The guard only disables Magic
						// Context's full entry; it must not replace the process env.
						env: {
							...process.env,
							[MAGIC_CONTEXT_PI_SUBAGENT_ENV]: "1",
						},
						// stdout = JSON events; stderr = diagnostics. stdin is a pipe
						// when we deliver the user message there (always on Windows, or
						// for oversized prompts elsewhere). Otherwise it stays closed
						// because the message rides in argv and print-mode would block
						// reading an open, idle stdin.
						stdio: [deliverViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
					},
				);
			} catch (error) {
				cleanupSystemPromptFile();
				settle({
					ok: false,
					reason: "spawn_failed",
					error: error instanceof Error ? error.message : String(error),
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
			if (deliverViaStdin && child.stdin) {
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
			child.stderr?.on("data", (chunk: Buffer) => {
				const text = chunk.toString("utf8");
				stderr += text;
				// Cap to prevent unbounded growth on chatty failures.
				if (stderr.length > 16_000) {
					stderr = `${stderr.slice(0, 16_000)}…[truncated]`;
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
			// Why we accumulate instead of waiting for `agent_end`:
			// Pi's print mode does NOT emit an `agent_end` event on stdout.
			// That event exists in Pi's internal extension event channel
			// only — the stdout JSON stream comes from `session.subscribe`,
			// which receives only `message_start`/`message_end`/
			// `tool_execution_*`/`compaction_*`/`session_info_changed`/
			// `thinking_level_changed`/`queue_update`/`auto_retry_end`.
			//
			// We detect run completion the same way Pi itself does: watch
			// `message_end` for the final assistant turn (stopReason="stop"
			// + no toolCall content), then drain until natural child exit.
			const accumulatedMessages: unknown[] = [];
			accountingMessages = accumulatedMessages;

			rl.on("line", (line) => {
				if (line.length === 0) return;
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

				// Backwards-compat: if Pi (or any pi-compatible runner) ever
				// does emit `agent_end` with the full messages array, treat
				// it as authoritative. Older Pi versions may have done this.
				if (e.type === "agent_end" && Array.isArray(e.messages)) {
					sawAgentEnd = true;
					agentEndMessages = e.messages;
					const result = extractFinalAssistant(e.messages);
					finalAssistantText = result.text;
					finalStopReason = result.stopReason;
					finalErrorMessage = result.errorMessage;
					emitProgress({
						type: "terminal",
						stopReason: result.stopReason ?? undefined,
						textLength: result.text?.length ?? 0,
						hasToolCall: false,
						ms: elapsedMs,
					});
					return;
				}

				// Live path: accumulate every assistant/tool message Pi
				// emits via session.subscribe. The terminal assistant turn
				// is detected by Pi's stopReason vocabulary
				// ("stop" | "length" | "toolUse" | "error" | "aborted")
				// being a non-toolUse value AND no toolCall content in the
				// assistant message body. "length" means the model hit its
				// max-tokens cap mid-response — still terminal, but we
				// surface it as model_failed so callers can react.
				if (e.type === "message_end" && e.message) {
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
						if (isTerminalStopReason && !hasToolCall) {
							sawAgentEnd = true;
							const result = extractFinalAssistant(accumulatedMessages);
							finalAssistantText = result.text;
							finalStopReason = result.stopReason;
							finalErrorMessage = result.errorMessage;
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
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
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
						error: `pi subagent timed out after ${options.timeoutMs}ms${progressSuffix}${stderr.length > 0 ? ` | stderr: ${stderr.slice(0, 500)}` : ""}`,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							eventCount,
							lastEventType: lastEventType ?? undefined,
							msSinceLastEvent: sinceLastEvent,
						},
					});
				}, options.timeoutMs);
			}

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
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - startTime,
				});
			});

			child.on("close", (code, signal) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (drainTimerHandle) clearTimeout(drainTimerHandle);
				options.signal?.removeEventListener("abort", onAbort);
				emitProgress({
					type: "child_exit",
					code,
					signal,
					ms: Date.now() - startTime,
				});
				if (settled) return;

				// Common case: terminal assistant message_end was observed.
				// Pi print-mode often needs our drain SIGTERM after producing
				// the final turn, so the captured stopReason/text is the source
				// of truth; a signaled close here must not turn a valid answer
				// into a fake subprocess failure.
				if (sawAgentEnd) {
					const trimmedAssistantText = finalAssistantText?.trim() ?? null;
					if (
						trimmedAssistantText === null ||
						trimmedAssistantText.length === 0
					) {
						settle({
							ok: false,
							reason: "no_assistant",
							error:
								trimmedAssistantText === null
									? "pi agent_end did not include an assistant message"
									: "pi assistant produced empty text",
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
						toolCallCount: countToolCalls(
							agentEndMessages ?? accumulatedMessages,
						),
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
						error: `pi exited (code=${code}, signal=${signal}) without emitting agent_end. stderr: ${stderr.slice(0, 500) || "(empty)"}`,
						durationMs: Date.now() - startTime,
						meta: {
							stderr: stderr.length > 0 ? stderr : undefined,
							exitCode: code,
							signal,
						},
					});
					return;
				}

				settle({
					ok: false,
					reason: "no_assistant",
					error: `pi exited successfully without emitting agent_end. stderr: ${stderr.slice(0, 500) || "(empty)"}`,
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
): ProviderModelAttempt | undefined {
	if (typeof model !== "string" || model.length === 0) return undefined;

	const canonicalRef = modelRefToCanonicalForHost(model);
	const canonicalProvider = providerPrefix(canonicalRef);
	if (!canonicalProvider) return undefined;

	const translatedRef = resolveModelRefForHost(canonicalRef);
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
		disableDiscoveredExtensions?: boolean;
		subagentExtensions?: readonly string[];
		omitPositionalMessage?: boolean;
		subagentEntryPath?: string;
		systemPromptPath?: string;
		modelRef?: string;
	},
): string[] {
	const ompHost = isOmpHostProcess();
	const args: string[] = [
		"--print",
		"--mode",
		"json",
		// `--no-session` makes Pi use SessionManager.inMemory() — no
		// JSONL is written to ~/.pi/agent/sessions/<cwd>/, so historian /
		// sidekick / dreamer / recomp / compressor child sessions never
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
		...(ompHost
			? (["--no-rules"] as const)
			: (["--no-prompt-templates", "--no-context-files"] as const)),
		// --no-tools is applied below only for unknown or explicitly zero-tool agents.
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
			args.push("--extension", resolveSubagentExtensionEntry(extension));
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
	// (sidekick/dreamer) still receive the lean entry.
	const subagentEntryPath = opts?.subagentEntryPath ?? SUBAGENT_ENTRY_PATH;
	const shouldLoadSubagentExtension =
		subagentEntryPath &&
		(SEARCH_ONLY_SUBAGENT_TOOL_AGENTS.has(options.agent) ||
			DREAMER_ACTION_AGENTS.has(options.agent));
	if (shouldLoadSubagentExtension) {
		args.push("--extension", subagentEntryPath);

		// Only dreamer subagents get ctx_memory in the child extension. Sidekick
		// loads the same entry for ctx_search but must stay read-only. The flag is
		// read inside the subagent extension via `pi.getFlag(...)`.
		if (DREAMER_ACTION_AGENTS.has(options.agent)) {
			args.push("--magic-context-dreamer-actions");
		}
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
		const hostTools = resolveHostToolAllowlist(strictTools, ompHost);
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
		// / dreamer / sidekick role guidance. The runner always writes that
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
			opts?.modelRef ?? resolveModelRefForHost(options.model),
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
	terminateChild,
	DREAMER_ACTION_AGENTS,
	KNOWN_PI_SUBAGENT_AGENTS,
	resolveHostToolAllowlist,
	STRICT_TOOL_ALLOWLIST,
	ZERO_TOOL_PROMPT_REQUIRED_AGENTS,
	resetProviderFormCache: () => PI_PROVIDER_FORM_CACHE.clear(),
};
