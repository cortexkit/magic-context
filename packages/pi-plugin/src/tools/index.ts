/**
 * Pi-side tool registration.
 *
 * Registers `ctx_search`, `ctx_memory`, and `ctx_note` against the live Pi
 * extension API. `ctx_expand` is intentionally NOT registered yet — it
 * relies on raw OpenCode message ordinals, which Pi sessions don't index
 * yet (deferred to the message-transform pipeline in Step 4b).
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createCtxMemoryTool } from "./ctx-memory";
import { createCtxNoteTool } from "./ctx-note";
import { createCtxSearchTool } from "./ctx-search";

export interface RegisterToolsOptions {
	db: ContextDatabase;
	memoryEnabled: boolean;
	embeddingEnabled: boolean;
	gitCommitsEnabled?: boolean;
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
		}),
	);

	pi.registerTool(createCtxNoteTool({ db: opts.db }));
}
