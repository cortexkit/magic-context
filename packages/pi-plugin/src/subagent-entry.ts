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
 * Recursion guard: this entry never starts historian/dreamer/transform
 * pipelines. Its context hook only refuses provider calls after failed startup;
 * healthy children get the tool surface without context rewriting.
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
import { resolvePiHarnessKind } from "./pi-harness-kind";
import { reportSubagentStartupError } from "./subagent-startup";
import { registerMagicContextTools } from "./tools";

const SUBAGENT_DREAMER_ACTIONS_FLAG = "magic-context-dreamer-actions";

let openedDb: ContextDatabase | undefined;

export default function magicContextSubagentExtension(pi: ExtensionAPI): void {
	let startupComplete = false;
	let startupError: string | undefined;
	let failureReported = false;
	const reportStartupFailure = async () => {
		if (failureReported) return;
		failureReported = true;
		await reportSubagentStartupError(
			startupError ?? "Magic Context child startup did not complete",
		);
	};
	// Hosts can swallow session_start exceptions and overwrite process.exitCode.
	// Context is awaited before provider calls on both Pi and OMP; exit here so a
	// failed child cannot spend a model turn without its required tools.
	pi.on("context", async () => {
		if (startupComplete) return;
		try {
			await reportStartupFailure();
		} finally {
			process.exit(1);
		}
	});
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
	if (budgetGuardFile) {
		pi.on("tool_call", () => {
			try {
				if (readFileSync(budgetGuardFile, "utf8") === "finalize") {
					return { block: true, reason: TOKEN_BUDGET_TOOL_REFUSAL };
				}
			} catch {
				return { block: true, reason: TOKEN_BUDGET_TOOL_REFUSAL };
			}
			return undefined;
		});
	}

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
			startupComplete = true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			startupError = `Magic Context child startup failed: ${message}`;
			log(`[pi-subagent] startup failed: ${message}`);
			process.exitCode = 1;
			await reportStartupFailure();
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
