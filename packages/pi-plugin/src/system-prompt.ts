/**
 * Pi-side system prompt injector.
 *
 * Hooks `before_agent_start` to append a `<magic-context>` block to the
 * fully-assembled system prompt. The block carries:
 *
 *   - `<project-docs>`: dreamer-maintained ARCHITECTURE.md and STRUCTURE.md
 *     from the project root (when `dreamer.inject_docs` is true)
 *   - `<user-profile>`: stable user memories promoted by dreamer
 *     (when `dreamer.user_memories.enabled` is true)
 *   - `<key-files>`: pinned file content selected by dreamer based on
 *     read patterns (when `dreamer.pin_key_files.enabled` is true), with
 *     a token budget and path-traversal guards.
 *
 * # What does NOT go here
 *
 * - `<session-history>`: injected into message[0] by `injectSessionHistoryIntoPi`
 *   from `pi.on("context", ...)`. That path can also trim already-
 *   compartmentalized raw history out of the message array, which the
 *   system-prompt path can't.
 *
 * - `<project-memory>`: project-scoped memories live INSIDE
 *   `<session-history>` (via `buildCompartmentBlock`). Putting them
 *   in the system prompt too would duplicate them on the wire.
 *
 * # Cache stability
 *
 * Pi sessions hit ANY LLM provider, and every major provider has
 * prompt/prefix cache (Anthropic prompt cache, OpenAI/Codex automatic
 * prefix cache, etc.). The system prompt is the front of the cached
 * prefix, so even small drift between turns busts the entire cache and
 * the user pays full input price for the next call.
 *
 * Mitigations mirrored from OpenCode's `experimental.chat.system.transform`:
 *
 *   1. Sticky date: the live system prompt contains a `Today's date: ...`
 *      line that flips at midnight. We freeze the first observed date
 *      and replace any later drift with the frozen value, UNLESS this
 *      turn is already cache-busting for another reason (signaled via
 *      `systemPromptRefreshSessions`).
 *
 *   2. Per-session adjunct caching: `<project-docs>`, `<user-profile>`,
 *      and `<key-files>` are computed once per session and reused on
 *      every subsequent turn. Only refreshed when the session is in
 *      `systemPromptRefreshSessions` (i.e. dreamer published new docs,
 *      user memories were promoted, key files changed, /ctx-flush, or
 *      hash-change detection on this very turn).
 *
 *   3. Hash detection: we MD5 the assembled system prompt and compare
 *      to `session_meta.system_prompt_hash`. On change we signal all
 *      three downstream sets (`historyRefreshSessions`,
 *      `systemPromptRefreshSessions`, `pendingMaterializationSessions`)
 *      so the very next `pi.on("context")` event rebuilds the
 *      `<session-history>` injection cache, refreshes adjuncts, and
 *      lets queued ops materialize. Mirrors
 *      `system-prompt-hash.ts:399-411` in the OpenCode plugin.
 *
 * Cross-harness memory sharing: a memory written from OpenCode in this
 * project shows up in Pi context — through both message[0]
 * `<session-history>` and the `<user-profile>` block when its
 * underlying user memories table updates.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMagicContextSection } from "@magic-context/core/agents/magic-context-prompt";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getActiveUserMemories } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	clearKeyFilesCacheForSession,
	readVersionedKeyFiles,
} from "@magic-context/core/hooks/magic-context/key-files-block";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { log, sessionLog } from "@magic-context/core/shared/logger";

const PROJECT_DOCS_MARKER = "<project-docs>";
const USER_PROFILE_MARKER = "<user-profile>";
const MAGIC_CONTEXT_MARKER = "## Magic Context";

/**
 * Per-session adjunct caches. Module-scoped so `clearPiSystemPromptSession`
 * (registered on Pi `session_shutdown`) can release entries when a session
 * ends. Without cleanup these maps would accumulate one entry per Pi
 * session over the lifetime of the plugin process.
 */
const stickyDateBySession = new Map<string, string>();
const cachedDocsBySession = new Map<string, string | null>();
const cachedUserProfileBySession = new Map<string, string | null>();

const DOC_FILES = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;

/** Read project docs from `directory`. Returns the assembled XML block or null. */
function readProjectDocs(directory: string): string | null {
	const sections: string[] = [];
	for (const filename of DOC_FILES) {
		const filePath = join(directory, filename);
		try {
			if (existsSync(filePath)) {
				const content = readFileSync(filePath, "utf-8").trim();
				if (content.length > 0) {
					sections.push(`<${filename}>\n${content}\n</${filename}>`);
				}
			}
		} catch (error) {
			log(`[magic-context-pi] failed to read ${filename}:`, error);
		}
	}
	if (sections.length === 0) return null;
	return `${PROJECT_DOCS_MARKER}\n${sections.join("\n\n")}\n</project-docs>`;
}

