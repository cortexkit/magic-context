/**
 * Transform-time auto-search hint runner.
 *
 * When a new user message arrives, optionally run ctx_search against the user's
 * prompt and append a caveman-compressed "vague recall" fragment hint to that
 * message. The hint nudges the agent to run ctx_search for full context rather
 * than injecting the content directly.
 *
 * Cache safety:
 *   - Attaches to the latest user message (the message that triggered the turn),
 *     never to message[0] or to any assistant message. Appending to the current
 *     user message happens BEFORE it reaches Anthropic's cache because this
 *     transform runs on the prompt path — same property as note nudges.
 *   - Idempotent via in-memory turn cache + `.includes()` guard in
 *     appendReminderToUserMessageById. On defer passes we re-append the same
 *     text; `.includes()` makes that a no-op.
 *   - New user turn (different message id) → compute fresh hint, new append.
 *   - Process restart → cache cleared; next pass will recompute but the user
 *     message is a fresh turn anyway, no provider cache to preserve yet.
 */

import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import type {
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import {
    type AutoSearchHintNoHintReason,
    getAutoSearchHintDecisions,
} from "../../features/magic-context/storage-meta-persisted";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    AUTO_SEARCH_TIMEOUT_MS,
    clearAutoSearchTimeoutForSession,
    persistAutoSearchSkip,
    wasAutoSearchSkipped,
    withAutoSearchDeadline,
} from "./auto-search-deadline";
import { buildAutoSearchHint } from "./auto-search-hint";
import {
    coalesceAutoSearchTurn,
    persistAutoSearchDecision,
    queueAutoSearchBackfill,
    queueAutoSearchRegistration,
    searchAutoHint,
} from "./auto-search-worker-client";
import type { CavemanWordRules } from "./caveman";
import { hasMeaningfulUserText } from "./read-session-formatting";
import { appendReminderToUserMessageById } from "./transform-message-helpers";
import type { MessageLike } from "./transform-operations";

export type AutoSearchOutcome =
    | { ok: true }
    | { ok: false; kind: "timeout" | "search-failure" | "cas-exhaustion" };

const AUTO_SEARCH_OK: AutoSearchOutcome = { ok: true };

export interface AutoSearchRunnerOptions {
    enabled: boolean;
    scoreThreshold: number;
    minPromptChars: number;
    directory?: string;
    projectPath: string;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    gitCommitsEnabled?: boolean;
    /** Memory ids already rendered in the injected <session-history> block —
     *  skip fragments that just duplicate visible memories. */
    visibleMemoryIds?: Set<number>;
    /** Caveman word rules for hint fragments, from the user-level `language` setting. */
    wordRules?: CavemanWordRules;
}

function collectUserPromptParts(message: MessageLike): string {
    let collected = "";
    for (const part of message.parts) {
        const p = part as { type?: string; text?: string; ignored?: boolean };
        if (p.type !== "text" || typeof p.text !== "string") continue;
        // Skip plugin-internal ignored notifications (conflict warnings, TUI setup
        // notices, startup announcements, etc.). They're persisted as ordinary
        // user-role messages but should never reach embeddings or hint detection.
        if (p.ignored === true) continue;
        collected += (collected.length > 0 ? "\n" : "") + p.text;
    }
    return collected;
}

/** Tests whether the user message already carries a stacked plugin augmentation
 *  or auto-hint block — in which case auto-search should skip so we don't double
 *  up. This runs on the RAW text (before stripping) because the whole point is
 *  to detect what the stripper would remove. */
function hasStackedAugmentation(rawText: string): boolean {
    return rawText.includes("<ctx-search-hint>") || rawText.includes("<ctx-search-auto>");
}

/**
 * Depth-aware stripper for tags that can legitimately nest. The system-reminder
 * tag is the canonical example: OpenCode and magic-context both wrap content
 * in <system-reminder>…</system-reminder>, and when the inner content itself
 * contains a system reminder (e.g. background-task notifications cited inside
 * a parent reminder), a non-greedy regex matches from the outer open to the
 * FIRST inner close, leaving the outer close tag and any text between the
 * inner close and outer close behind.
 *
 * The non-greedy regex bug is observable in production embedding logs: the
 * leaked tail "Please address this message and continue with your tasks.
 * </system-reminder>" reaches the embedding endpoint as user-typed text.
 *
 * This parser walks the string once, tracking open/close depth. Anything
 * inside ANY level of system-reminder is dropped. Orphan open/close tags
 * (malformed input) are also dropped. Only text that lies entirely outside
 * every system-reminder block is kept.
 */
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

