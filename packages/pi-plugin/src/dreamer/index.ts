import type {
	DreamerConfig,
	EmbeddingConfig,
} from "@magic-context/core/config/schema/magic-context";
import {
	processDreamQueue,
	registerDreamProjectDirectory,
} from "@magic-context/core/features/magic-context/dreamer";
import type { DreamRunResult } from "@magic-context/core/features/magic-context/dreamer/runner";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { startDreamScheduleTimer } from "@magic-context/core/plugin/dream-timer";
import { ensureProjectRegisteredFromPiDirectory } from "../embedding-bootstrap";
import { PiSubagentRunner } from "../subagent-runner";

export interface PiDreamerOptions {
	db: ContextDatabase;
	projectDir: string;
	projectIdentity: string;
	/** Resolved DreamerConfig from loadPiConfig(). When .enabled is false, the function is a no-op. */
	config: DreamerConfig;
	/**
	 * Council finding #7: dreamer needs the real embedding config so it can
	 * (a) consolidate near-duplicate memories using cosine similarity and
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
	gitCommitIndexing: {
		enabled: boolean;
		since_days: number;
		max_commits: number;
	};
}

type DreamTimerRegistration = Parameters<typeof startDreamScheduleTimer>[0];
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
	/** Run one dream cycle for this project IMMEDIATELY (mirrors OpenCode's
	 *  `command-handler.ts:236-246` `processDreamQueue` invocation). The
	 *  registered dreamer timer also calls this on its own schedule. */
	runOnce: () => Promise<DreamRunResult | null>;
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

/** Initialize the Pi-side dreamer integration: register this project with
 *  the singleton timer, ensure PiSubagentRunner is the active runner. */
export function registerPiDreamerProject(opts: PiDreamerOptions): void {
	if (!opts.config.enabled) {
		return;
	}

	const existing = registeredProjects.get(opts.projectIdentity);
	if (existing) {
		return;
	}

	registerDreamProjectDirectory(opts.projectIdentity, opts.projectDir);

	// Build the dreamer client ONCE so both the timer and the immediate
	// /ctx-dream path share the same `inFlightDreams` accounting + the
	// same module-private `sessionsById` table.
	const client = createPiDreamerClient(opts);

	const experimentalUserMemories = opts.config.user_memories.enabled
		? {
				enabled: true,
				promotionThreshold: opts.config.user_memories.promotion_threshold,
			}
		: undefined;
	const experimentalPinKeyFiles = opts.config.pin_key_files.enabled
		? {
				enabled: true,
				token_budget: opts.config.pin_key_files.token_budget,
				min_reads: opts.config.pin_key_files.min_reads,
			}
		: undefined;

	let cleanup: (() => void) | undefined;
	void startDreamScheduleTimer({
		directory: opts.projectDir,
		projectIdentity: opts.projectIdentity,
		client,
		dreamerConfig: opts.config,
		experimentalUserMemories,
		experimentalPinKeyFiles,
		gitCommitIndexing: opts.gitCommitIndexing,
		ensureRegistered: ensureProjectRegisteredFromPiDirectory,
	}).then((timerCleanup) => {
		cleanup = timerCleanup;
	});

	// Pi parity for OpenCode `command-handler.ts:236-246` (`/ctx-dream`):
	// after enqueueing, OpenCode immediately drains the queue via
	// `processDreamQueue`. Pi previously relied on the 15-min timer tick,
	// which made `/ctx-dream` feel broken (the user typed it but nothing
	// observable happened). Capture the same per-project args so a single
	// callback can run one cycle on demand.
	const runOnce = async (): Promise<DreamRunResult | null> =>
		processDreamQueue({
			db: opts.db,
			// processDreamQueue's PluginContext['client'] type comes from
			// OpenCode's @opencode-ai/sdk. The DreamTimerClient we pass
			// implements the same `session.{create,prompt,messages,delete}`
			// surface processDreamQueue actually consumes — but TS can't
			// see structural compatibility through the wrapper. Cast at the
			// boundary; the runtime contract is the same one the timer uses.
			client: client as never,
			tasks: opts.config.tasks,
			taskTimeoutMinutes: opts.config.task_timeout_minutes,
			maxRuntimeMinutes: opts.config.max_runtime_minutes,
			experimentalUserMemories,
			experimentalPinKeyFiles,
			// Pi /ctx-dream is project-scoped: only drain THIS project's
			// queue entry, not whatever happens to be at the queue head
			// (which could belong to an OpenCode-only project Pi can't
			// possibly dream).
			projectIdentity: opts.projectIdentity,
		});

	registeredProjects.set(opts.projectIdentity, {
		cleanup: () => cleanup?.(),
		runOnce,
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
): Promise<DreamRunResult | null> {
	const registration = registeredProjects.get(projectIdentity);
	if (!registration) {
		throw new Error(
			`Pi dreamer not registered for project ${projectIdentity}; call registerPiDreamerProject() first`,
		);
	}
	return registration.runOnce();
}

/** Cleanup hook — call from session_shutdown to deregister this project. */
export function unregisterPiDreamerProject(opts: {
	projectIdentity: string;
}): void {
	const registration = registeredProjects.get(opts.projectIdentity);
	if (!registration) {
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
	const model = opts.config.model;
	const fallbackModels = normalizeFallbackModels(opts.config.fallback_models);

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
			const runPromise = runner.run({
				agent: "magic-context-dreamer",
				systemPrompt,
				userMessage,
				model,
				fallbackModels,
				timeoutMs: opts.config.task_timeout_minutes * 60 * 1000,
				cwd: dreamSession.directory,
				signal: args.signal ?? undefined,
				thinkingLevel: opts.config.thinking_level,
			});
			inFlightDreams.add(runPromise);
			try {
				const result = await runPromise;
				if (!result.ok) {
					throw new Error(
						`Pi dreamer subagent failed (${result.reason}): ${result.error}`,
					);
				}
				dreamSession.messages = [
					makeMessage("user", [{ type: "text", text: userMessage }]),
					makeMessage("assistant", [
						{ type: "text", text: result.assistantText },
					]),
				];
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

function normalizeFallbackModels(
	value: DreamerConfig["fallback_models"],
): readonly string[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		return [value];
	}
	return undefined;
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

function makeMessage(
	role: "user" | "assistant",
	parts: Array<{ type: "text"; text: string }>,
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
	normalizeFallbackModels,
	setPiSubagentRunnerFactory: (factory: PiSubagentRunnerFactory) => {
		piSubagentRunnerFactory = factory;
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
	},
};
