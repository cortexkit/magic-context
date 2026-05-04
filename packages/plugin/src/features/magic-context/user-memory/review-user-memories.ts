import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { renewLease } from "../dreamer/lease";
import { DREAMER_SYSTEM_PROMPT } from "../dreamer/task-prompts";
import {
    deleteUserMemoryCandidates,
    dismissUserMemory,
    getActiveUserMemories,
    getUserMemoryCandidates,
    insertUserMemory,
    updateUserMemoryContent,
} from "./storage-user-memory";

interface ReviewUserMemoriesArgs {
    db: Database;
    client: PluginContext["client"];
    parentSessionId: string | undefined;
    sessionDirectory: string | undefined;
    holderId: string;
    deadline: number;
    promotionThreshold: number;
}

interface ReviewResult {
    promoted: number;
    merged: number;
    dismissed: number;
    candidatesConsumed: number;
}

export async function reviewUserMemories(args: ReviewUserMemoriesArgs): Promise<ReviewResult> {
    const result: ReviewResult = { promoted: 0, merged: 0, dismissed: 0, candidatesConsumed: 0 };

    const candidates = getUserMemoryCandidates(args.db);
    if (candidates.length < args.promotionThreshold) {
        log(
            `[dreamer] user-memories: ${candidates.length} candidate(s), need ${args.promotionThreshold} — skipping`,
        );
        return result;
    }

    const stableMemories = getActiveUserMemories(args.db);
    log(
        `[dreamer] user-memories: reviewing ${candidates.length} candidate(s) against ${stableMemories.length} stable memorie(s)`,
    );

    const candidateList = candidates
        .map((c) => `- Candidate #${c.id} [session ${c.sessionId.slice(0, 12)}]: "${c.content}"`)
        .join("\n");

    const stableList =
        stableMemories.length > 0
            ? stableMemories.map((m) => `- Memory #${m.id}: "${m.content}"`).join("\n")
            : "(none)";

    const prompt = `## Task: Review User Memory Candidates

You are reviewing behavioral observations about a human user to decide which patterns are real and persistent.

### Current Stable User Memories
${stableList}

### Candidate Observations (from recent historian runs)
${candidateList}

### Instructions

1. Look for **recurring patterns** across multiple candidates — observations that appear independently from different sessions or historian runs indicate a real user trait.
2. A candidate must appear in at least ${args.promotionThreshold} semantically similar variants before promotion.
3. Only promote **truly universal** user traits — communication style, expertise level, review focus, decision-making patterns, working habits.
4. Do NOT promote: project-specific preferences, framework choices, one-off moods, task-local frustrations.
5. If a candidate is semantically equivalent to an existing stable memory, mark it as already covered.
6. If multiple candidates describe the same trait, merge them into one clean statement.
7. If an existing stable memory should be updated based on new evidence, include the update.

### Output Format

Return valid JSON (no markdown fencing):

{
  "promote": [
    { "content": "Clean universal observation text", "candidate_ids": [1, 3, 7] }
  ],
  "update_existing": [
    { "memory_id": 5, "content": "Updated text incorporating new evidence", "candidate_ids": [2] }
  ],
  "dismiss_existing": [
    { "memory_id": 3, "reason": "No longer supported by recent observations" }
  ],
  "consume_candidate_ids": [1, 2, 3, 4, 5, 7, 8]
}

- \`promote\`: new stable memories to create from candidates
- \`update_existing\`: existing stable memories to rewrite with new evidence
- \`dismiss_existing\`: existing stable memories that are no longer valid
- \`consume_candidate_ids\`: ALL candidate IDs that were reviewed (promoted, merged, or rejected) — they will be deleted from the candidate pool

If no promotions are warranted, return empty arrays. Always consume reviewed candidates so they don't accumulate indefinitely.`;

    let agentSessionId: string | null = null;
    const abortController = new AbortController();
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(args.db, args.holderId)) {
                log("[dreamer] user-memories: lease renewal failed — aborting");
                abortController.abort();
            }
        } catch {
            abortController.abort();
        }
    }, 60_000);

    try {
        const createResponse = await args.client.session.create({
            body: {
                ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                title: "magic-context-dream-user-memories",
            },
            query: { directory: args.sessionDirectory },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create user memory review session.");

        log(`[dreamer] user-memories: child session created ${agentSessionId}`);

        const remainingMs = Math.max(0, args.deadline - Date.now());
        await shared.promptSyncWithModelSuggestionRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_AGENT,
                    system: DREAMER_SYSTEM_PROMPT,
                    parts: [{ type: "text", text: prompt }],
                },
            },
            { timeoutMs: Math.min(remainingMs, 5 * 60 * 1000), signal: abortController.signal },
        );

        const messagesResponse = await args.client.session.messages({
            path: { id: agentSessionId },
            query: { directory: args.sessionDirectory },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const responseText = extractLatestAssistantText(messages);
        if (!responseText) {
            log("[dreamer] user-memories: no response from review agent");
            return result;
        }

        // Parse the JSON response — try to extract from possible markdown fencing
        const jsonMatch =
            responseText.match(/```(?:json)?\s*([\s\S]*?)```/) ??
            responseText.match(/(\{[\s\S]*\})/);
        if (!jsonMatch) {
            log("[dreamer] user-memories: could not parse JSON from response");
            return result;
        }

        let parsed: {
            promote?: Array<{ content: string; candidate_ids: number[] }>;
            update_existing?: Array<{
                memory_id: number;
                content: string;
                candidate_ids?: number[];
            }>;
            dismiss_existing?: Array<{ memory_id: number; reason?: string }>;
            consume_candidate_ids?: number[];
        };
        try {
            parsed = JSON.parse(jsonMatch[1]);
        } catch {
            log("[dreamer] user-memories: JSON parse failed");
            return result;
        }

        // Apply promotions
        if (parsed.promote) {
            for (const p of parsed.promote) {
                if (p.content?.trim()) {
                    insertUserMemory(args.db, p.content.trim(), p.candidate_ids ?? []);
                    result.promoted++;
                    log(`[dreamer] user-memories: promoted "${p.content.trim().slice(0, 60)}..."`);
                }
            }
        }

        // Apply updates to existing memories
        if (parsed.update_existing) {
            for (const u of parsed.update_existing) {
                if (u.memory_id && u.content?.trim()) {
                    updateUserMemoryContent(args.db, u.memory_id, u.content.trim());
                    result.merged++;
                    log(`[dreamer] user-memories: updated memory #${u.memory_id}`);
                }
            }
        }

        // Apply dismissals
        if (parsed.dismiss_existing) {
            for (const d of parsed.dismiss_existing) {
                if (d.memory_id) {
                    dismissUserMemory(args.db, d.memory_id);
                    result.dismissed++;
                    log(
                        `[dreamer] user-memories: dismissed memory #${d.memory_id} — ${d.reason ?? "no reason"}`,
                    );
                }
            }
        }

        // Consume reviewed candidates
        if (parsed.consume_candidate_ids && parsed.consume_candidate_ids.length > 0) {
            deleteUserMemoryCandidates(args.db, parsed.consume_candidate_ids);
            result.candidatesConsumed = parsed.consume_candidate_ids.length;
            log(`[dreamer] user-memories: consumed ${result.candidatesConsumed} candidate(s)`);
        }

        return result;
    } catch (error) {
        log(`[dreamer] user-memories: review failed: ${getErrorMessage(error)}`);
        return result;
    } finally {
        clearInterval(leaseInterval);
        if (agentSessionId) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] user-memories: session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}
