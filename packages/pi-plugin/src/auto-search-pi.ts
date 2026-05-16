/**
 * Pi transform-time auto-search hint runner.
 *
 * This is the Pi-shaped counterpart to OpenCode's
 * `auto-search-runner.ts`: when a context event carries a new meaningful
 * user message, run the shared `unifiedSearch()` over the stripped user
 * prompt, build the shared vague-recall hint, and append that hint to the
 * latest user message. The hint is deliberately not inline retrieved data;
 * it nudges the agent to call `ctx_search` for full context if relevant.
 *
 * ## Per-turn cache
 *
 * Pi can re-fire `pi.on("context", ...)` multiple times for the same user
 * turn. We mirror OpenCode's per-session cache (OpenCode lines 33-38,
 * 182-187, 271-272): `sessionId -> { messageId, hint }`. A cached empty
 * hint means “this turn was already evaluated and skipped”; a cached
 * non-empty hint is replayed through the same idempotent append guard. The
 * cache is intentionally process-local and lasts until either a different
 * latest user message id is seen or `clearAutoSearchForPiSession()` is
 * called from Pi session cleanup.
 *
 * ## Timeout
 *
 * The LLM-bound context path must not hang on embedding providers. We use
 * the same 3000ms cap as OpenCode (lines 40-47, 222-229, 239-246). On
 * timeout the `AbortController` is fired so `unifiedSearch()` can cancel
 * the underlying embedding fetch.
 *
 * ## Mutation strategy
 *
 * The function returns an `AgentMessage[]`, but mutates only the targeted
 * latest user message in place. That keeps the standalone API easy for the
 * future integrator: callers can pass Pi's mutable event array and return
 * the same reference. We preserve Pi's existing user-content shape instead
 * of normalizing everything to arrays: string content gets a direct string
 * append; array content appends to the first text block or pushes a new
 * `TextContent` block if the user message is image-only. This avoids
 * changing legacy string messages into array messages solely because a hint
 * was added.
 *
 * ## Idempotency and augmentation stacking
 *
 * Before appending, we check whether the target message already contains
 * the exact hint or any `<ctx-search-hint>` block. Before searching, we
 * skip if raw user text already contains `<sidekick-augmentation>`,
 * `<ctx-search-hint>`, or `<ctx-search-auto>`, matching OpenCode's stacked
 * augmentation guard (lines 106-115, 189-198). Prompt extraction strips
 * Magic Context markers and prior plugin blocks before embedding, matching
 * OpenCode lines 118-143.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import type {
	UnifiedSearchOptions,
	UnifiedSearchResult,
} from "@magic-context/core/features/magic-context/search";
import { unifiedSearch } from "@magic-context/core/features/magic-context/search";
import {
	type AutoSearchHintNoHintReason,
	appendAutoSearchHintDecision,
	getAutoSearchHintDecisions,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { buildAutoSearchHint } from "@magic-context/core/hooks/magic-context/auto-search-hint";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

/**
 * Pi's full AgentMessage union, sourced from the live SDK ContextEvent
 * payload. Using the SDK's type (instead of a re-declared structural alias)
 * keeps this module type-compatible with the rest of the Pi plugin without
 * a per-version maintenance burden — when pi-coding-agent's types shift,
 * we get build errors here at the import site instead of silent runtime
 * mismatches.
 */
export type AgentMessage = ContextEvent["messages"][number];

/**
 * Extract just the `user` variant of AgentMessage so internal helpers
 * can mutate `content` without re-narrowing on every call. Pi's user
 * message carries `string | (TextContent|ImageContent)[]` for content.
 */
type UserMessage = Extract<AgentMessage, { role: "user" }>;

export interface PiAutoSearchOptions {
	enabled: boolean;
	scoreThreshold: number;
	minPromptChars: number;
	projectPath: string;
	visibleMemoryIds?: Set<number> | null;
}

const AUTO_SEARCH_TIMEOUT_MS = 3_000;
const DEFAULT_SCORE_THRESHOLD = 0.55;
const DEFAULT_MIN_PROMPT_CHARS = 20;

