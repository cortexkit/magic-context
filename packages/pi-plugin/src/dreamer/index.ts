import type { DreamerConfig } from "@magic-context/core/config/schema/magic-context";
import { registerDreamProjectDirectory } from "@magic-context/core/features/magic-context/dreamer";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { startDreamScheduleTimer } from "@magic-context/core/plugin/dream-timer";
import { PiSubagentRunner } from "../subagent-runner";

export interface PiDreamerOptions {
	db: ContextDatabase;
	projectDir: string;
	projectIdentity: string;
	/** Resolved DreamerConfig from loadPiConfig(). When .enabled is false, the function is a no-op. */
	config: DreamerConfig;
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

	const cleanup = startDreamScheduleTimer({
		directory: opts.projectDir,
		client: createPiDreamerClient(opts),
		dreamerConfig: opts.config,
		embeddingConfig: { provider: "off" },
		memoryEnabled: false,
		experimentalUserMemories: opts.config.user_memories.enabled
			? {
					enabled: true,
					promotionThreshold: opts.config.user_memories.promotion_threshold,
				}
			: undefined,
		experimentalPinKeyFiles: opts.config.pin_key_files.enabled
			? {
					enabled: true,
					token_budget: opts.config.pin_key_files.token_budget,
					min_reads: opts.config.pin_key_files.min_reads,
				}
			: undefined,
	});

	if (!cleanup) {
		return;
	}

	registeredProjects.set(opts.projectIdentity, { cleanup });
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