/**
 * Read the active stable user memories from the shared store and render them
 * as a `<user-profile>` XML block. Mirrors OpenCode's Step 1.6 in
 * `system-prompt-hash.ts:228-251`. Each line becomes a `- ${content}` bullet
 * — same shape so dreamer's user-memory pipeline is harness-agnostic.
 */
function buildUserProfileBlock(db: ContextDatabase): string | null {
	const memories = getActiveUserMemories(db);
	if (memories.length === 0) return null;
	const items = memories.map((m) => `- ${m.content}`).join("\n");
	return `${USER_PROFILE_MARKER}\n${items}\n</user-profile>`;
}

export interface BuildMagicContextBlockOptions {
	db: ContextDatabase;
	cwd: string;
	/**
	 * When provided and the user-profile / key-files features are
	 * enabled, the rendered blocks scope to this session (only
	 * `<key-files>` is per-session; `<user-profile>` is global). Pass
	 * undefined to skip session-scoped adjuncts (typically when no
	 * session is active yet).
	 */
	sessionId?: string;
	/** Reserved for future use; currently unused since project memories
	 *  live in `<session-history>` (message[0]), not in the system prompt. */
	memoryEnabled: boolean;
	/** When true, include `<project-docs>` (reads ARCHITECTURE.md / STRUCTURE.md from cwd). */
	injectDocs: boolean;
	/** Reserved for future use. */
	memoryBudgetChars?: number;
	/**
	 * When true (default), prepend the `## Magic Context` guidance section
	 * that explains `§N§` tags, `ctx_*` tools, history caveats, etc.
	 */
	includeGuidance?: boolean;
	/** `protected_tags` from config — passed through to guidance. */
	protectedTags?: number;
	/** When true, include `ctx_reduce` guidance; when false, the no-reduce variant. */
	ctxReduceEnabled?: boolean;
	/** When true, include smart-note guidance (Dreamer evaluates surface_condition). */
	dreamerEnabled?: boolean;
	/** When true, omit older tool-call structure caveat from guidance. */
	dropToolStructure?: boolean;
	/** When true, include temporal-awareness guidance. */
	temporalAwarenessEnabled?: boolean;
	/** When true, inject the "BEWARE: history compression is on" warning. */
	cavemanTextCompressionEnabled?: boolean;
	/** When true, render `<user-profile>` from active stable user memories. */
	userMemoriesEnabled?: boolean;
	/** When true, render `<key-files>` for the active session's pinned files. */
	pinKeyFilesEnabled?: boolean;
	/** Token budget for `<key-files>` content (default: 10000). */
	pinKeyFilesTokenBudget?: number;
	/**
	 * When true, this turn is already busting the prefix cache (the system
	 * prompt hash changed last turn, dreamer just published new docs,
	 * user memories were promoted, /ctx-flush ran, etc.). When true,
	 * cached adjunct values are dropped and re-read from disk / DB. When
	 * false, the cached value (or first-time read on miss) is reused.
	 *
	 * Cache miss on a non-cache-busting turn — i.e. first time we ever
	 * see this session — also forces a fresh read; only repeated turns
	 * with stable session identity reuse the cache.
	 */
	isCacheBusting?: boolean;
}

/**
 * Build the `<magic-context>...</magic-context>` block to append to the
 * system prompt for one Pi agent turn. Returns null if there's nothing to
 * inject.
 *
 * Block ordering matches OpenCode's `system-prompt-hash.ts`:
 *   1. `## Magic Context` guidance (always emitted when `includeGuidance`)
 *   2. `<project-docs>`
 *   3. `<user-profile>`
 *   4. `<key-files>`
 *
 * `<session-history>` and `<project-memory>` live in message[0], not here.
 */