function extractUserPromptText(message: MessageLike): string {
    // Strip all plugin-owned injections AND any other XML/HTML markup so the
    // embedded prompt is just what the user actually typed. Without this:
    //
    //  - Every embedded query would carry "§NNN§ " tag prefixes, temporal
    //    markers, plugin nudges, and any other XML the user (or an upstream
    //    extension) included in their message. That noise distorts semantic
    //    similarity scores and leaks plugin-internal markup into local
    //    embedding endpoint logs (LMStudio, openai-compatible, etc).
    //
    //  - Specific allowlists missed real cases: pasted code with `<Component>`,
    //    quoted XML from another tool's output, ALFONSO/OMO markers we hadn't
    //    enumerated yet, and so on. A generic strip catches all of them.
    //
    // Order matters:
    //  1. system-reminders use a depth-aware parser (above) because they
    //     legitimately nest. Strip them first so nested reminders don't leave
    //     orphan close tags for the generic stripper to deal with.
    //  2. HTML comments next — they can wrap arbitrary content including angle
    //     brackets, so they must go before generic tag stripping.
    //  3. Generic tag strip — `<...>` for both single tags and the open/close
    //     of pair tags. Content between paired tags is preserved as text;
    //     that's intentional: a user pasting `<thing>important data</thing>`
    //     still wants "important data" in their embedding.
    //  4. Tag-prefix cleanup last — `§NNN§ ` is plain text, not markup.
    return (
        stripNestedSystemReminders(collectUserPromptParts(message))
            // (2) HTML comments — covers temporal markers (<!-- +5m -->), OMO
            // and ALFONSO internal initiators, and any other commented-out
            // content. `[\s\S]*?` matches across newlines.
            .replace(/<!--[\s\S]*?-->/g, "")
            // (3) Generic XML/HTML tags — opening, closing, and self-closing.
            // Matches `<...>` where `...` does not start with `!` (already
            // handled comments) and contains no embedded `<` (which would
            // mean a malformed/unmatched tag we should leave for visibility).
            .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
            // (4) Magic Context tag prefix: "§123§ " at any position.
            .replace(/§\d+§\s*/g, "")
            // Collapse whitespace runs that the strippings may leave behind.
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim()
    );
}

function findLatestMeaningfulUserMessage(messages: MessageLike[]): MessageLike | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.info.role !== "user") continue;
        if (typeof msg.info.id !== "string") continue;
        // hasMeaningfulUserText filters parts that should never reach embeddings:
        //   - ignored: true notifications (announcement, conflict warning, TUI setup)
        //   - system reminders, OMO internal initiator markers
        //   - system-directive-only stubs
        // The previous inline check accepted any non-empty text part, which let
        // ignored plugin-internal messages (e.g. the v0.21.7 startup announcement)
        // reach the embedding endpoint as if they were real user prompts.
        if (hasMeaningfulUserText(msg.parts)) {
            return msg;
        }
    }
    return null;
}

/**
 * Entry point. Called from transform post-processing. No-op when disabled,
 * when there is no meaningful user message, when prompt is too short, when
 * search returns nothing strong enough, or when the hint has already been
 * appended for this turn.
 */
