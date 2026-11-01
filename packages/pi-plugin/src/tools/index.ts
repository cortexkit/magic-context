/**
 * Pi-side tool registration.
 *
 * Registers `ctx_search`, `ctx_memory`, `ctx_note`, `ctx_expand`, and
 * `ctx_reduce` against the live Pi extension API. The shared guidance block
 * in `system-prompt.ts` advertises these to the LLM only when each is
 * available, so a registration gap surfaces as "tool not found" errors when
 * the agent tries to follow the guidance.
 *
 * `ctx_reduce` is part of the primary session-scoped surface. It is omitted
 * only for `--no-session` child processes where session-scoped tools would
 * resolve to the hidden ephemeral child session.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { log } from "@magic-context/core/shared/logger";
import type { PromptSurfaceConfig } from "@magic-context/core/shared/prompt-surface";
import type { PromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { withoutSmartNoteText } from "@magic-context/core/tools/ctx-note/constants";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "@magic-context/core/tools/light-descriptions";
import { applyJsonSchemaParameterDescriptions } from "@magic-context/core/tools/parameter-descriptions";
import { restoreOmpMentions } from "../omp-mentions";
import { resolvePiHarnessKind } from "../pi-harness-kind";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxMemoryListTool, createCtxMemoryTool } from "./ctx-memory";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxReduceTool } from "./ctx-reduce";
import { createCtxSearchTool } from "./ctx-search";
import { throwReturnedToolErrors } from "./pi-tool-errors";
import { registerTodosCommand } from "./todo-view-pi";
import { createTodowriteTool } from "./todowrite";

const CTX_MEMORY_TOOL_NAME = "ctx_memory";

type OmpEssentialTool = { loadMode?: "essential" };

/** Keep OMP context tool schemas in the model's top-level list, not its tool catalog. */
function setOmpEssentialLoadMode<T extends ToolDefinition>(
	definition: T,
): T & OmpEssentialTool {
	if (resolvePiHarnessKind() !== "omp") return definition;
	return Object.assign(definition, { loadMode: "essential" as const });
}

/**
 * Keep Pi's active tool set aligned with the current project's memory policy.
 * The definition stays registered so a later session can re-enable it without
 * restarting the Pi process; the ctx_memory call-time guard remains in place.
 */
export function syncCtxMemoryToolEnabled(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
	memoryEnabled: boolean,
): void {
	const activeTools = pi.getActiveTools();
	const isActive = activeTools.includes(CTX_MEMORY_TOOL_NAME);
	if (memoryEnabled === isActive) return;

	pi.setActiveTools(
		memoryEnabled
			? [...activeTools, CTX_MEMORY_TOOL_NAME]
			: activeTools.filter((toolName) => toolName !== CTX_MEMORY_TOOL_NAME),
	);
}

export interface RegisterToolsOptions {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	gitCommitsEnabled?: boolean;
	rerankConnectionFile?: string;
	rerankConfig?: import("@magic-context/core/config/schema/magic-context").RerankConfig;
	/** Resolve the served prefix's owner, using the directory only before a prefix exists. */
	resolveProjectIdentity?: (
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	) => string | undefined | Promise<string | undefined>;
	/** When true, register the separate ctx_memory_list tool and enable Curate-only
	 *  execution fields. Set only by the lean dreamer subagent extension. */
	allowDreamerActions?: boolean;
	/** Number of recent tags that ctx_reduce should treat as protected
	 *  (deferred drops instead of immediate). Should match `magic_context.protected_tags`. */
	protectedTags?: number;
	protectedTools?: Readonly<Record<string, number>>;
	resolveProtectedTools?: (ctx: {
		cwd: string;
	}) => Readonly<Record<string, number>> | undefined;
	/** Resolve protected-tag config from the current cwd at tool-call time. */
	resolveProtectedTags?: (ctx: { cwd: string }) => number | undefined;
	/** When true, ctx_note accepts smart notes (surface_condition) because
	 *  the dreamer is configured to evaluate them. When false, smart-note
	 *  writes are rejected to avoid stuck-pending state. */
	dreamerEnabled?: boolean;
	smartNotesEnabled?: boolean;
	/** Resolve smart-note enablement from the current cwd at tool-call time. */
	resolveDreamerEnabled?: (ctx: { cwd: string }) => boolean | undefined;
	expandTools?: Record<string, string | false>;
	/** When false, omit ctx_memory from the registered surface. */
	memoryToolEnabled?: boolean;
	/** When true, omit session-scoped tools (ctx_note, ctx_expand) from the
	 *  registered surface. Set by `--no-session` Dreamer children:
	 *  those tools resolve `ctx.sessionManager.getSessionId()` to the EPHEMERAL
	 *  child session, so ctx_note would write notes orphaned under the hidden
	 *  child id and ctx_expand would expand the child's empty transcript. */
	sessionScopedToolsDisabled?: boolean;
	/** When false, omit Magic Context's Pi todowrite tool entirely. */
	todowriteEnabled?: boolean;
	/** Main Pi entry registers /todos; lean subagent entries keep commands off. */
	todowriteCommandEnabled?: boolean;
	/** In compaction-off mode, omit ctx_reduce and keep the other Pi tools available. */
	compactionOff?: boolean;
	promptSurface?: PromptSurfaceConfig;
	promptSurfaceRuntime?: PromptSurfaceRuntime;
}

