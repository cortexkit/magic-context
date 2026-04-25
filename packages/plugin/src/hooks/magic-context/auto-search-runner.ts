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

import type {
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import { unifiedSearch } from "../../features/magic-context/search";
import { log, sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { buildAutoSearchHint } from "./auto-search-hint";
import { appendReminderToUserMessageById } from "./transform-message-helpers";
import type { MessageLike } from "./transform-operations";

/** Per-session cache: most recent auto-search decision, keyed by the user message id it was computed for.
 *  `hint === ""` is a valid sentinel meaning "already computed for this turn, produce no hint".
 *  Caching every outcome (success, empty, below-threshold, timeout) prevents re-running the full
 *  FTS + embedding search on every defer pass of the same user turn — transform can re-enter many
 *  times per turn (tool calls, reasoning steps) and without this cache we re-embed every time. */
const autoSearchByTurn = new Map<string, { messageId: string; hint: string }>();

/** Hard cap on how long the transform hot path waits for unified search to finish.
 *  If the configured embedding provider is slow or saturated, we abandon the hint for this
 *  turn and let the next user turn try again. Transform must never hang on auto-search. */
const AUTO_SEARCH_TIMEOUT_MS = 3_000;

/** Race `unifiedSearch` against a timer. Resolves with results on success, or `null` on timeout.
 *  On timeout, the AbortController fires so the underlying HTTP embed request is cancelled —
 *  this prevents dangling fetches from piling up at the provider (e.g. LMStudio saturation). */
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
                // Plugin-internal auto-surfacing: do NOT count these as real
                // retrievals. The agent may never actually consume the hint,
                // and counting inflates retrieval_count-based memory
                // promotion decisions with false-positive signal.
                countRetrievals: false,
            }),
            timeoutPromise,
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export interface AutoSearchRunnerOptions {
    enabled: boolean;
    scoreThreshold: number;
    minPromptChars: number;
    projectPath: string;
    memoryEnabled: boolean;
    embeddingEnabled: boolean;
    gitCommitsEnabled: boolean;
    /** Memory ids already rendered in the injected <session-history> block —
     *  skip fragments that just duplicate visible memories. */
    visibleMemoryIds?: Set<number>;
}

function collectUserPromptParts(message: MessageLike): string {
    let collected = "";
    for (const part of message.parts) {
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") {
            collected += (collected.length > 0 ? "\n" : "") + p.text;
        }
    }
    return collected;
}

/** Tests whether the user message already carries a stacked plugin augmentation
 *  or auto-hint block — in which case auto-search should skip so we don't double
 *  up. This runs on the RAW text (before stripping) because the whole point is
 *  to detect what the stripper would remove. */
function hasStackedAugmentation(rawText: string): boolean {
    return (
        rawText.includes("<sidekick-augmentation>") ||
        rawText.includes("<ctx-search-hint>") ||
        rawText.includes("<ctx-search-auto>")
    );
}

