import { DREAMER_PRIMER_INVESTIGATOR_AGENT } from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import {
    type RawMessageProvider,
    setRawMessageProvider,
    withRawSessionMessageCache,
} from "../../../hooks/magic-context/read-session-chunk";
import { hasCompletedToolCall } from "../../../hooks/magic-context/read-session-formatting";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { teardownChildSession } from "../../../shared/child-session-teardown";
import { describeError } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import type { ModelInput } from "../../../shared/model-resolution";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { getActivePrimers, type Primer, updatePrimerAnswer } from "../storage-primers";
import type { SubagentInvocationStatus } from "../storage-subagent-invocations";
import { failedInvocationStatus, recordChildInvocation } from "../subagent-token-capture";
import { runHiddenSingleShotPrompt } from "./hidden-single-shot";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { buildPrimerSeed, buildPrimerSeedAsync, selectPrimerOriginCandidate } from "./primer-seed";
import { PRIMER_INVESTIGATOR_SYSTEM_PROMPT } from "./task-prompts";

const REFRESH_PRIMERS_PER_RUN = 5;

export interface RefreshPrimersArgs {
    db: Database;
    client?: PluginContext["client"];
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: ModelInput;
    fallbackModels?: readonly ModelInput[];
    tokenBudget?: number;
    onBudgetUpdate?: (state: { spent: number; finalizeFired: boolean }) => void;
    language?: string;
    onProgress?: (processed: number) => void;
    /**
     * Pi only: builds a RawMessageProvider for an arbitrary historical session id
     * (JSONL), so the orientation seed read works on Pi-only installs where there
     * is no opencode.db. OpenCode leaves this undefined — the seed read falls to
     * the read-only opencode.db path. Returning null → closed-book fallback.
     * May be async (Pi JSONL discovery is async); background seed assembly prefers
     * its async range reader without retaining the historical transcript.
     */
    rawProviderFactory?: (
        sessionId: string,
    ) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
}

export interface RefreshPrimersResult {
    refreshed: number;
    skipped: number;
}

/**
 * Stale = empty/never-refreshed answer, OR re-observed since the last refresh.
 * PRIMARY SORT is `answerRefreshedAt ASC NULLS FIRST` (never-refreshed first,
 * then oldest-refreshed) — NOT `lastObservedAt`. A hot recurring primer is
 * re-observed (lastObservedAt bumped) on every recurrence; sorting by that would
 * keep it permanently top-of-list and starve quiet primers. Promotion recency
 * must not drive refresh priority.
 */
function primersNeedingRefresh(primers: Primer[]): Primer[] {
    return primers
        .filter(
            (primer) =>
                !primer.answer.trim() ||
                primer.answerRefreshedAt == null ||
                (primer.lastObservedAt ?? 0) > primer.answerRefreshedAt,
        )
        .sort(
            (a, b) =>
                (a.answerRefreshedAt ?? 0) - (b.answerRefreshedAt ?? 0) ||
                (a.lastObservedAt ?? a.createdAt) - (b.lastObservedAt ?? b.createdAt) ||
                a.id - b.id,
        )
        .slice(0, REFRESH_PRIMERS_PER_RUN);
}

function buildInvestigationPrompt(
    primer: Primer,
    seedKind: "raw" | "closed-book",
    orientation: string,
    prePost: string,
): string {
    const orientationHeader =
        seedKind === "raw"
            ? `### Orientation — where this question arose (a MAP, NOT current truth)
The lines below are from the session episode where this question came up.
\`U:\` = what the user asked. \`TC:\` = which files/symbols the agent read.
This shows you WHERE to look. It does NOT tell you the current answer — the code
may have changed since. Investigate the CURRENT source yourself.

${orientation || "(no orientation available)"}`
            : `### Orientation (compartment summary — raw episode unavailable)
${orientation || "(none)"}`;

    return `## Task: Refresh a Magic Context Primer by investigating the current code

You maintain a concise, durable answer to a standing question about how THIS
project currently works. Your job is to GROUND the answer in today's source.

### Question
${primer.question}

### Current Answer
${primer.answer.trim() || "(empty)"}

${orientationHeader}

### Surrounding context
${prePost || "(none)"}

### Instructions
- Use your tools (read / grep / glob / aft_outline / aft_zoom / aft_search) to
  investigate the CURRENT source. Open the files the orientation points at, and
  follow the code from there.
- Ground every claim in code you actually read THIS run. Where the orientation's
  old conclusions conflict with current source, current source wins.
- Prefer stable architecture / invariants over transient task status.
- Keep the answer concise (~3-8 bullets or short paragraphs).
- If you cannot ground an answer in current code, return the current answer
  unchanged if it is non-empty; otherwise return an empty string.

Return valid JSON only, no markdown fencing:
{ "answer": "..." }`;
}

