/**
 * Magic Context — Pi subagent extension entry.
 *
 * This is a lean extension entry loaded ONLY in child Pi processes
 * spawned by `PiSubagentRunner` (sidekick, dreamer, historian, etc.).
 * It registers Magic Context's tool surface for the subagent — nothing
 * else.
 *
 * Why this exists: Magic Context's main entry (`./index.ts`) registers
 * historian, dreamer, transform pipeline, nudges, system-prompt injection,
 * command palette, and agent_end cleanup. Pi child processes now keep extension
 * discovery ON so provider extensions can register models and AFT can register
 * its tools. Recursion is prevented by the child environment instead:
 * `MAGIC_CONTEXT_PI_SUBAGENT=1` makes the full Magic Context entry return before
 * it registers anything. This lean explicit entry is not guarded because it is
 * the only Magic Context code children should run.
 *
 * Loading the full entry in subagents would still be wrong because it would:
 *   1. Wire historian/dreamer/event handlers that can recursively spawn more
 *      subagents.
 *   2. Waste startup time on DB work, resource discovery, and timer wiring.
 *   3. Inject prompt content the subagent prompt doesn't expect (key files,
 *      project docs, user profile, session history, etc.).
 *
 * What this entry registers for `--no-session` children:
 *   - `ctx_search` — read-only search over shared memories/messages/git
 *   - `ctx_memory` — dreamer only; sidekick is retrieval-only and uses ctx_search
 *
 * Session-scoped `ctx_note`/`ctx_expand` stay omitted because hidden child
 * sessions have no useful transcript or parent note id to target.
 *
 * Recursion guard: this entry never wires `pi.on("context", ...)`,
 * `pi.on("before_agent_start", ...)`, or any other event that could
 * trigger historian/dreamer/transform pipelines. Subagents only get the
 * tool surface — that's it.
 *
 * How parent passes this entry to the child:
 *   MAGIC_CONTEXT_PI_SUBAGENT=1 pi --print \
 *     --extension /absolute/path/to/dist/subagent-entry.js \
 *     --tools <agent-specific allow-list> \
 *     [other flags...]
 *
 * Discovery remains enabled. The full Magic Context entry no-ops under the env
 * guard; this explicit lean entry supplies the scoped Magic Context tools; and
 * the per-agent `--tools` allow-list strips every built-in or extension tool not
 * named for that child agent. On an OMP host the allow-list covers built-ins
 * only — OMP appends discovered extension tools to the child registry
 * regardless — so the scoping below is the intended budget, not an enforced
 * sandbox.
 *
 * Tool/action allowlists via Pi flags:
 *   --magic-context-dreamer-actions  Register ctx_memory with the dreamer
 *                                     action surface. Off by default; sidekick
 *                                     receives ctx_search only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import { setStoragePrivatePermissionEnforcement } from "@magic-context/core/shared/storage-permissions";
import { loadPiConfig } from "./config";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { registerMagicContextTools } from "./tools";

const SUBAGENT_DREAMER_ACTIONS_FLAG = "magic-context-dreamer-actions";

let openedDb: ContextDatabase | undefined;

export default function magicContextSubagentExtension(pi: ExtensionAPI): void {
	// Mark this Pi process as a Magic Context subagent in the shared
	// harness state. session-scoped writes from any code path that
	// reaches the shared core will tag rows with harness='pi' the same
	// way the main extension does — but in practice subagents shouldn't
	// be writing session-scoped state at all.
	setHarness("pi");

	pi.registerFlag(SUBAGENT_DREAMER_ACTIONS_FLAG, {
		description:
			"Register ctx_memory with dreamer actions for Magic Context subagents.",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async () => {
		try {
			// Load shared config before opening storage so a trusted-group deployment
			// never has its externally managed permissions re-tightened by a child.
			const directory = process.cwd();
			const { config: cfg, registrationPromptSurface } = loadPiConfig({
				cwd: directory,
			});
			setStoragePrivatePermissionEnforcement(
				cfg.storage.enforce_private_permissions,
			);
			const db = openDatabase();
			if (!db) {
				throw new Error(
					"storage open failed; refusing to start without Magic Context tools",
				);
			}
			openedDb = db;
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const dreamerActionsEnabled =
				pi.getFlag(SUBAGENT_DREAMER_ACTIONS_FLAG) === true;

			registerMagicContextTools(pi, {
				db,
				ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
				resolveProjectIdentity: (ctx) =>
					resolveProjectIdentityForSession(ctx.cwd, cfg.allow_home_project),
				// Sidekick is retrieval-only and consumes untrusted /ctx-aug prompt text,
				// so only dreamer subagents register ctx_memory in child processes.
				memoryToolEnabled: dreamerActionsEnabled,
				allowDreamerActions: dreamerActionsEnabled,
				// `--no-session` children resolve getSessionId() to the ephemeral
				// child session, so session-scoped ctx_note/ctx_expand would write
				// orphaned notes / expand an empty transcript. Drop them; keep ctx_search.
				sessionScopedToolsDisabled: true,
				todowriteEnabled: cfg.todowrite.enabled !== false,
				todowriteCommandEnabled: false,
				promptSurface: registrationPromptSurface,
			});

			log(
				`[pi-subagent] registered tools: ctx_search${dreamerActionsEnabled ? ", ctx_memory" : ""}${cfg.todowrite.enabled !== false ? ", todowrite" : ""}` +
					` (ctx_note/ctx_expand omitted: --no-session child;` +
					` memory=${cfg.memory.enabled}, embedding=${cfg.embedding.provider !== "off"},` +
					` git_commits=${cfg.memory.git_commit_indexing.enabled}, dreamer_actions=${dreamerActionsEnabled})`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log(`[pi-subagent] startup failed: ${message}`);
			process.exitCode = 1;
			throw err;
		}
	});

	pi.on("session_shutdown", () => {
		if (openedDb) {
			try {
				openedDb.close();
			} catch {
				// ignore close errors during shutdown
			}
			openedDb = undefined;
		}
	});
}