function extractUserPromptText(message: MessageLike): string {
    // Strip all plugin-owned injections so the embedded prompt is just what
    // the user actually typed. Without this, every embedded query carries
    // "§NNN§ " tag prefixes, temporal markers, and prior nudges — noise that
    // distorts semantic similarity and leaks plugin noise into LMStudio logs.
    return (
        collectUserPromptParts(message)
            // Magic Context tag prefix: "§123§ " at any position.
            .replace(/§\d+§\s*/g, "")
            // Temporal awareness gap markers: <!-- +5m -->, <!-- +1w 2d -->, etc.
            // Must include 'w' for week units produced by temporal-awareness.ts.
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

function findLatestMeaningfulUserMessage(messages: MessageLike[]): MessageLike | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.info.role !== "user") continue;
        if (typeof msg.info.id !== "string") continue;
        // Skip messages that are entirely synthetic (e.g. ignored notifications).
        // hasMeaningfulUserText would be ideal but re-importing here is fine.
        for (const part of msg.parts) {
            const p = part as { type?: string; text?: string };
            if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
                return msg;
            }
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
}): Promise<void> {
    const { sessionId, db, messages, options } = args;
    if (!options.enabled) return;

    const userMsg = findLatestMeaningfulUserMessage(messages);
    if (!userMsg || typeof userMsg.info.id !== "string") return;
    const userMsgId = userMsg.info.id;

    const cached = autoSearchByTurn.get(sessionId);
    if (cached && cached.messageId === userMsgId) {
        // Same turn — replay (idempotent via .includes guard).
        appendReminderToUserMessageById(messages, userMsgId, cached.hint);
        return;
    }

    // New turn — compute hint fresh. Suppression check must run BEFORE stripping
    // because the stripper removes the exact tags that signal "already augmented".
    const rawPartsText = collectUserPromptParts(userMsg);
    if (hasStackedAugmentation(rawPartsText)) {
        sessionLog(
            sessionId,
            "auto-search: skipping — user message already carries augmentation/hint",
        );
        autoSearchByTurn.set(sessionId, { messageId: userMsgId, hint: "" });
        return;
    }
    const rawPrompt = extractUserPromptText(userMsg);
    if (rawPrompt.length < options.minPromptChars) {
        // Cache the skip so we don't re-extract + re-check on every defer pass.
        autoSearchByTurn.set(sessionId, { messageId: userMsgId, hint: "" });
        return;
    }

    let results: UnifiedSearchResult[] | null;
    try {
        const searchOptions: UnifiedSearchOptions = {
            limit: 10,
            memoryEnabled: options.memoryEnabled,
            embeddingEnabled: options.embeddingEnabled,
            gitCommitsEnabled: options.gitCommitsEnabled,
            // Hard-filter memories already rendered in <session-history>.
            // unifiedSearch applies this during memory merging so ranking
            // can't be distorted by already-visible hits.
            visibleMemoryIds: options.visibleMemoryIds ?? null,
            // Don't restrict by last compartment end — auto-search should see
            // everything available, including raw-history FTS. unifiedSearch
            // already defaults to searching all sources.
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
        // Cache the failure so we don't retry the same doomed search on the next defer pass.
        autoSearchByTurn.set(sessionId, { messageId: userMsgId, hint: "" });
        return;
    }

    if (results === null) {
        sessionLog(
            sessionId,
            `auto-search: timed out after ${AUTO_SEARCH_TIMEOUT_MS}ms, skipping hint for this turn`,
        );
        // Cache the timeout so later defer passes for this turn don't re-run the search.
        autoSearchByTurn.set(sessionId, { messageId: userMsgId, hint: "" });
        return;
    }

    if (results.length === 0) {
        autoSearchByTurn.set(sessionId, { messageId: userMsgId, hint: "" });
        return;
    }
    if (results[0].score < options.scoreThreshold) {
        sessionLog(
            sessionId,
            `auto-search: top score ${results[0].score.toFixed(3)} below threshold ${options.scoreThreshold}`,
        );
        autoSearchByTurn.set(sessionId, { messageId: userMsgId, hint: "" });
        return;
    }

    const hintText = buildAutoSearchHint(results);
    if (!hintText) {
        autoSearchByTurn.set(sessionId, { messageId: userMsgId, hint: "" });
        return;
    }

    // Prefix with double newline so the hint is a separate block, not glued
    // onto the last word of the user's prompt.
    const payload = `\n\n${hintText}`;
    autoSearchByTurn.set(sessionId, { messageId: userMsgId, hint: payload });
    appendReminderToUserMessageById(messages, userMsgId, payload);
    sessionLog(
        sessionId,
        `auto-search: attached hint to ${userMsgId} (${results.length} fragments, top score ${results[0].score.toFixed(3)})`,
    );
}

/** Test hook — wipe the per-turn cache. */
export function _resetAutoSearchCache(): void {
    autoSearchByTurn.clear();
}

/** Session cleanup hook — call on session.deleted. */
export function clearAutoSearchForSession(sessionId: string): void {
    autoSearchByTurn.delete(sessionId);
}
