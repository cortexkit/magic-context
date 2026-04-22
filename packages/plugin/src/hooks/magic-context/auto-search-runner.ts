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

import type { Database } from "bun:sqlite";
import type {
    UnifiedSearchOptions,
    UnifiedSearchResult,
} from "../../features/magic-context/search";
import { unifiedSearch } from "../../features/magic-context/search";
import { log, sessionLog } from "../../shared/logger";
import { buildAutoSearchHint } from "./auto-search-hint";
import { appendReminderToUserMessageById } from "./transform-message-helpers";
import type { MessageLike } from "./transform-operations";

/** Per-session cache: most recent auto-search hint, keyed by the user message id it was computed for. */
const autoSearchByTurn = new Map<string, { messageId: string; hint: string }>();

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

function extractUserPromptText(message: MessageLike): string {
    let collected = "";
    for (const part of message.parts) {
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") {
            collected += (collected.length > 0 ? "\n" : "") + p.text;
        }
    }
    // Strip any previously-appended tags so we score the user's actual prompt,
    // not a composite that includes prior nudges or hints.
    return collected
        .replace(/<ctx-search-hint>[\s\S]*?<\/ctx-search-hint>/g, "")
        .replace(/<instruction[^>]*>[\s\S]*?<\/instruction>/g, "")
        .replace(/<sidekick-augmentation>[\s\S]*?<\/sidekick-augmentation>/g, "")
        .trim();
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

function isSuppressedContext(promptText: string): boolean {
    // Skip if the user turn already carries a sidekick augmentation or ctx-search
    // hint — don't stack hints or compete with /ctx-aug output.
    return (
        promptText.includes("<sidekick-augmentation>") ||
        promptText.includes("<ctx-search-hint>") ||
        promptText.includes("<ctx-search-auto>")
    );
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

    // New turn — compute hint fresh.
    const rawPrompt = extractUserPromptText(userMsg);
    if (rawPrompt.length < options.minPromptChars) return;
    if (isSuppressedContext(rawPrompt)) {
        sessionLog(
            sessionId,
            "auto-search: skipping — user message already carries augmentation/hint",
        );
        return;
    }

    let results: UnifiedSearchResult[];
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
        results = await unifiedSearch(db, sessionId, options.projectPath, rawPrompt, searchOptions);
    } catch (error) {
        log(
            `[auto-search] unified search failed for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }

    if (results.length === 0) return;
    if (results[0].score < options.scoreThreshold) {
        sessionLog(
            sessionId,
            `auto-search: top score ${results[0].score.toFixed(3)} below threshold ${options.scoreThreshold}`,
        );
        return;
    }

    const hintText = buildAutoSearchHint(results);
    if (!hintText) return;

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