export async function runAutoSearchHint(args: {
    sessionId: string;
    db: Database;
    messages: MessageLike[];
    options: AutoSearchRunnerOptions;
}): Promise<AutoSearchOutcome> {
    const startedAt = performance.now();
    const { sessionId, db, messages, options } = args;
    if (!options.enabled) return AUTO_SEARCH_OK;

    const userMsg = findLatestMeaningfulUserMessage(messages);
    if (!userMsg || typeof userMsg.info.id !== "string") return AUTO_SEARCH_OK;
    const userMsgId = userMsg.info.id;

    return coalesceAutoSearchTurn(
        db,
        sessionId,
        userMsgId,
        async (lifecycleSignal): Promise<AutoSearchOutcome> => {
            if (lifecycleSignal.aborted) return AUTO_SEARCH_OK;
            if (wasAutoSearchSkipped(db, sessionId, userMsgId)) return AUTO_SEARCH_OK;

            const existing = getAutoSearchHintDecisions(db, sessionId);
            const existingForMessage = existing.find(
                (decision) => decision.messageId === userMsgId,
            );
            if (existingForMessage) {
                if (existingForMessage.decision === "hint") {
                    appendReminderToUserMessageById(messages, userMsgId, existingForMessage.text);
                }
                return AUTO_SEARCH_OK;
            }

            // Live-tail gate: only compute a NEW hint when the meaningful user message is
            // the actual last element of the array (a just-arrived user turn the assistant
            // has not answered yet). `findLatestMeaningfulUserMessage` returns the latest
            // user message even when it is BURIED behind a queued-message race or a
            // mid-turn assistant tail — appending a fresh hint there would mutate an
            // already-cached message and bust everything after it (the Bust-B class). On a
            // non-tail pass we only replay persisted decisions (handled above); we never
            // create a new one. A note-nudger-style `triggerMessageId` deferral would be
            // wrong here: auto-search has no trigger event and runs every pass, so a
            // deferral gate would either no-op or permanently suppress.
            if (messages.length === 0 || messages[messages.length - 1].info.id !== userMsgId) {
                return AUTO_SEARCH_OK;
            }

            const embeddingSnapshot = getProjectEmbeddingSnapshot(options.projectPath);
            if (!embeddingSnapshot) {
                queueAutoSearchRegistration(
                    db,
                    options.projectPath,
                    options.directory && options.ensureProjectRegistered
                        ? () =>
                              options.ensureProjectRegistered?.(options.directory as string, db) ??
                              Promise.resolve()
                        : undefined,
                );
                void persistAutoSearchSkip(db, sessionId, userMsgId, "empty");
                return AUTO_SEARCH_OK;
            }

            const writeNoHintAndReconcile = async (
                reason: AutoSearchHintNoHintReason,
            ): Promise<AutoSearchOutcome> => {
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
                if (outcome === null) {
                    void persistAutoSearchSkip(db, sessionId, userMsgId);
                    return { ok: false, kind: "timeout" };
                }
                if (!outcome.ok) return { ok: false, kind: "cas-exhaustion" };
                if (outcome.kind === "already-present" && outcome.decision.decision === "hint") {
                    appendReminderToUserMessageById(messages, userMsgId, outcome.decision.text);
                }
                return AUTO_SEARCH_OK;
            };

            // New turn — compute hint fresh. Suppression check must run BEFORE stripping
            // because the stripper removes the exact tags that signal "already augmented".
            const rawPartsText = collectUserPromptParts(userMsg);
            if (hasStackedAugmentation(rawPartsText)) {
                sessionLog(
                    sessionId,
                    "auto-search: skipping — user message already carries augmentation/hint",
                );
                return writeNoHintAndReconcile("stacked");
            }
            const rawPrompt = extractUserPromptText(userMsg);
            if (rawPrompt.length < options.minPromptChars) {
                return writeNoHintAndReconcile("too-short");
            }

            let results: UnifiedSearchResult[] | null;
            try {
                results = await withAutoSearchDeadline(async (signal, checkDeadline) => {
                    if (checkDeadline()) return null;
                    const memoryEnabled =
                        embeddingSnapshot?.features.memoryEnabled ?? options.memoryEnabled;
                    // Use the snapshot's history setting for query embedding, independently
                    // of memory.enabled. Memory and git-commit retrieval have separate gates.
                    const embeddingEnabled = embeddingSnapshot
                        ? embeddingSnapshot.historyEnabled
                        : options.embeddingEnabled;
                    const gitCommitsEnabled =
                        embeddingSnapshot?.gitCommitEnabled ?? options.gitCommitsEnabled ?? false;
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
                                "query",
                            );
                            checkDeadline();
                            return result;
                        },
                        isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
                        // Hard-filter memories already rendered in <session-history>.
                        // unifiedSearch applies this during memory merging so ranking
                        // can't be distorted by already-visible hits.
                        visibleMemoryIds: options.visibleMemoryIds ?? null,
                        // Leave primers out of automatic hints so primer updates cannot rewrite
                        // cached request prefixes. Explicit ctx_search and the dashboard expose them.
                        sources: ["memory", "message", "git_commit"],
                    };
                    return searchAutoHint(db, sessionId, options.projectPath, rawPrompt, {
                        ...searchOptions,
                        signal,
                        countRetrievals: false,
                    });
                }, startedAt);
            } catch (error) {
                // Retryable failure — do NOT persist a permanent no-hint decision, or the
                // hint would be suppressed forever for this message even though the next
                // pass might succeed. Just skip this pass; a later pass re-evaluates.
                log(
                    `[auto-search] unified search failed for session ${sessionId} (will retry next pass): ${error instanceof Error ? error.message : String(error)}`,
                );
                return { ok: false, kind: "search-failure" };
            }

            if (lifecycleSignal.aborted) return AUTO_SEARCH_OK;
            try {
                if (results === null) {
                    // Freeze the served skip for this turn. Retrying could add a hint to a
                    // user message already sent to the provider, rewriting its cached bytes.
                    sessionLog(
                        sessionId,
                        `auto-search: timed out after ${AUTO_SEARCH_TIMEOUT_MS}ms, skipping hint for this turn`,
                    );
                    void persistAutoSearchSkip(db, sessionId, userMsgId);
                    sessionLog(
                        sessionId,
                        "auto-search: skip frozen; retries for this turn are replay-only",
                    );
                    return { ok: false, kind: "timeout" };
                }

                if (results.length === 0) {
                    return writeNoHintAndReconcile("empty");
                }
                if (results[0].score < options.scoreThreshold) {
                    sessionLog(
                        sessionId,
                        `auto-search: top score ${results[0].score.toFixed(3)} below threshold ${options.scoreThreshold}`,
                    );
                    return writeNoHintAndReconcile("below-threshold");
                }

                const hintText = buildAutoSearchHint(results, { wordRules: options.wordRules });
                if (!hintText) {
                    return writeNoHintAndReconcile("empty");
                }

                // Prefix with double newline so the hint is a separate block, not glued
                // onto the last word of the user's prompt.
                const payload = `\n\n${hintText}`;
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
                if (outcome === null) {
                    void persistAutoSearchSkip(db, sessionId, userMsgId);
                    return { ok: false, kind: "timeout" };
                }
                if (!outcome.ok) {
                    sessionLog(
                        sessionId,
                        `auto-search: CAS exhausted for ${userMsgId}; skipping wire append`,
                    );
                    return { ok: false, kind: "cas-exhaustion" };
                }
                if (outcome.decision.decision === "hint") {
                    appendReminderToUserMessageById(messages, userMsgId, outcome.decision.text);
                }
                sessionLog(
                    sessionId,
                    `auto-search: attached hint to ${userMsgId} (${results.length} fragments, top score ${results[0].score.toFixed(3)})`,
                );
                return AUTO_SEARCH_OK;
            } finally {
                if (!lifecycleSignal.aborted && results !== null)
                    void queueAutoSearchBackfill(db, sessionId, options.projectPath, rawPrompt);
            }
        },
        () => {
            if (wasAutoSearchSkipped(db, sessionId, userMsgId)) return;
            const decision = getAutoSearchHintDecisions(db, sessionId).find(
                (entry) => entry.messageId === userMsgId,
            );
            if (decision?.decision === "hint")
                appendReminderToUserMessageById(messages, userMsgId, decision.text);
        },
    );
}

/** Test hook — wipe the per-turn cache. */
export function _resetAutoSearchCache(): void {
    clearAutoSearchTimeoutForSession();
}

/** Session cleanup hook — call on session.deleted. */
export function clearAutoSearchForSession(sessionId: string): void {
    clearAutoSearchTimeoutForSession(sessionId);
    // Durable decisions are session_meta state and are removed by clearSession().
}
