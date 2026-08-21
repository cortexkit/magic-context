import type {
	DreamerConfig,
	EmbeddingConfig,
} from "@magic-context/core/config/schema/magic-context";
import { openOpenCodeDb } from "@magic-context/core/features/magic-context/dreamer/open-opencode-db";
import {
	buildDreamTaskRuntimeConfigs,
	userMemoryCollectionEnabled,
} from "@magic-context/core/features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "@magic-context/core/features/magic-context/dreamer/task-executor";
import type { DreamTaskName } from "@magic-context/core/features/magic-context/dreamer/task-registry";
import {
	type ManualRunResult,
	runManualDream,
} from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { startDreamScheduleTimer as defaultStartDreamScheduleTimer } from "@magic-context/core/plugin/dream-timer";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { PiSubagentRunner } from "../subagent-runner";
import { createPiPrimerRawProviderFactory } from "./primer-raw-provider-pi";
import { PiRetrospectiveRawProvider } from "./retrospective-raw-provider-pi";

export interface PiDreamerOptions {
	db: ContextDatabase;
	projectDir: string;
	projectIdentity: string;
	/** One stable token per full Pi extension instance. */
	registrationOwner: object;
	/** Resolved runnable DreamerConfig from loadPiConfig(). When disable=true, the caller does not register. */
	config: DreamerConfig;
	/**
	 * Council finding #7: dreamer needs the real embedding config so it can
	 * (a) maintain near-duplicate/stale memories using deterministic file gates and
	 * (b) re-embed memory content when it gets rewritten by `improve`.
	 * Hardcoded `{provider:"off"}` previously meant dreamer skipped both
	 * paths even when the user had a real embedding model configured.
	 */
	embeddingConfig: EmbeddingConfig;
	/**
	 * Council finding #7: dreamer needs the real memory.enabled gate so the
	 * memory-promotion pipeline (consolidation + improve + archive) can
	 * actually write to the project memory store. Hardcoded `false`
	 * previously made dreamer's memory tasks a no-op.
	 */
	memoryEnabled: boolean;
	retinaHandoff?: boolean;
	mural?: { enabled: boolean; model?: string };
	language?: string;
	gitCommitIndexing: {
		enabled: boolean;
		since_days: number;
		max_commits: number;
	};
	/**
	 * G5: fired after dreamer publishes content that may affect
	 * <project-docs>, <user-profile>, or <key-files>. Implementation
	 * lives in context-handler (Slice 3); when undefined, refresh is a
	 * no-op (no harm — caches just stay stale until next /ctx-flush or
	 * system-prompt hash change). Slice 3 passes
	 * `signalPiSystemPromptRefreshForProject` here.
	 */
	onAdjunctsRefreshNeeded?: (projectIdentity: string) => void;
}

type DreamTimerRegistration = Parameters<
	typeof defaultStartDreamScheduleTimer
>[0];
type DreamTimerClient = DreamTimerRegistration["client"];

interface SessionCreateArgs {
	query?: unknown;
	body?: unknown;
}

interface SessionMessagesArgs {
	path: { id: string };
}

interface SessionPromptArgs extends SessionMessagesArgs {
	body?: unknown;
	signal?: AbortSignal | null;
}

type SessionDeleteArgs = SessionMessagesArgs;

interface ProjectRegistration {
	cleanup: () => void;
	activeOwner: object;
	owners: Map<object, PiDreamerOptions>;
	/** Run dream tasks for this project IMMEDIATELY (Dreamer v2 manual path).
	 *  `task` forces one task ignoring its gate; omitted runs all enabled. The
	 *  registered dreamer timer also runs due tasks on its own schedule. */
	runManual: (task?: DreamTaskName) => Promise<ManualRunResult>;
	/** The directory this registration was built for. `resolveProjectIdentity`
	 *  is intentionally identical across worktrees/clones of one repo, so a
	 *  `/cd` into a different checkout of the SAME repo keeps the same identity
	 *  but a different directory. We track it so re-registration can detect the
	 *  switch and rebuild against the new checkout + its config instead of
	 *  silently reusing the first one. */
	projectDir: string;
}