export function registerMagicContextTools(
	pi: ExtensionAPI,
	opts: RegisterToolsOptions,
): void {
	const resolveProjectIdentity = opts.resolveProjectIdentity
		? (_directory: string, ctx: ExtensionContext) =>
				opts.resolveProjectIdentity?.(ctx)
		: undefined;
	const promptSurfaceRuntime =
		opts.promptSurfaceRuntime ??
		createPromptSurfaceRuntime({
			userConfigDirectory: process.cwd(),
			warn: (message) => log(`[magic-context][pi] config warning: ${message}`),
		});
	// Pi registers provider tools once when the extension loads. Resolve the
	// registration default once here; project/model switches may reroute guidance
	// but cannot mutate the descriptions owned by this ExtensionAPI instance.
	const registration = promptSurfaceRuntime.resolveRegistration(
		opts.promptSurface,
	);
	// Smart notes need smart_notes.enabled and a runnable dreamer, which evaluates
	// their conditions. Either one off drops ctx_note's smart-note text; an
	// omitted flag (as in subagent entries) counts as on.
	const smartNotesAvailable =
		opts.smartNotesEnabled !== false && opts.dreamerEnabled !== false;
	const restoreChildMentions =
		process.env.MAGIC_CONTEXT_PI_SUBAGENT === "1" &&
		resolvePiHarnessKind() === "omp";
	const surfaceTool = <T extends ToolDefinition>(
		definition: T,
	): T & OmpEssentialTool => {
		const parameters = structuredClone(definition.parameters);
		applyJsonSchemaParameterDescriptions(
			definition.name,
			parameters,
			registration.preset,
			smartNotesAvailable ? opts.smartNotesEnabled : false,
		);
		return setOmpEssentialLoadMode(
			throwReturnedToolErrors({
				...definition,
				parameters,
				// Dreamer tools write memory inside the child, before the parent
				// restores its event stream. Drop a WORD JOINER that was inserted
				// only to keep an @ mention literal.
				execute: (...args: Parameters<ToolDefinition["execute"]>) => {
					if (restoreChildMentions) args[1] = restoreOmpMentions(args[1]);
					return definition.execute(...args);
				},
				description:
					definition.name === "ctx_note" && !smartNotesAvailable
						? withoutSmartNoteText(
								registration.preset === "light"
									? CTX_NOTE_LIGHT_DESCRIPTION
									: definition.description,
							)
						: registration.descriptionFor(
								definition.name,
								definition.description,
							),
			}),
		);
	};

	pi.registerTool(
		surfaceTool(
			createCtxSearchTool({
				db: opts.db,
				ensureProjectRegistered: opts.ensureProjectRegistered,
				memoryEnabled: opts.memoryEnabled,
				embeddingEnabled: opts.embeddingEnabled,
				gitCommitsEnabled: opts.gitCommitsEnabled,
				rerankConnectionFile: opts.rerankConnectionFile,
				rerankConfig: opts.rerankConfig,
				resolveProjectIdentity,
			}),
		),
	);

	if (opts.memoryToolEnabled !== false) {
		const memoryDeps = {
			db: opts.db,
			ensureProjectRegistered: opts.ensureProjectRegistered,
			memoryEnabled: opts.memoryEnabled,
			embeddingEnabled: opts.embeddingEnabled,
			allowDreamerActions: opts.allowDreamerActions ?? false,
			resolveProjectIdentity,
		};
		pi.registerTool(surfaceTool(createCtxMemoryTool(memoryDeps)));
		if (opts.allowDreamerActions === true) {
			pi.registerTool(
				setOmpEssentialLoadMode(
					throwReturnedToolErrors(createCtxMemoryListTool(memoryDeps)),
				),
			);
		}
	}

	// ctx_note and ctx_expand are session-scoped: they resolve the CURRENT
	// session id at call time. For `--no-session` children that id is the hidden
	// ephemeral child session, so a note would be orphaned and an expand would
	// target the child's empty transcript. Omit them for those children; ctx_search
	// stays available and ctx_memory is controlled above.
	if (!opts.sessionScopedToolsDisabled) {
		pi.registerTool(
			surfaceTool(
				createCtxNoteTool({
					db: opts.db,
					dreamerEnabled: opts.dreamerEnabled,
					smartNotesEnabled: opts.smartNotesEnabled,
					resolveDreamerEnabled: opts.resolveDreamerEnabled,
					resolveProjectIdentity,
				}),
			),
		);

		pi.registerTool(
			surfaceTool(
				createCtxExpandTool({ db: opts.db, expandTools: opts.expandTools }),
			),
		);
	}

	if (opts.todowriteEnabled === true) {
		// `todowrite` parity with OpenCode. Pi-coding-agent has no built-in
		// task list tool, so without this the synthetic-todowrite injector
		// would never have anything to surface. The tool just captures the
		// `todos` arg and echoes a pretty-printed JSON ack; `message_end`
		// in index.ts snapshots `params.todos` into `session_meta.last_todo_state`
		// for downstream synthesis. See `tools/todowrite.ts` header for rationale.
		pi.registerTool(createTodowriteTool());
		if (opts.todowriteCommandEnabled !== false) {
			registerTodosCommand(pi);
		}
	}

	// ctx_reduce is session-scoped just like ctx_note/ctx_expand: it resolves the
	// CURRENT session id at call time. Omit it for `--no-session` children where
	// that id points at a hidden ephemeral child session.
	if (!opts.sessionScopedToolsDisabled && !opts.compactionOff) {
		pi.registerTool(
			surfaceTool(
				createCtxReduceTool({
					db: opts.db,
					protectedTags: opts.protectedTags ?? 20,
					protectedTools: opts.protectedTools,
					resolveProtectedTools: opts.resolveProtectedTools,
					resolveProtectedTags: opts.resolveProtectedTags,
				}),
			),
		);
	}
}
