/**
 * Magic Context — Pi coding agent extension.
 *
 * Loaded once per Pi session via `pi.extensions` in package.json. Boots
 * Magic Context's shared SQLite store and registers session lifecycle
 * hooks. Tool registration, message transforms, and historian/dreamer/
 * sidekick wiring follow in later steps.
 *
 * Storage: shares one SQLite database with the OpenCode plugin at
 *   ~/.local/share/cortexkit/magic-context/context.db
 * so project memories, embedding cache, dreamer runs, and other
 * project-scoped state are visible across both harnesses. Session-scoped
 * tables carry a `harness` column ('opencode' or 'pi') so per-session
 * data stays correctly attributed.
 *
 * Config: read from $project/.pi/magic-context.jsonc (project) and
 *   ~/.pi/agent/magic-context.jsonc (user) — Pi convention. Falls back to
 *   defaults when neither file exists.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { openDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildMagicContextBlock } from "./system-prompt";
import { registerMagicContextTools } from "./tools";

const PREFIX = "[magic-context][pi]";

function info(message: string, data?: unknown): void {
	log(`${PREFIX} ${message}`, data);
}

function warn(message: string, data?: unknown): void {
	log(`${PREFIX} WARN ${message}`, data);
}

/** Plugin version from package.json. */
const PLUGIN_VERSION: string = (() => {
	try {
		const req = createRequire(import.meta.url);
		return (req("../package.json") as { version: string }).version;
	} catch {
		return "0.0.0";
	}
})();

/** Lock the harness at module load. Safe to import this file in tests; the
 * lock is idempotent and will throw only on a conflicting reset. */
setHarness("pi");

/**
 * Pi extension default export. Called once per Pi session.
 *
 * The extension registers itself synchronously, opens the shared SQLite
 * store, and hooks shutdown for orderly cleanup. Heavy work (tool
 * registration, transform pipeline, historian/dreamer) is deferred to
 * later steps so the spike can validate the architectural seams in
 * isolation.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
	const storageDir = getMagicContextStorageDir();
	const dbPath = join(storageDir, "context.db");

	let db: ContextDatabase | undefined;
	try {
		db = openDatabase();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		warn(
			`Magic Context (pi) failed to open SQLite store at ${dbPath}: ${message}. ` +
				"Plugin will not register hooks; storage path is unwritable or corrupt.",
		);
		return;
	}

	// Snapshot project identity at boot. Used downstream for memory/
	// embedding scoping. Resolution is cached for the process lifetime, so
	// calling here just primes the cache.
	const projectDir = process.cwd();
	const projectIdentity = resolveProjectIdentity(projectDir);

	info(
		`loaded v${PLUGIN_VERSION} | harness=pi | db=${dbPath} | ` +
			`project=${projectIdentity} | dir=${projectDir}`,
	);

	// Register the agent-facing tools. Reuses the same business logic
	// the OpenCode plugin uses (insertMemory, unifiedSearch, addNote, …)
	// via the shared cortexkit DB. Cross-harness memory sharing is automatic
	// because both plugins resolve the same project identity for the same
	// directory.
	registerMagicContextTools(pi, {
		db,
		// TODO(step 4b): wire to a real config loader. For the spike, ship
		// with the same defaults the OpenCode plugin uses out of the box.
		memoryEnabled: true,
		embeddingEnabled: true,
		gitCommitsEnabled: false,
	});
	info("registered tools: ctx_search, ctx_memory, ctx_note");

	// Inject project memories and dreamer-maintained docs into the system
	// prompt for every agent turn. This is the user-visible "memories show
	// up" behavior — without it, the tools work but the agent has no
	// background context until it explicitly calls ctx_search.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: ctx.cwd,
				memoryEnabled: true,
				injectDocs: true,
			});
			if (!block) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
		} catch (error) {
			warn("failed to build magic-context block:", error);
			return;
		}
	});
	info("registered before_agent_start system prompt injector");

	// Close the shared DB on session shutdown. Other sessions in the same
	// process keep their own handle and are unaffected.
	pi.on("session_shutdown", async () => {
		if (db) {
			closeQuietly(db);
			info("shutdown: SQLite store closed");
		}
	});
}