type PiSubagentRunnerFactory = () => PiSubagentRunner;

interface PiDreamerSession {
	id: string;
	directory: string;
	title?: string;
	messages: unknown[];
}

const registeredProjects = new Map<string, ProjectRegistration>();
const sessionsById = new Map<string, PiDreamerSession>();
const inFlightDreams = new Set<Promise<unknown>>();
let sessionCounter = 0;
let piSubagentRunnerFactory: PiSubagentRunnerFactory = () =>
	new PiSubagentRunner();
let startDreamScheduleTimerFn: typeof defaultStartDreamScheduleTimer =
	defaultStartDreamScheduleTimer;

/** Initialize the Pi-side dreamer integration: register this project with
 *  the singleton timer, ensure PiSubagentRunner is the active runner. */
export function registerPiDreamerProject(opts: PiDreamerOptions): void {
	if (opts.config.disable === true) {
		return;
	}

	const existing = registeredProjects.get(opts.projectIdentity);
	const owners = existing?.owners ?? new Map<object, PiDreamerOptions>();
	owners.set(opts.registrationOwner, opts);
	if (existing) {
		// Same identity, same directory → genuinely already registered, no-op.
		// Keep this extension instance as an owner so another session cannot
		// deregister the shared timer while it is still active.
		if (existing.projectDir === opts.projectDir) {
			return;
		}
		// Same identity, DIFFERENT directory: a worktree/clone switch in the same
		// process. The existing registration's timer + client closure are pinned
		// to the OLD checkout and its boot-time dreamerConfig. Tear it down and
		// rebuild against the new directory + freshly-resolved config below, so
		// the dreamer runs in the right checkout (and honors a `dreamer.disable`
		// that may differ between checkouts — handled by the disable early-return
		// above, which fires before this).
		existing.cleanup();
		registeredProjects.delete(opts.projectIdentity);
	}

	// Build the dreamer client ONCE so both the timer and the immediate
	// /ctx-dream path share the same `inFlightDreams` accounting + the
	// same module-private `sessionsById` table.
	const client = createPiDreamerClient(opts);

	let cleanup: (() => void) | undefined;
	let cancelled = false;
	void startDreamScheduleTimerFn({
		directory: opts.projectDir,
		projectIdentity: opts.projectIdentity,
		harness: "pi",
		client,
		dreamerConfig: opts.config,
		language: opts.language,
		gitCommitIndexing: opts.gitCommitIndexing,
		retinaHandoff: opts.retinaHandoff,
		mural: opts.mural,
		ensureRegistered: ensureProjectRegisteredFromPiDirectory,
		// SCHEDULED Pi retrospective must read Pi JSONL sessions, not opencode.db.
		// Supply the Pi provider factory (db arg ignored — Pi reads JSONL by cwd),
		// converging the scheduled path onto the same provider the manual
		// /ctx-dream path already uses.
		retrospectiveRawProvider: () =>
			new PiRetrospectiveRawProvider({ projectCwd: opts.projectDir }),
		// SCHEDULED refresh-primers likewise needs the Pi JSONL factory so its
		// open-book seed renders raw U:/TC: lines; without it the scheduled task
		// silently ran closed-book (the manual /ctx-dream path already wires this).
		primerRawProviderFactory: createPiPrimerRawProviderFactory(),
	}).then((timerCleanup) => {
		if (cancelled) {
			// Registration was cancelled before timer setup completed —
			// immediately invoke cleanup to prevent leaked timer registration.
			timerCleanup?.();
			return;
		}
		cleanup = timerCleanup;
	});

	// Manual /ctx-dream (Dreamer v2): run dream tasks NOW via the per-task
	// scheduler, using the same DreamTimerClient facade the timer uses (cast at
	// the boundary — it implements the session.{create,prompt,messages,delete}
	// surface the executor consumes; TS can't see structural compatibility
	// through the wrapper). Project-scoped: only this project's tasks run.
	const runManual = async (task?: DreamTaskName): Promise<ManualRunResult> =>
		runManualDream({
			db: opts.db,
			projectIdentity: opts.projectIdentity,
			tasks: buildDreamTaskRuntimeConfigs(
				opts.config,
				"pi",
				opts.language,
				opts.mural?.model,
			),
			executor: createDreamTaskExecutor({
				client: client as never,
				sessionDirectory: opts.projectDir,
				openOpenCodeDb,
				retrospectiveRawProvider: new PiRetrospectiveRawProvider({
					projectCwd: opts.projectDir,
				}),
				primerRawProviderFactory: createPiPrimerRawProviderFactory(),
				userMemoryCollectionEnabled: userMemoryCollectionEnabled(opts.config),
				ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
				language: opts.language,
				retinaHandoff: opts.retinaHandoff,
				mural: opts.mural,
			}),
			task,
		});

	registeredProjects.set(opts.projectIdentity, {
		activeOwner: opts.registrationOwner,
		owners,
		cleanup: () => {
			cancelled = true;
			cleanup?.();
		},
		runManual,
		projectDir: opts.projectDir,
	});
}

