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
 * ## Per-turn decisions
 *
 * Pi can re-fire `pi.on("context", ...)` for the same user turn. Decisions
 * are persisted by session and entry ID, and concurrent callers share one
 * reader-worker search. Replaying a persisted hint restores the same bytes;
 * a timed-out or cold/unregistered turn stays skipped on later passes.
 * Session cleanup cancels pending work without deleting persisted decisions.
 *
 * ## Timeout
 *
 * The LLM-bound context path must not hang on embedding providers. We use
 * a 1-second search deadline and wait at most 200ms for an embedding before
 * using keyword results. Cancellation aborts the underlying embedding fetch.
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
 * skip if raw user text already contains `<ctx-search-hint>` or
 * `<ctx-search-auto>`, matching OpenCode's stacked
 * augmentation guard (lines 106-115, 189-198). Prompt extraction strips
 * Magic Context markers and prior plugin blocks before embedding, matching
 * OpenCode lines 118-143.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { isUsableProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { backgroundSessionProjectIdentity } from "@magic-context/core/features/magic-context/memory/session-identity-decision";
import type {
	UnifiedSearchOptions,
	UnifiedSearchResult,
} from "@magic-context/core/features/magic-context/search";
import {
	type AutoSearchHintDecision,
	type AutoSearchHintNoHintReason,
	getAutoSearchHintDecisions,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { readSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import {
	AUTO_SEARCH_TIMEOUT_MS,
	clearAutoSearchTimeoutForSession,
	persistAutoSearchSkip,
	wasAutoSearchSkipped,
	withAutoSearchDeadline,
} from "@magic-context/core/hooks/magic-context/auto-search-deadline";
import {
	buildAutoSearchHint,
	selectAutoSearchResults,
} from "@magic-context/core/hooks/magic-context/auto-search-hint";
import {
	AutoSearchBusyError,
	coalesceAutoSearchTurn,
	persistAutoSearchDecision,
	queueAutoSearchBackfill,
	queueAutoSearchRegistration,
	retryUnpublishedAutoSearchNoHint,
	searchAutoHint,
} from "@magic-context/core/hooks/magic-context/auto-search-worker-client";
import type { CavemanWordRules } from "@magic-context/core/hooks/magic-context/caveman";
import { hasMeaningfulUserText } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { getUnpublishedAutoSearchNoHint } from "@magic-context/core/shared/auto-search-lifecycle";
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
	/**
	 * Resolves `visibleMemoryIds` only when a new hint is computed for a new user
	 * message. Automatic search is a named memory reader: it reads current memory, but
	 * only then, never on a pass that replays an already-decided message.
	 */
	resolveVisibleMemoryIds?: () => Set<number> | null;
	/** Caveman word rules for hint fragments, from the user-level `language` setting. */
	wordRules?: CavemanWordRules;
}

const DEFAULT_SCORE_THRESHOLD = 0.55;
const DEFAULT_MIN_PROMPT_CHARS = 20;

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
		rawText.includes("<ctx-search-hint>") ||
		rawText.includes("<ctx-search-auto>")
	);
}

function stripNestedSystemReminders(text: string): string {
	const OPEN = "<system-reminder>";
	const CLOSE = "</system-reminder>";
	let result = "";
	let depth = 0;
	let i = 0;
	while (i < text.length) {
		if (text.startsWith(OPEN, i)) {
			depth += 1;
			i += OPEN.length;
		} else if (text.startsWith(CLOSE, i)) {
			// Orphan close tag (depth already 0) is dropped silently — we
			// don't want a leaked closing tag from a malformed/cut input
			// to bleed into the embedded text.
			if (depth > 0) depth -= 1;
			i += CLOSE.length;
		} else if (depth === 0) {
			result += text[i];
			i += 1;
		} else {
			// Inside a system-reminder — skip the character.
			i += 1;
		}
	}
	return result;
}

