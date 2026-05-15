/**
 * Pi-side tool registration.
 *
 * Registers `ctx_search`, `ctx_memory`, `ctx_note`, `ctx_expand`, and
 * conditionally `ctx_reduce` against the live Pi extension API. The
 * shared guidance block in `system-prompt.ts` advertises these to the
 * LLM only when each is registered, so a registration gap surfaces as
 * "tool not found" errors when the agent tries to follow the guidance.
 *
 * `ctx_reduce` is gated on `ctxReduceEnabled`: when
 * `magic_context.ctx_reduce_enabled === false`, neither the tool nor
 * the §N§ tag prefix injection nor the related prompt guidance are
 * shipped. This matches OpenCode's gating in `tool-registry.ts`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { createCtxExpandTool } from "./ctx-expand";
import { createCtxMemoryTool } from "./ctx-memory";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxReduceTool } from "./ctx-reduce";
import { createCtxSearchTool } from "./ctx-search";
import { createTodowriteTool } from "./todowrite";

export interface RegisterToolsOptions {
	db: ContextDatabase;
	memoryEnabled: boolean;
	embeddingEnabled: boolean;
	gitCommitsEnabled?: boolean;
	/** When true, ctx_memory exposes dreamer-only actions (update, merge, archive).
	 *  Set by the subagent extension entry when the parent passes
	 *  `--magic-context-dreamer-actions`. The main extension entry
	 *  (./index.ts) leaves this false to match OpenCode's primary-agent surface. */
	allowDreamerActions?: boolean;
	/** When true, register `ctx_reduce`. The flag should match
	 *  `magic_context.ctx_reduce_enabled`. When false, the agent is in
	 *  no-reduce mode (caveman compression / heuristic cleanup do all
	 *  the work) and `ctx_reduce` shouldn't appear in the tool surface. */
	ctxReduceEnabled?: boolean;
	/** Number of recent tags that ctx_reduce should treat as protected
	 *  (deferred drops instead of immediate). Should match `magic_context.protected_tags`. */
	protectedTags?: number;
	/** When true, ctx_note accepts smart notes (surface_condition) because
	 *  the dreamer is configured to evaluate them. When false, smart-note
	 *  writes are rejected to avoid stuck-pending state. */
	dreamerEnabled?: boolean;
}

export function registerMagicContextTools(
	pi: ExtensionAPI,
	opts: RegisterToolsOptions,
): void {
	pi.registerTool(
		createCtxSearchTool({
			db: opts.db,
			memoryEnabled: opts.memoryEnabled,
			embeddingEnabled: opts.embeddingEnabled,
			gitCommitsEnabled: opts.gitCommitsEnabled,
		}),
	);

	pi.registerTool(
		createCtxMemoryTool({
			db: opts.db,
			memoryEnabled: opts.memoryEnabled,
			embeddingEnabled: opts.embeddingEnabled,
			allowDreamerActions: opts.allowDreamerActions ?? false,
		}),
	);

	pi.registerTool(
		createCtxNoteTool({
			db: opts.db,
			dreamerEnabled: opts.dreamerEnabled ?? false,
		}),
	);

	pi.registerTool(createCtxExpandTool({ db: opts.db }));

	// `todowrite` parity with OpenCode. Pi-coding-agent has no built-in
	// task list tool, so without this the synthetic-todowrite injector
	// would never have anything to surface. The tool just captures the
	// `todos` arg and echoes a pretty-printed JSON ack; `message_end`
	// in index.ts snapshots `params.todos` into `session_meta.last_todo_state`
	// for downstream synthesis. See `tools/todowrite.ts` header for rationale.
	pi.registerTool(createTodowriteTool());

	// Conditionally register ctx_reduce. When ctxReduceEnabled is false:
	//   - tool not registered (agent gets "tool not found" if it tries
	//     to call ctx_reduce — but it shouldn't because the prompt
	//     guidance also drops all references)
	//   - §N§ tag prefix injection is also disabled upstream in
	//     transcript-pi.ts, matching OpenCode's transform.ts gate
	if (opts.ctxReduceEnabled === true) {
		pi.registerTool(
			createCtxReduceTool({
				db: opts.db,
				protectedTags: opts.protectedTags ?? 20,
			}),
		);
	}
}