/**
 * Run one dream cycle IMMEDIATELY for the given project, mirroring
 * OpenCode's `/ctx-dream` behavior. Returns the run result, or `null`
 * if there's nothing to dequeue (queue empty or another worker holds
 * the lease — see `processDreamQueue` semantics). Throws if the project
 * isn't registered (call `registerPiDreamerProject` first).
 *
 * The user-visible reason this exists: without it, the user types
 * `/ctx-dream` and gets "queued, the timer will run it eventually" —
 * which makes the command feel broken even though the queue entry is
 * really there. Mirroring OpenCode's behavior lets us actually drain
 * it on the same turn.
 */
export async function runPiDreamForProject(
	projectIdentity: string,
	task?: DreamTaskName,
): Promise<ManualRunResult> {
	const registration = registeredProjects.get(projectIdentity);
	if (!registration) {
		throw new Error(
			`Pi dreamer not registered for project ${projectIdentity}; call registerPiDreamerProject() first`,
		);
	}
	return registration.runManual(task);
}

/** Cleanup hook — call from session_shutdown to release this session's ownership. */
export function unregisterPiDreamerProject(opts: {
	projectIdentity: string;
	registrationOwner: object;
}): void {
	const registration = registeredProjects.get(opts.projectIdentity);
	if (!registration?.owners.delete(opts.registrationOwner)) {
		return;
	}

	if (registration.owners.size > 0) {
		if (registration.activeOwner !== opts.registrationOwner) return;
		// The active worktree owner left while sibling sessions still use this
		// project. Rebuild from the remaining owners so the shared timer follows
		// a live session instead of retaining the departed session's directory.
		const remaining = [...registration.owners.values()];
		registration.cleanup();
		registeredProjects.delete(opts.projectIdentity);
		for (const remainingOptions of remaining)
			registerPiDreamerProject(remainingOptions);
		return;
	}

	registration.cleanup();
	registeredProjects.delete(opts.projectIdentity);
}

/** Wait for any currently-running dreamer task to finish gracefully. Used
 *  in agent_end / session_shutdown so Pi doesn't kill an in-flight dream
 *  in `--print` mode. Same pattern as `awaitInFlightHistorians()`. */
export async function awaitInFlightDreamers(): Promise<void> {
	if (inFlightDreams.size === 0) {
		return;
	}

	await Promise.allSettled(Array.from(inFlightDreams));
}