export function buildMagicContextBlock(
	opts: BuildMagicContextBlockOptions,
): string | null {
	const sections: string[] = [];
	const sessionId = opts.sessionId;
	const isCacheBusting = opts.isCacheBusting ?? false;

	// 1. Project docs (ARCHITECTURE.md / STRUCTURE.md from the project root).
	if (opts.injectDocs) {
		const docsBlock = readCachedAdjunct({
			cache: cachedDocsBySession,
			sessionId,
			isCacheBusting,
			compute: () => readProjectDocs(opts.cwd),
			describe: "project docs",
		});
		if (docsBlock) sections.push(docsBlock);
	}

	// 2. Stable user memories as <user-profile>.
	if (opts.userMemoriesEnabled) {
		const profileBlock = readCachedAdjunct({
			cache: cachedUserProfileBySession,
			sessionId,
			isCacheBusting,
			compute: () => buildUserProfileBlock(opts.db),
			describe: "user profile",
		});
		if (profileBlock) sections.push(profileBlock);
	}

	// 3. Pinned key files as <key-files>.
	if (opts.pinKeyFilesEnabled && sessionId) {
		let sessionMeta:
			| import("@magic-context/core/features/magic-context/types").SessionMeta
			| null = null;
		try {
			sessionMeta = getOrCreateSessionMeta(opts.db, sessionId);
		} catch (error) {
			sessionLog(sessionId, "Pi key-files session meta load failed:", error);
		}
		const keyFilesBlock = sessionMeta
			? readVersionedKeyFiles({
					db: opts.db,
					sessionId,
					sessionMeta,
					directory: opts.cwd,
					isCacheBusting,
					config: {
						enabled: opts.pinKeyFilesEnabled,
						tokenBudget: opts.pinKeyFilesTokenBudget ?? 10_000,
					},
				})
			: null;
		if (keyFilesBlock) sections.push(keyFilesBlock);
	}

	const dataBlock =
		sections.length > 0
			? `<magic-context>\n${sections.join("\n\n")}\n</magic-context>`
			: null;

	const includeGuidance = opts.includeGuidance ?? true;
	if (!includeGuidance) {
		return dataBlock;
	}

	const guidance = buildMagicContextSection(
		null,
		opts.protectedTags ?? 20,
		opts.ctxReduceEnabled ?? true,
		opts.dreamerEnabled ?? false,
		opts.dropToolStructure ?? true,
		opts.temporalAwarenessEnabled ?? false,
		opts.cavemanTextCompressionEnabled ?? false,
	);

	if (dataBlock) {
		return `${guidance}\n\n${dataBlock}`;
	}
	return guidance;
}

/**
 * Get an adjunct from a per-session cache, recomputing on first access or
 * when this turn is already busting cache. Returns null when the
 * compute function returns null and caches that null result so we don't
 * hit the disk/DB on every subsequent turn for a session that has no
 * docs / memories / key files.
 */
function readCachedAdjunct(args: {
	cache: Map<string, string | null>;
	sessionId: string | undefined;
	isCacheBusting: boolean;
	compute: () => string | null;
	describe: string;
}): string | null {
	const { cache, sessionId, isCacheBusting, compute, describe } = args;
	if (!sessionId) {
		// No session id yet (first context event before sessionManager
		// is ready). Compute once but don't cache — the next turn with
		// a real session id will populate the cache.
		return compute();
	}

	const hasCached = cache.has(sessionId);
	if (!hasCached || isCacheBusting) {
		const value = compute();
		cache.set(sessionId, value);
		if (value && !hasCached) {
			sessionLog(sessionId, `loaded ${describe} (${value.length} chars)`);
		} else if (value && isCacheBusting) {
			sessionLog(sessionId, `refreshed ${describe} (cache-busting pass)`);
		}
		return value;
	}
	return cache.get(sessionId) ?? null;
}

/**
 * Apply the sticky-date freeze and detect system-prompt hash changes.
 *
 * Returns the (possibly date-frozen) system prompt to use on this turn,
 * along with whether a hash change was detected. The caller is
 * responsible for emitting downstream signals on hash change.
 *
 * Mirrors OpenCode's Step 2 + Step 3 in `system-prompt-hash.ts:345-417`.
 */
export interface SystemPromptHashResult {
	/** The system prompt to send to the LLM, possibly with date frozen. */
	systemPrompt: string;
	/** Whether the prompt content (ignoring any frozen-date replacement) changed vs persisted hash. */
	hashChanged: boolean;
	/** The new hash, persisted to session_meta.system_prompt_hash. */
	currentHash: string;
}

const DATE_PATTERN = /Today's date: .+/;

/**
 * Process the assembled system prompt for cache stability:
 *
 *  1. Detect hash change vs persisted `session_meta.system_prompt_hash`.
 *     If changed, the prefix cache is already busted on this turn — we
 *     return `hashChanged=true` so the caller can signal downstream
 *     refresh sets and let the rest of the pipeline rebuild.
 *
 *  2. Freeze `Today's date: ...` to the first observed value, UNLESS
 *     this turn is already cache-busting (either the caller flagged
 *     it via `isCacheBusting` OR we just detected a hash change). On a
 *     real cache-busting turn we update the sticky date to the live
 *     value so future stable turns freeze on the new date.
 */