/** Without a successful result, a refresh has no new evidence to replace the stored answer. */
function hasInvestigationEvidence(messages: unknown[]): boolean {
    if (!Array.isArray(messages)) return false;
    return messages.some((message) => {
        if (message === null || typeof message !== "object") return false;
        const parts = (message as { parts?: unknown }).parts;
        return Array.isArray(parts) && hasCompletedToolCall(parts);
    });
}

function parseAnswer(messages: unknown[], fallback: string): string {
    const text = extractLatestAssistantText(messages);
    if (!text) throw new Error("refresh-primers returned no output");
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) throw new Error("refresh-primers returned no JSON");
    const parsed = JSON.parse(jsonMatch[1]) as { answer?: unknown };
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    if (!answer && fallback.trim()) return fallback.trim();
    if (answer.length > 20_000) throw new Error("refresh-primers answer too large");
    return answer;
}

export async function refreshPrimers(args: RefreshPrimersArgs): Promise<RefreshPrimersResult> {
    const result: RefreshPrimersResult = { refreshed: 0, skipped: 0 };
    const primers = primersNeedingRefresh(getActivePrimers(args.db, args.projectIdentity));
    if (primers.length === 0) return result;

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        () => abortController.abort(),
        args.leaseAcquisition,
    );

    try {
        for (let i = 0; i < primers.length; i += 1) {
            const primer = primers[i];
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            // Fair per-primer slice so one deep primer can't zero out the rest.
            const primersRemaining = primers.length - i;
            const sliceMs = Math.max(1, Math.floor(remainingMs / primersRemaining));

            const refreshed = await refreshOnePrimer(args, primer, sliceMs, abortController.signal);
            if (refreshed) result.refreshed += 1;
            else result.skipped += 1;
            args.onProgress?.(result.refreshed + result.skipped);
        }
        log(`[dreamer] refresh-primers: refreshed=${result.refreshed} skipped=${result.skipped}`);
        return result;
    } finally {
        heartbeat.stop();
    }
}

/**
 * Investigate + refresh ONE primer in its OWN child session. Per-primer
 * try/finally retires a settled child inline and preserves an unsettled child for
 * age-gated cleanup. Returns true if the answer was committed.
 */