function createPiDreamerClient(opts: PiDreamerOptions): DreamTimerClient {
	const runner = piSubagentRunnerFactory();

	const session = {
		create: async (args: SessionCreateArgs) => {
			const sessionId = `magic-context-pi-dream-${++sessionCounter}`;
			sessionsById.set(sessionId, {
				id: sessionId,
				directory: readDirectory(args) ?? opts.projectDir,
				title: readSessionTitle(args),
				messages: [],
			});
			return { id: sessionId };
		},
		list: async () => ({ data: [] as Array<{ id: string }> }),
		prompt: async (args: SessionPromptArgs) => {
			const sessionId = args.path.id;
			const dreamSession = sessionsById.get(sessionId);
			if (!dreamSession) {
				throw new Error(`Pi dreamer session not found: ${sessionId}`);
			}

			const userMessage = extractUserMessage(args);
			const systemPrompt = extractSystemPrompt(args);
			// Per-task model override (Dreamer v2): the SHARED executor
			// (promptSyncWithValidatedOutputRetry) owns fallback iteration — it
			// rewrites body.model to each candidate (per-task model, then the
			// per-task fallback chain) and calls this facade once per attempt. So
			// we use body.model as the current attempt's model and pass
			// fallbackModels: undefined; passing the dreamer-level chain here would
			// double-iterate and override a task's own (possibly empty) chain.
			const perTaskModel = extractBodyModel(args);
			const requestedAgent = extractBodyAgent(args) ?? "magic-context-dreamer";
			const runPromise = runner.run({
				agent: requestedAgent,
				systemPrompt,
				userMessage,
				model: perTaskModel,
				fallbackModels: undefined,
				// The executor enforces the per-task timeout via its abort signal;
				// give the subprocess a generous ceiling so the signal is the
				// authority (not a second, conflicting wall-clock here).
				timeoutMs: 30 * 60 * 1000,
				cwd: dreamSession.directory,
				signal: args.signal ?? undefined,
				// modelBodyField writes the active entry qualifier as OpenCode's
				// `variant`; the Pi facade translates that same wire field into
				// `--thinking` without letting a primary level leak to fallbacks.
				thinkingLevel: extractBodyVariant(args),
			});
			inFlightDreams.add(runPromise);
			try {
				const result = await runPromise;
				if (!result.ok) {
					const error = new Error(
						`Pi dreamer subagent failed (${result.reason}): ${result.error}`,
					);
					if (result.transient) {
						(error as Error & { transient?: boolean }).transient = true;
					}
					throw error;
				}
				dreamSession.messages = [
					makeMessage("user", [{ type: "text", text: userMessage }]),
					makeMessage("assistant", [
						// Synthetic tool parts first so investigationToolCallCount
						// (refresh-primers grounding gate) sees the agent's tool use,
						// then the final answer text.
						...syntheticToolParts(result.toolCallCount ?? 0),
						{ type: "text", text: result.assistantText },
					]),
				];
				// G5: fire conservatively after every successful dreamer task. Many
				// dreamer tasks (verify, curate, docs) don't touch the system-
				// prompt adjuncts, but improve / maintain-docs / user-memory-review
				// can update <project-docs>, <user-profile>, or <key-files>. The cost
				// of one extra disk read per session next turn is tiny compared to
				// stale adjuncts surviving until restart.
				opts.onAdjunctsRefreshNeeded?.(opts.projectIdentity);
			} finally {
				inFlightDreams.delete(runPromise);
			}
		},
		messages: async (args: SessionMessagesArgs) => {
			const dreamSession = sessionsById.get(args.path.id);
			return { data: dreamSession?.messages ?? [] };
		},
		delete: async (args: SessionDeleteArgs) => {
			sessionsById.delete(args.path.id);
			return {};
		},
	};

	return { session } as unknown as DreamTimerClient;
}

function readDirectory(args: { query?: unknown }): string | undefined {
	const query = args.query;
	if (typeof query !== "object" || query === null) {
		return undefined;
	}

	const directory = (query as { directory?: unknown }).directory;
	return typeof directory === "string" && directory.length > 0
		? directory
		: undefined;
}