export function processSystemPromptForCache(args: {
	db: ContextDatabase;
	sessionId: string;
	systemPrompt: string;
	/** When true, the caller has already determined this turn is busting cache. */
	isCacheBusting: boolean;
}): SystemPromptHashResult {
	const { db, sessionId, systemPrompt, isCacheBusting } = args;

	// Step 1: hash detection vs persisted value.
	let sessionMeta:
		| import("@magic-context/core/features/magic-context/types").SessionMeta
		| undefined;
	try {
		sessionMeta = getOrCreateSessionMeta(db, sessionId);
	} catch (error) {
		sessionLog(
			sessionId,
			"system-prompt-hash session meta load failed:",
			error,
		);
	}

	// Hash the prompt BEFORE date freezing — we want to detect content
	// changes that aren't just the date flipping at midnight. (Date
	// drift will not cause a hash change because we apply freezing
	// in step 2 below; the persisted hash is over the FROZEN prompt.)
	const previousHash = sessionMeta?.systemPromptHash ?? "";
	const isFirstHash = previousHash === "" || previousHash === "0";

	// Step 2: sticky-date freeze.
	let frozenPrompt = systemPrompt;
	const dateMatch = systemPrompt.match(DATE_PATTERN);
	const liveDate = dateMatch ? dateMatch[0] : null;
	const stickyDate = stickyDateBySession.get(sessionId);

	if (liveDate && !stickyDate) {
		// First time seeing this session — store the date. Persisted
		// prompt will use the live date.
		stickyDateBySession.set(sessionId, liveDate);
	} else if (liveDate && stickyDate && liveDate !== stickyDate) {
		if (isCacheBusting) {
			// Already busting cache — adopt the live date so future
			// stable turns freeze on it.
			stickyDateBySession.set(sessionId, liveDate);
			sessionLog(
				sessionId,
				`system prompt date updated: ${stickyDate} → ${liveDate} (cache-busting pass)`,
			);
		} else {
			// Defer-equivalent turn — replace the live date with the
			// frozen one so the prefix cache survives.
			frozenPrompt = systemPrompt.replace(DATE_PATTERN, stickyDate);
			sessionLog(
				sessionId,
				`system prompt date frozen: real=${liveDate}, using=${stickyDate} (cache-stable pass)`,
			);
		}
	}

	// Hash the (possibly date-frozen) prompt — this matches what the
	// LLM provider sees and what the cache prefix is keyed on.
	const currentHash = createHash("md5").update(frozenPrompt).digest("hex");
	const hashChanged = !isFirstHash && currentHash !== previousHash;

	if (hashChanged) {
		sessionLog(
			sessionId,
			`system prompt hash changed: ${previousHash} → ${currentHash} (len=${frozenPrompt.length})`,
		);
	} else if (isFirstHash) {
		sessionLog(
			sessionId,
			`system prompt hash initialized: ${currentHash} (len=${frozenPrompt.length})`,
		);
	}

	// Persist hash + token estimate so dashboard / status surfaces are
	// up-to-date and the next turn can compare against this value.
	const systemPromptTokens = estimateTokens(frozenPrompt);
	if (sessionMeta) {
		if (currentHash !== previousHash) {
			updateSessionMeta(db, sessionId, {
				systemPromptHash: currentHash,
				systemPromptTokens,
			});
		} else if (
			Math.abs(sessionMeta.systemPromptTokens - systemPromptTokens) > 50
		) {
			updateSessionMeta(db, sessionId, { systemPromptTokens });
		}
	}

	return {
		systemPrompt: frozenPrompt,
		hashChanged,
		currentHash,
	};
}

/**
 * Clear all per-session caches the system-prompt path maintains. Called
 * from Pi `session_shutdown` so caches don't accumulate over plugin
 * lifetime for ended sessions.
 */
export function clearPiSystemPromptSession(sessionId: string): void {
	stickyDateBySession.delete(sessionId);
	cachedDocsBySession.delete(sessionId);
	cachedUserProfileBySession.delete(sessionId);
	clearKeyFilesCacheForSession(sessionId);
}

/** Test-only: confirm the magic-context guidance marker is present. */
export const MAGIC_CONTEXT_GUIDANCE_MARKER = MAGIC_CONTEXT_MARKER;
