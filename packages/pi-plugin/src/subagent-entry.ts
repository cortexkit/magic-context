/**
 * Magic Context — Pi subagent extension entry.
 *
 * This is a lean extension entry loaded ONLY in child Pi processes
 * spawned by `PiSubagentRunner` (dreamer, historian, etc.).
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
 *   - `ctx_memory` — dreamer only
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
 * guard and this explicit lean entry supplies scoped Magic Context tools. Pi
 * applies the per-agent `--tools` list to the complete registry. OMP's CLI only
 * gates built-ins; the child startup extension selects its complete active list
 * through setActiveTools after extension tools have registered.
 *
 * Tool/action allowlists via Pi flags:
 *   --magic-context-dreamer-actions  Register ctx_memory with the dreamer
 *                                     action surface. Off by default.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOKEN_BUDGET_TOOL_REFUSAL } from "@magic-context/core/features/magic-context/dreamer/token-budget";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import { setStoragePrivatePermissionEnforcement } from "@magic-context/core/shared/storage-permissions";
import { loadPiConfig } from "./config";
import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { OMP_RETAINED_NO_TOOLS_ENV } from "./omp-retained-rpc";
import { resolvePiHarnessKind } from "./pi-harness-kind";
import { registerMagicContextTools } from "./tools";

const SUBAGENT_DREAMER_ACTIONS_FLAG = "magic-context-dreamer-actions";

let openedDb: ContextDatabase | undefined;

export default function magicContextSubagentExtension(pi: ExtensionAPI): void {
	// Keep any unexpected session-scoped child write attributed to its actual
	// Pi-compatible host, even though hidden children normally avoid those writes.
	setHarness(resolvePiHarnessKind());

	pi.registerFlag(SUBAGENT_DREAMER_ACTIONS_FLAG, {
		description:
			"Register ctx_memory with dreamer actions for Magic Context subagents.",
		type: "boolean",
		default: false,
	});

	const budgetGuardFile = process.env.MAGIC_CONTEXT_SUBAGENT_BUDGET_GUARD_FILE;
	const toolFreeRetainedOmp = process.env[OMP_RETAINED_NO_TOOLS_ENV] === "1";
	if (budgetGuardFile || toolFreeRetainedOmp) {
		pi.on("tool_call", () => {
			try {
				if (budgetGuardFile) {
					if (readFileSync(budgetGuardFile, "utf8") === "finalize") {
						return { block: true, reason: TOKEN_BUDGET_TOOL_REFUSAL };
					}
				}
			} catch {
				return { block: true, reason: TOKEN_BUDGET_TOOL_REFUSAL };
			}
			if (toolFreeRetainedOmp)
				return {
					block: true,
					reason: "Retained historian RPC children have no tools",
				};
			return undefined;
		});
	}
	// Registration itself is forbidden, not merely execution after the budget ends.
	// Ordinary OMP print children and plain Pi keep their existing registration policy.
	if (toolFreeRetainedOmp) return;

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
				rerankConnectionFile: cfg.subc?.connection_file,
				rerankConfig: cfg.rerank,
				db,
				ensureProjectRegistered: ensureProjectRegisteredFromPiDirectory,
				resolveProjectIdentity: (ctx) =>
					resolveProjectIdentityForSession(ctx.cwd, cfg.allow_home_project),
				memoryToolEnabled: dreamerActionsEnabled,
				allowDreamerActions: dreamerActionsEnabled,
				// `--no-session` children resolve getSessionId() to the ephemeral
				// child session, so session-scoped ctx_note/ctx_expand would write
				// orphaned notes / expand an empty transcript. Drop them; keep ctx_search.
				sessionScopedToolsDisabled: true,
				todowriteEnabled: cfg.todowrite.enabled,
				todowriteCommandEnabled: false,
				promptSurface: registrationPromptSurface,
			});

			log(
				`[pi-subagent] registered tools: ctx_search${dreamerActionsEnabled ? ", ctx_memory" : ""}${cfg.todowrite.enabled ? ", todowrite" : ""}` +
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