async function unifiedSearchWithTimeout(
	db: Database,
	sessionId: string,
	projectPath: string,
	prompt: string,
	options: UnifiedSearchOptions,
	timeoutMs: number,
): Promise<UnifiedSearchResult[] | null> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(null);
		}, timeoutMs);
	});

	try {
		return await Promise.race([
			unifiedSearch(db, sessionId, projectPath, prompt, {
				...options,
				signal: controller.signal,
				// Auto hints are plugin-internal surfacing, not explicit agent
				// retrievals; match OpenCode lines 69-73 and search.ts lines 77-84.
				countRetrievals: false,
			}),
			timeoutPromise,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function collectUserPromptParts(message: UserMessage): string {
	const { content } = message;
	if (typeof content === "string") return content;

	let collected = "";
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			collected += (collected.length > 0 ? "\n" : "") + part.text;
		}
	}
	return collected;
}

function hasStackedAugmentation(rawText: string): boolean {
	return (
		rawText.includes("<sidekick-augmentation>") ||
		rawText.includes("<ctx-search-hint>") ||
		rawText.includes("<ctx-search-auto>")
	);
}

function extractUserPromptText(message: UserMessage): string {
	return (
		collectUserPromptParts(message)
			// Magic Context tag prefix: "§123§ " at any position.
			.replace(/§\d+§\s*/g, "")
			// Temporal awareness gap markers: <!-- +5m -->, <!-- +1w 2d -->, etc.
			.replace(/<!--\s*\+[\d\s.hmdw]+\s*-->/g, "")
			// OMO internal initiator markers and similar HTML-comment markers.
			.replace(/<!--\s*OMO_INTERNAL_INITIATOR[\s\S]*?-->/g, "")
			// System reminders wrapped by OpenCode or magic-context.
			.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
			// Previously-appended plugin tags on this same user turn.
			.replace(/<ctx-search-hint>[\s\S]*?<\/ctx-search-hint>/g, "")
			.replace(/<ctx-search-auto>[\s\S]*?<\/ctx-search-auto>/g, "")
			.replace(/<instruction[^>]*>[\s\S]*?<\/instruction>/g, "")
			.replace(/<sidekick-augmentation>[\s\S]*?<\/sidekick-augmentation>/g, "")
			// Collapse whitespace runs that the strippings may leave behind.
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

function findLatestMeaningfulUserMessage(
	messages: AgentMessage[],
	entryIds: readonly (string | undefined)[],
): { message: UserMessage; messageId: string } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user") continue;
		if (collectUserPromptParts(msg).trim().length === 0) continue;

		const messageId = entryIds[i];
		if (typeof messageId === "string") return { message: msg, messageId };
		return null;
	}

	return null;
}

function appendHintToUserMessage(message: UserMessage, hint: string): boolean {
	if (hint.length === 0) return false;

	const rawText = collectUserPromptParts(message);
	if (rawText.includes(hint) || rawText.includes("<ctx-search-hint>")) {
		return false;
	}

	if (typeof message.content === "string") {
		message.content += hint;
		return true;
	}

	const firstTextIndex = message.content.findIndex(
		(part) => part.type === "text",
	);
	if (firstTextIndex >= 0) {
		const part = message.content[firstTextIndex];
		if (part?.type !== "text") return false;
		message.content[firstTextIndex] = { ...part, text: part.text + hint };
		return true;
	}

	message.content.push({ type: "text", text: hint.trimStart() });
	return true;
}

/**
 * Run Pi auto-search hinting against the latest meaningful user message.
 *
 * The returned array is the same mutable array received in `args.messages`;
 * callers should still return it to Pi so the API shape remains compatible
 * if this implementation later switches to copy-on-write.
 */
export async function runAutoSearchHintForPi(args: {
	sessionId: string;
	db: Database;
	messages: AgentMessage[];
	entryIds?: readonly (string | undefined)[] | null;
	options: PiAutoSearchOptions;
}): Promise<AgentMessage[]> {
	const { sessionId, db, messages, options } = args;
	const entryIds =
		args.entryIds === undefined
			? messages.map((message, index) => {
					const timestamp = (message as { timestamp?: unknown }).timestamp;
					return `test-entry-${index}:${typeof timestamp === "number" ? timestamp : "no-ts"}`;
				})
			: args.entryIds;
	if (!options.enabled) return messages;
	if (entryIds === null) {
		sessionLog(
			sessionId,
			"Pi auto-search: strict entry-id resolution failed; skipping fresh decision",
		);
		return messages;
	}

	const found = findLatestMeaningfulUserMessage(messages, entryIds);
	if (found === null) return messages;

	const { message: userMsg, messageId: userMsgId } = found;
	const existing = getAutoSearchHintDecisions(db, sessionId);
	const existingForMessage = existing.find(
		(decision) => decision.messageId === userMsgId,
	);
	if (existingForMessage) {
		if (existingForMessage.decision === "hint") {
			appendHintToUserMessage(userMsg, existingForMessage.text);
		}
		return messages;
	}

	const writeNoHintAndReconcile = (
		reason: AutoSearchHintNoHintReason,
	): void => {
		const outcome = appendAutoSearchHintDecision(db, sessionId, {
			messageId: userMsgId,
			decision: "no-hint",
			reason,
		});
		if (!outcome.ok) return;
		if (
			outcome.kind === "already-present" &&
			outcome.decision.decision === "hint"
		) {
			appendHintToUserMessage(userMsg, outcome.decision.text);
		}
	};

	// Suppression check runs on raw text before stripping; OpenCode does the
	// same at lines 189-198 because stripping removes the signal tags.
	const rawPartsText = collectUserPromptParts(userMsg);
	if (hasStackedAugmentation(rawPartsText)) {
		sessionLog(
			sessionId,
			"auto-search: skipping — user message already carries augmentation/hint",
		);
		writeNoHintAndReconcile("stacked");
		return messages;
	}

	const rawPrompt = extractUserPromptText(userMsg);
	const minPromptChars = options.minPromptChars ?? DEFAULT_MIN_PROMPT_CHARS;
	if (rawPrompt.length < minPromptChars) {
		writeNoHintAndReconcile("too-short");
		return messages;
	}

	let results: UnifiedSearchResult[] | null;
	try {
		const snapshot = getProjectEmbeddingSnapshot(options.projectPath);
		const memoryEnabled = snapshot?.features.memoryEnabled ?? true;
		const embeddingEnabled = snapshot
			? snapshot.enabled || snapshot.gitCommitEnabled
			: true;
		const gitCommitsEnabled = snapshot?.gitCommitEnabled ?? false;
		const searchOptions: UnifiedSearchOptions = {
			limit: 10,
			memoryEnabled,
			embeddingEnabled,
			gitCommitsEnabled,
			embedQuery: async (text, signal) => {
				const result = await embedTextForProject(
					options.projectPath,
					text,
					signal,
				);
				return result?.vector ?? null;
			},
			isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
			visibleMemoryIds: options.visibleMemoryIds ?? null,
		};
		results = await unifiedSearchWithTimeout(
			db,
			sessionId,
			options.projectPath,
			rawPrompt,
			searchOptions,
			AUTO_SEARCH_TIMEOUT_MS,
		);
	} catch (error) {
		log(
			`[auto-search] unified search failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		writeNoHintAndReconcile("error");
		return messages;
	}

	if (results === null) {
		sessionLog(
			sessionId,
			`auto-search: timed out after ${AUTO_SEARCH_TIMEOUT_MS}ms, skipping hint for this turn`,
		);
		writeNoHintAndReconcile("timeout");
		return messages;
	}

	if (results.length === 0) {
		writeNoHintAndReconcile("empty");
		return messages;
	}

	const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
	if (results[0].score < scoreThreshold) {
		sessionLog(
			sessionId,
			`auto-search: top score ${results[0].score.toFixed(3)} below threshold ${scoreThreshold}`,
		);
		writeNoHintAndReconcile("below-threshold");
		return messages;
	}

	const hintText = buildAutoSearchHint(results);
	if (!hintText) {
		writeNoHintAndReconcile("empty");
		return messages;
	}

	// Prefix with double newline so the hint is a separate block, matching
	// OpenCode lines 268-270.
	const payload = `\n\n${hintText}`;
	const outcome = appendAutoSearchHintDecision(db, sessionId, {
		messageId: userMsgId,
		decision: "hint",
		text: payload,
	});
	if (!outcome.ok) return messages;
	if (outcome.decision.decision === "hint") {
		appendHintToUserMessage(userMsg, outcome.decision.text);
	}
	sessionLog(
		sessionId,
		`auto-search: attached hint to ${userMsgId} (${results.length} fragments, top score ${results[0].score.toFixed(3)})`,
	);

	return messages;
}

/**
 * Session cleanup hook. Call from Pi's session shutdown/delete lifecycle to
 * release the per-turn cache entry for that session.
 */
export function clearAutoSearchForPiSession(_sessionId: string): void {
	// Auto-search decisions live in session_meta and are cleared by clearSession().
}
