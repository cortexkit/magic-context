/**
 * Pi-side system prompt injector helpers.
 *
 * v2 cache architecture keeps only stable instructions in the Pi system
 * prompt: Magic Context guidance and Pi/OpenCode's existing "Today's date"
 * line (sticky-frozen by processSystemPromptForCache). Project docs,
 * user profile, key files, memories, facts, and compartments are rendered
 * by the m[0]/m[1] message materializer instead.
 */

import { buildMagicContextSection } from "@magic-context/core/agents/magic-context-prompt";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { systemPromptDates } from "@magic-context/core/hooks/magic-context/system-prompt-dates";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { PromptSurfacePreset } from "@magic-context/core/shared/prompt-surface";
import { systemPromptFingerprint } from "@magic-context/core/shared/prompt-surface-runtime";
import { clearPiSystemPromptDelivery } from "./system-prompt-delivery-pi";

const PROJECT_DOCS_MARKER = "<project-docs>";
const USER_PROFILE_MARKER = "<user-profile>";

const MAGIC_CONTEXT_MARKER = "## Magic Context";

/**
 * Sticky date cache. Module-scoped so clearPiSystemPromptSession can release
 * entries when Pi shuts down or switches sessions.
 */
const stickyDateBySessionDefault = new Map<string, string>();

export interface BuildMagicContextBlockOptions {
	db: ContextDatabase;
	cwd: string;
	sessionId?: string;
	/** Reserved for compatibility; project memories now live in m[0]/m[1]. */
	memoryEnabled: boolean;
	memoryBudgetChars?: number;
	/** When true (default), emit the `## Magic Context` guidance section. */
	includeGuidance?: boolean;
	protectedTags?: number;
	ctxReduceCallable?: boolean;
	dreamerEnabled?: boolean;
	smartNotesEnabled?: boolean;
	temporalAwarenessEnabled?: boolean;
	cavemanTextCompressionEnabled?: boolean;
	language?: string;
	promptSurfacePreset?: PromptSurfacePreset;
	primaryGuidanceOverride?: string;
	/** Reserved for compatibility; user profile now lives in m[0]. */
	userMemoriesEnabled?: boolean;
	existingSystemPrompt?: string;
	isCacheBusting?: boolean;
}

/**
 * Build the Pi system-prompt addendum. In v2 this intentionally contains
 * guidance only. The volatile/data-bearing blocks moved to m[0]/m[1], so
 * this function must never emit `<project-docs>` or `<user-profile>` even when
 * legacy options are true.
 */
export function buildMagicContextBlock(
	opts: BuildMagicContextBlockOptions,
): string | null {
	const existing = opts.existingSystemPrompt ?? "";
	const includeGuidance =
		(opts.includeGuidance ?? true) && !existing.includes(MAGIC_CONTEXT_MARKER);
	if (!includeGuidance) return null;

	return buildMagicContextSection(
		null,
		opts.protectedTags ?? 20,
		opts.ctxReduceCallable ?? true,
		opts.dreamerEnabled ?? false,
		opts.temporalAwarenessEnabled ?? false,
		opts.cavemanTextCompressionEnabled ?? false,
		false,
		opts.language,
		// Drop ctx_memory guidance when memory is off (the tool is gated via
		// registerMagicContextTools memoryToolEnabled). ctx_search guidance stays.
		opts.memoryEnabled !== false,
		opts.promptSurfacePreset,
		opts.primaryGuidanceOverride,
		opts.smartNotesEnabled,
	);
}

export function composeMagicContextSystemPrompt(
	basePrompt: string,
	block: string | null,
): string {
	return block ? `${basePrompt}\n\n${block}` : basePrompt;
}

export interface SystemPromptHashResult {
	/** The system prompt to send to the LLM, possibly with date frozen. */
	systemPrompt: string;
	/** Whether prompt content or prompt-surface preset changed vs the persisted hash. */
	hashChanged: boolean;
	/** The new content + prompt-surface preset hash persisted to session_meta. */
	currentHash: string;
}

/**
 * Process the assembled system prompt for cache stability:
 *
 *  1. Detect content or prompt-surface preset change vs the persisted
 *     `session_meta.system_prompt_hash`. The transition marks the semantic
 *     prompt epoch boundary, so we return `hashChanged=true` and let the caller
 *     signal downstream refresh sets.
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
	promptSurfacePreset?: PromptSurfacePreset;
	/** Bridge instances own their date state rather than sharing standalone sessions. */
	stickyDates?: Map<string, string>;
}): SystemPromptHashResult {
	const { db, sessionId, systemPrompt, isCacheBusting } = args;
	const stickyDateBySession = args.stickyDates ?? stickyDateBySessionDefault;

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

	const previousHash = sessionMeta?.systemPromptHash ?? "";
	const isFirstHash = previousHash === "" || previousHash === "0";

	// Decide whether content or preset already requires a bust before choosing
	// which date to hash. This lets a midnight date change ride the same fold.
	let frozenPrompt = systemPrompt;
	if (isFirstHash) stickyDateBySession.delete(sessionId);
	const stickyDate = stickyDateBySession.get(sessionId);
	const dates = systemPromptDates(systemPrompt, stickyDate);
	const liveDate = dates.live;
	const stableCandidate = dates.stable;
	const stableCandidateHash = systemPromptFingerprint(
		stableCandidate,
		args.promptSurfacePreset,
	);
	const contentOrPresetChanged =
		!isFirstHash && stableCandidateHash !== previousHash;
	// An expired provider cache is not a reason to move the date: the provider
	// only forgot its cache, and a moved date would rewrite the bytes in front
	// of the whole conversation (and of any signed thinking it carries). The
	// date waits for a real rebuild, as on a warm cache.
	const dateMayAdvance = isCacheBusting || contentOrPresetChanged;

	if (liveDate && !stickyDate) {
		stickyDateBySession.set(sessionId, liveDate);
	} else if (liveDate && stickyDate && liveDate !== stickyDate) {
		if (dateMayAdvance) {
			stickyDateBySession.set(sessionId, liveDate);
			sessionLog(
				sessionId,
				`system prompt date updated: ${stickyDate} → ${liveDate} (cache-busting pass)`,
			);
		} else {
			frozenPrompt = stableCandidate;
			sessionLog(
				sessionId,
				`system prompt date frozen: real=${liveDate}, using=${stickyDate} (cache-stable pass)`,
			);
		}
	}

	const currentHash = systemPromptFingerprint(
		frozenPrompt,
		args.promptSurfacePreset,
	);
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
 * Clear per-session system prompt cache state. Data-block caches are no
 * longer owned by this file; m[0]/m[1] caches are cleared by the lifecycle
 * handlers in context-handler/index.
 */
export function clearPiSystemPromptSession(sessionId: string): void {
	clearPiSystemPromptDelivery(sessionId);
	stickyDateBySessionDefault.delete(sessionId);
}

/** Test-only markers for system-prompt parity assertions. */
export const MAGIC_CONTEXT_GUIDANCE_MARKER = MAGIC_CONTEXT_MARKER;
export const SYSTEM_PROMPT_DATA_MARKERS = {
	projectDocs: PROJECT_DOCS_MARKER,
	userProfile: USER_PROFILE_MARKER,
} as const;