async function refreshOnePrimer(
    args: RefreshPrimersArgs,
    primer: Primer,
    sliceMs: number,
    signal: AbortSignal,
): Promise<boolean> {
    // Build the orientation seed. On Pi, resolve a raw provider for the origin
    // session before rendering, and await its yielding traversal; on
    // OpenCode, the read falls to the read-only opencode.db path.
    const originSessionId = originSessionIdForPrimer(args, primer);
    let provider: RawMessageProvider | null = null;
    if (args.rawProviderFactory && originSessionId) {
        try {
            provider = await args.rawProviderFactory(originSessionId);
        } catch {
            provider = null; // → closed-book fallback inside buildPrimerSeed
        }
    }
    const seed = await (async () => {
        const unregister =
            provider && originSessionId ? setRawMessageProvider(originSessionId, provider) : null;
        try {
            return provider?.iterateMessageRangeAsync
                ? await buildPrimerSeedAsync(args.db, primer)
                : withRawSessionMessageCache(() => buildPrimerSeed(args.db, primer));
        } finally {
            unregister?.();
        }
    })();

    let agentSessionId: string | null = null;
    let promptSettled = false;
    const startedAt = Date.now();
    try {
        const prompt = buildInvestigationPrompt(primer, seed.kind, seed.orientation, seed.prePost);
        if (args.hiddenCompletionExecutor) {
            const run = await runHiddenSingleShotPrompt({
                executor: args.hiddenCompletionExecutor,
                parentSessionId: args.parentSessionId,
                sessionDirectory: args.sessionDirectory,
                agent: DREAMER_PRIMER_INVESTIGATOR_AGENT,
                system: PRIMER_INVESTIGATOR_SYSTEM_PROMPT,
                prompt,
                title: "magic-context-dream-refresh-primers",
                callContext: "dreamer:refresh-primers",
                metadata: {
                    tokenBudget: args.tokenBudget,
                    onBudgetUpdate: args.onBudgetUpdate,
                },
                model: args.model,
                fallbackModels: args.fallbackModels,
                language: args.language,
                timeoutMs: sliceMs,
                signal,
                parse: (text) =>
                    parseAnswer(
                        [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }],
                        primer.answer,
                    ),
            });
            recordInvocation(args, startedAt, {
                status: "completed",
                messages: run.completion.messages ?? [],
            });
            const answer = run.validated.trim();
            if (!answer || !hasInvestigationEvidence(run.completion.messages ?? [])) return false;
            runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
                updatePrimerAnswer(args.db, primer.id, answer);
            });
            return true;
        }
        const client = args.client;
        if (!client)
            throw new Error("refresh-primers requires a client or hidden completion executor");
        const createResponse = await createChildSessionWithFence({
            client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: "magic-context-dream-refresh-primers",
            directory: args.sessionDirectory,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create primer refresh session.");

        const run = await shared.promptSyncWithValidatedOutputRetry(
            client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_PRIMER_INVESTIGATOR_AGENT,
                    system: withContentLanguageDirective(
                        PRIMER_INVESTIGATOR_SYSTEM_PROMPT,
                        args.language,
                    ),
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:refresh-primers",
                transport: shared.createPromptAsyncTransport(client, agentSessionId, {
                    tokenBudget: args.tokenBudget,
                    onBudgetUpdate: args.onBudgetUpdate,
                }),
                fetchOutput: async () => {
                    const messagesResponse = await client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 100 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => parseAnswer(messages, primer.answer),
            },
        );
        promptSettled = true;

        recordInvocation(args, startedAt, {
            status: "completed",
            messages: run.output,
        });

        const answer = run.validated.trim();
        if (!answer) return false;

        if (!hasInvestigationEvidence(run.output)) {
            log(
                `[dreamer] refresh-primers: primer #${primer.id} answer not committed (no successful investigation tool results)`,
            );
            return false;
        }

        runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
            updatePrimerAnswer(args.db, primer.id, answer);
        });
        return true;
    } catch (error) {
        const desc = describeError(error);
        log(
            `[dreamer] refresh-primers failed (primer #${primer.id}): ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        recordInvocation(args, startedAt, {
            status: failedInvocationStatus(error),
            error,
        });
        throw error;
    } finally {
        if (agentSessionId && args.client)
            await teardownChildSession({
                client: args.client,
                sessionId: agentSessionId,
                sessionDirectory: args.sessionDirectory,
                promptSettled,
                privacySensitive: true,
                context: "[dreamer] refresh-primers",
                log,
            });
    }
}

function originSessionIdForPrimer(args: RefreshPrimersArgs, primer: Primer): string | null {
    // Cheap lookup without rendering; the same same-project candidate the seed uses.
    return selectPrimerOriginCandidate(args.db, primer)?.sessionId ?? null;
}

function recordInvocation(
    args: RefreshPrimersArgs,
    startedAt: number,
    params: {
        status: SubagentInvocationStatus;
        messages?: unknown[];
        error?: unknown;
    },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: args.hiddenCompletionExecutor?.capabilities.harness ?? "opencode",
        subagent: "dreamer",
        task: "refresh-primers",
        startedAt,
        status: params.status,
        messages: params.messages,
        attemptedModel: args.model,
        configuredModels: args.fallbackModels,
        error: params.error,
    });
}