function extractUserPromptText(message: UserMessage): string {
	return (
		stripNestedSystemReminders(collectUserPromptParts(message))
			// HTML comments — covers temporal markers, OMO/ALFONSO internal
			// initiators, and any other commented-out extension markup.
			.replace(/<!--[\s\S]*?-->/g, "")
			// Plugin-owned injected blocks should be removed with their content.
			.replace(/<ctx-search-hint>[\s\S]*?<\/ctx-search-hint>/g, "")
			.replace(/<ctx-search-auto>[\s\S]*?<\/ctx-search-auto>/g, "")
			.replace(/<instruction[^>]*>[\s\S]*?<\/instruction>/g, "")
			// Generic XML/HTML tags — opening, closing, and self-closing.
			// Preserve text between paired tags so pasted content still embeds.
			.replace(/<\/?[a-zA-Z][^<>]*>/g, "")
			// Magic Context tag prefix: "§123§ " at any position.
			.replace(/§\d+§\s*/g, "")
			// Collapse whitespace runs that the strippings may leave behind.
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

function findLatestMeaningfulUserMessage(
	messages: AgentMessage[],
	entryIds: readonly (string | undefined)[],
	entryIdByRef?: ReadonlyMap<object, string> | null,
): { message: UserMessage; messageId: string; index: number } | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user") continue;
		const promptText = extractUserPromptText(msg);
		if (
			promptText.length === 0 ||
			!hasMeaningfulUserText([{ type: "text", text: promptText }])
		) {
			continue;
		}

		// Reference-identity resolution takes precedence: `entryIds` is positional
		// against the pre-splice array, but `messages` may have been spliced since
		// (compartment trim / placeholder strip), so index i can be stale. The
		// ref-map resolves the actual current message correctly.
		if (entryIdByRef) {
			const byRef =
				msg && typeof msg === "object"
					? entryIdByRef.get(msg as object)
					: undefined;
			if (typeof byRef === "string") {
				return { message: msg, messageId: byRef, index: i };
			}
			// Ref-map MISS with a ref-map present: do NOT fall back to the stale
			// positional `entryIds[i]` — after a splice it points at the wrong
			// message and would anchor the auto-search hint to the wrong user turn.
			// Treat as unresolved (degraded: no fresh hint this pass).
			return null;
		}

		// No ref-map (pre-mutation caller): positional entryIds is authoritative.
		const messageId = entryIds[i];
		if (typeof messageId === "string") {
			return { message: msg, messageId, index: i };
		}
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
	/**
	 * Splice-safe message→entryId map keyed by AgentMessage reference. Resolved
	 * against branch entries; correct even though `messages` was spliced since
	 * the positional `entryIds` was computed. Takes precedence over `entryIds`.
	 */
	entryIdByRef?: ReadonlyMap<object, string> | null;
	options: PiAutoSearchOptions;
	ensureProjectRegistered?: () => Promise<void>;
	/** Per-context projection loaded with note anchors so sticky replay reads session_meta once. */
	decisions?: readonly AutoSearchHintDecision[];
	passGuard?: { assert(): void; wait<T>(pending: Promise<T>): Promise<T> };
}): Promise<AgentMessage[]> {
	const startedAt = performance.now();
	args.passGuard?.assert();
	const wait = args.passGuard?.wait ?? (<T>(pending: Promise<T>) => pending);
	const { sessionId, db, messages, options, entryIdByRef } = args;
	const entryIds =
		args.entryIds === undefined
			? messages.map((message, index) => {
					const timestamp = (message as { timestamp?: unknown }).timestamp;
					return `test-entry-${index}:${typeof timestamp === "number" ? timestamp : "no-ts"}`;
				})
			: args.entryIds;
	if (!options.enabled) return messages;
	const strictResolutionFailed = entryIds === null;
	const effectiveEntryIds = strictResolutionFailed
		? messages.map((message) => {
				const id = (message as { id?: unknown }).id;
				return typeof id === "string" ? id : undefined;
			})
		: entryIds;

	const found = findLatestMeaningfulUserMessage(
		messages,
		effectiveEntryIds,
		entryIdByRef,
	);
	if (found === null) return messages;

	const { message: userMsg, messageId: userMsgId } = found;
	await wait(
		coalesceAutoSearchTurn(
			db,
			sessionId,
			userMsgId,
			async (lifecycleSignal): Promise<AgentMessage[]> => {
				args.passGuard?.assert();
				if (lifecycleSignal.aborted) return messages;
				if (
					retryUnpublishedAutoSearchNoHint(db, sessionId, userMsgId, startedAt)
				) {
					args.passGuard?.assert();
					return messages;
				}
				if (wasAutoSearchSkipped(db, sessionId, userMsgId)) return messages;

				const existing =
					args.decisions ?? getAutoSearchHintDecisions(db, sessionId);
				const existingForMessage =
					existing.find((decision) => decision.messageId === userMsgId) ??
					(args.decisions
						? getAutoSearchHintDecisions(db, sessionId).find(
								(decision) => decision.messageId === userMsgId,
							)
						: undefined);
				if (existingForMessage) {
					if (existingForMessage.decision === "hint") {
						appendHintToUserMessage(userMsg, existingForMessage.text);
					}
					return messages;
				}
				if (strictResolutionFailed) {
					sessionLog(
						sessionId,
						"Pi auto-search: strict entry-id resolution failed; replayed persisted decisions only",
					);
					return messages;
				}

				// Compute a new decision only for the live user tail. A fresh hint on a
				// previously answered user message would rewrite an already-served prefix.
				// Persisted decisions were replayed above because replay is byte restoration,
				// not a new mutation.
				if (found.index !== messages.length - 1) return messages;
				const meta = readSessionMeta(db, sessionId);
				const owner = backgroundSessionProjectIdentity(
					db,
					sessionId,
					meta,
					undefined,
					options.projectPath,
				);
				const ownerUnavailable =
					meta.cachedM0Bytes !== null && owner === undefined;
				const projectPath = owner ?? options.projectPath;
				// A directory outside any project has no identity to search memories,
				// commits or history embeddings under; never search the blank key.
				if (!isUsableProjectIdentity(projectPath)) return messages;

				const snapshot = getProjectEmbeddingSnapshot(projectPath);
				if (!snapshot) {
					queueAutoSearchRegistration(
						db,
						projectPath,
						args.ensureProjectRegistered,
					);
					void persistAutoSearchSkip(db, sessionId, userMsgId, "empty");
					return messages;
				}

				const writeNoHintAndReconcile = async (
					reason: AutoSearchHintNoHintReason,
				): Promise<void> => {
					args.passGuard?.assert();
					const outcome = persistAutoSearchDecision(
						db,
						sessionId,
						{
							messageId: userMsgId,
							decision: "no-hint",
							reason,
						},
						startedAt,
					);
					args.passGuard?.assert();
					if (outcome === null) {
						void persistAutoSearchSkip(db, sessionId, userMsgId);
						return;
					}
					if (!outcome.ok) return;
					if (
						outcome.kind === "already-present" &&
						outcome.decision.decision === "hint"
					) {
						appendHintToUserMessage(userMsg, outcome.decision.text);
					}
				};

				// Check raw text before stripping because stripping removes the
				// augmentation tags that tell us a hint was already attached.
				const rawPartsText = collectUserPromptParts(userMsg);
				if (hasStackedAugmentation(rawPartsText)) {
					sessionLog(
						sessionId,
						"auto-search: skipping — user message already carries augmentation/hint",
					);
					await writeNoHintAndReconcile("stacked");
					return messages;
				}

				const rawPrompt = extractUserPromptText(userMsg);
				const minPromptChars =
					options.minPromptChars ?? DEFAULT_MIN_PROMPT_CHARS;
				if (rawPrompt.length < minPromptChars) {
					await writeNoHintAndReconcile("too-short");
					return messages;
				}

				let results: UnifiedSearchResult[] | null;
				try {
					results = await wait(
						withAutoSearchDeadline(async (signal, checkDeadline) => {
							args.passGuard?.assert();
							if (checkDeadline()) return null;
							const memoryEnabled =
								!ownerUnavailable && (snapshot?.features.memoryEnabled ?? true);
							// Use the snapshot's history setting for query embedding, independently
							// of memory.enabled. Memory and git-commit retrieval have separate gates.
							const embeddingEnabled = snapshot
								? snapshot.historyEnabled
								: true;
							const gitCommitsEnabled = snapshot?.gitCommitEnabled ?? false;
							const searchOptions: UnifiedSearchOptions = {
								limit: 10,
								maxMessageOrdinal: Math.max(
									0,
									getLastCompartmentEndMessage(db, sessionId),
								),
								excludeMessageId: userMsgId,
								memoryEnabled,
								embeddingEnabled,
								gitCommitsEnabled,
								embedQuery: async (text, signal) => {
									const result = await wait(
										embedTextForProject(projectPath, text, signal, "query"),
									);
									args.passGuard?.assert();
									checkDeadline();
									return result;
								},
								isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
								visibleMemoryIds:
									options.visibleMemoryIds ??
									options.resolveVisibleMemoryIds?.() ??
									null,
								// Leave primers out of automatic hints so primer updates cannot rewrite
								// cached request prefixes. Explicit ctx_search and the dashboard expose them.
								sources: ownerUnavailable
									? ["message", "git_commit"]
									: ["memory", "message", "git_commit"],
								// Never wait for the history-chunk pool to be built: a
								// cold pool is warmed in the background for later turns.
								chunkPoolWarmOnly: true,
							};
							return searchAutoHint(db, sessionId, projectPath, rawPrompt, {
								...searchOptions,
								signal,
								countRetrievals: false,
							});
						}, startedAt),
					);
				} catch (error) {
					args.passGuard?.assert();
					if (lifecycleSignal.aborted) return messages;
					if (error instanceof AutoSearchBusyError) {
						// An earlier search of this session is still running. Serve this
						// turn without a hint and freeze that decision, as a timeout does.
						sessionLog(
							sessionId,
							"auto-search: an earlier search of this session is still running, skipping hint for this turn",
						);
						void persistAutoSearchSkip(db, sessionId, userMsgId);
						return messages;
					}
					// This pass serves the user message without a hint. Freeze that decision
					// before returning so a recovered search cannot rewrite cached bytes.
					log(
						`[auto-search] unified search failed for session ${sessionId} (no-hint frozen for this turn): ${error instanceof Error ? error.message : String(error)}`,
					);
					await writeNoHintAndReconcile("error");
					return messages;
				}

				args.passGuard?.assert();
				if (lifecycleSignal.aborted) return messages;
				try {
					if (results === null) {
						// The request was served without a hint; retries of this turn must
						// keep those bytes rather than append a late search result.
						sessionLog(
							sessionId,
							`auto-search: timed out after ${AUTO_SEARCH_TIMEOUT_MS}ms, skipping hint for this turn`,
						);
						void persistAutoSearchSkip(db, sessionId, userMsgId);
						return messages;
					}

					if (results.length === 0) {
						await writeNoHintAndReconcile("empty");
						return messages;
					}

					const scoreThreshold =
						options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
					results = selectAutoSearchResults(results, scoreThreshold);
					if (results.length === 0) {
						sessionLog(
							sessionId,
							`auto-search: no fragment meets relevance threshold ${scoreThreshold}`,
						);
						await writeNoHintAndReconcile("below-threshold");
						return messages;
					}

					const hintText = buildAutoSearchHint(results, {
						wordRules: options.wordRules,
						query: rawPrompt,
					});
					if (!hintText) {
						await writeNoHintAndReconcile("empty");
						return messages;
					}

					// Prefix with two newlines so the hint is a separate text block.
					const payload = `\n\n${hintText}`;
					args.passGuard?.assert();
					const outcome = persistAutoSearchDecision(
						db,
						sessionId,
						{
							messageId: userMsgId,
							decision: "hint",
							text: payload,
						},
						startedAt,
					);
					args.passGuard?.assert();
					if (outcome === null) {
						void persistAutoSearchSkip(db, sessionId, userMsgId);
						return messages;
					}
					if (!outcome.ok) return messages;
					if (outcome.decision.decision === "hint") {
						appendHintToUserMessage(userMsg, outcome.decision.text);
					}
					sessionLog(
						sessionId,
						`auto-search: attached hint to ${userMsgId} (${results.length} fragments, top relevance ${(results[0].relevanceScore ?? results[0].score).toFixed(3)})`,
					);

					return messages;
				} finally {
					if (
						!ownerUnavailable &&
						!lifecycleSignal.aborted &&
						results !== null
					) {
						args.passGuard?.assert();
						void queueAutoSearchBackfill(db, sessionId, projectPath, rawPrompt);
					}
				}
			},
			() => {
				args.passGuard?.assert();
				if (getUnpublishedAutoSearchNoHint(sessionId, userMsgId) !== undefined)
					return;
				if (wasAutoSearchSkipped(db, sessionId, userMsgId)) return;
				const decision = getAutoSearchHintDecisions(db, sessionId).find(
					(entry) => entry.messageId === userMsgId,
				);
				if (decision?.decision === "hint")
					appendHintToUserMessage(userMsg, decision.text);
			},
		),
	);
	return messages;
}

/**
 * Session cleanup hook. Call from Pi's session shutdown/delete lifecycle to
 * release the per-turn cache entry for that session.
 */
export function clearAutoSearchForPiSession(sessionId: string): void {
	clearAutoSearchTimeoutForSession(sessionId);
	// Auto-search decisions live in session_meta and are cleared by clearSession().
}