function readSessionTitle(args: { body?: unknown }): string | undefined {
	const body = args.body;
	if (typeof body !== "object" || body === null) {
		return undefined;
	}

	const title = (body as { title?: unknown }).title;
	return typeof title === "string" ? title : undefined;
}

function extractUserMessage(args: { body?: unknown }): string {
	const body = args.body;
	if (typeof body !== "object" || body === null) {
		return "";
	}

	const parts = (body as { parts?: unknown }).parts;
	if (!Array.isArray(parts)) {
		return "";
	}

	return parts
		.map((part) => {
			if (typeof part !== "object" || part === null) {
				return "";
			}
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function extractSystemPrompt(args: { body?: unknown }): string {
	const body = args.body;
	if (typeof body !== "object" || body === null) {
		return "";
	}

	const system = (body as { system?: unknown }).system;
	return typeof system === "string" ? system : "";
}

/** Read the per-task `body.model` ({ providerID, modelID }) the executor sets,
 *  back into a "provider/model" spec the PiSubagentRunner expects. */
function extractBodyModel(args: { body?: unknown }): string | undefined {
	const body = args.body;
	if (typeof body !== "object" || body === null) return undefined;
	const model = (body as { model?: unknown }).model;
	if (typeof model !== "object" || model === null) return undefined;
	const providerID = (model as { providerID?: unknown }).providerID;
	const modelID = (model as { modelID?: unknown }).modelID;
	if (typeof providerID === "string" && typeof modelID === "string") {
		return `${providerID}/${modelID}`;
	}
	return undefined;
}

function extractBodyVariant(args: { body?: unknown }): string | undefined {
	const body = args.body;
	if (typeof body !== "object" || body === null) return undefined;
	const variant = (body as { variant?: unknown }).variant;
	return typeof variant === "string" && variant.length > 0
		? variant
		: undefined;
}

function extractBodyAgent(args: { body?: unknown }): string | undefined {
	const body = args.body;
	if (typeof body !== "object" || body === null) return undefined;
	const agent = (body as { agent?: unknown }).agent;
	return typeof agent === "string" && agent.length > 0 ? agent : undefined;
}

type SyntheticPart =
	| { type: "text"; text: string }
	| { type: "tool"; tool: string; state: { input: { description: string } } };

/**
 * Build `toolCallCount` synthetic tool parts so the shared
 * `investigationToolCallCount` / `extractToolCallSummaries` (which require
 * `{ type: "tool", tool, state }`) sees the agent's investigation on Pi. Pi's
 * facade only carries the final assistant text, so without these the
 * refresh-primers grounding gate (count > 0) would reject every Pi answer.
 */
function syntheticToolParts(count: number): SyntheticPart[] {
	const safe = Math.max(0, Math.floor(count));
	return Array.from({ length: safe }, () => ({
		type: "tool" as const,
		tool: "investigation",
		state: { input: { description: "investigation step" } },
	}));
}

function makeMessage(
	role: "user" | "assistant",
	parts: SyntheticPart[],
): unknown {
	return {
		info: {
			role,
			time: { created: Date.now() },
		},
		parts,
	};
}

export const __test = {
	registeredProjectCount: () => registeredProjects.size,
	setPiSubagentRunnerFactory: (factory: PiSubagentRunnerFactory) => {
		piSubagentRunnerFactory = factory;
	},
	setStartDreamScheduleTimerFactory: (
		factory: typeof defaultStartDreamScheduleTimer,
	) => {
		startDreamScheduleTimerFn = factory;
	},
	reset: () => {
		for (const registration of registeredProjects.values()) {
			registration.cleanup();
		}
		registeredProjects.clear();
		sessionsById.clear();
		inFlightDreams.clear();
		sessionCounter = 0;
		piSubagentRunnerFactory = () => new PiSubagentRunner();
		startDreamScheduleTimerFn = defaultStartDreamScheduleTimer;
	},
};
