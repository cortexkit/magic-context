/**
 * The carrier for historian turn two on OpenCode 1 and OpenCode 2 hosts (both run the
 * historian through a `HiddenCompletionExecutor`): it continues the retained
 * turn-one child with a second prompt on the same session id, and sends each narrow
 * check as a fresh single-turn child of its own.
 *
 * No production lane is enabled yet (see `resolveTurnOneLane`). Before a lane is enabled, a recorded replay must
 * also show that a check request reaches the provider with only its own fixed system
 * prompt (the OpenCode agent registration can add its own).
 */

import {
    buildHiddenAgentConfig,
    buildHiddenAgentRegistrations,
    buildZenReadAgentRegistrations,
} from "../../agents/hidden-agent-registrations";
import { CHECK_SCHEMA_CONTRACT } from "../../features/magic-context/memory/historian-schema";
import { hasHistorianToolActivity } from "../../features/magic-context/memory/historian-wire";
import type {
    CheckReply,
    CheckRequest,
    ReportedProfile,
} from "../../features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import type {
    TurnTwoCarrier,
    TurnTwoReattach,
    TurnTwoRecoveryResolver,
    TurnTwoStageRecord,
    TurnTwoStageReply,
} from "../../features/magic-context/memory/turn-two";
import { TurnTwoOutcomeUnknownError } from "../../features/magic-context/memory/turn-two";
import {
    closeTurnTwoChild,
    retainedTurnTwoChild,
} from "../../features/magic-context/memory/turn-two-children";
import {
    lifecycleToolHash,
    turnTwoLaneForReport,
} from "../../features/magic-context/memory/turn-two-profile";
import { needsBlockedRead, ZEN_READ_AGENT_SUFFIX } from "../../shared/hidden-zen-read";
import { modelBodyField, toModelEntry } from "../../shared/resolve-fallbacks";
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
    RetainedHistorianChild,
} from "./compartment-runner-types";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            timer = setTimeout(
                // A local timeout with no provider result says nothing about the
                // outcome; the stage stays reserved for recovery.
                () => reject(new TurnTwoOutcomeUnknownError("turn two send timed out locally")),
                timeoutMs,
            );
            (timer as unknown as { unref?: () => void }).unref?.();
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * The provider and model that answered: the carrier's own report, else the latest
 * assistant message's `providerID`/`modelID` (OpenCode records the model that
 * actually ran, which differs from the configured one after a fallback).
 */
function answeredBy(completion: HiddenCompletion): { provider: string; modelId: string } | null {
    if (completion.providerId && completion.modelId)
        return { provider: completion.providerId, modelId: completion.modelId };
    const messages = Array.isArray(completion.messages) ? completion.messages : [];
    for (let index = messages.length - 1; index >= 0; index--) {
        const info = (messages[index] as { info?: Record<string, unknown> } | null)?.info;
        if (info?.role !== "assistant") continue;
        if (typeof info.providerID === "string" && typeof info.modelID === "string")
            return { provider: info.providerID, modelId: info.modelID };
        return null;
    }
    return null;
}

/** Hash only the surface authored here, never the host's tool-definition text. */
export function openCodeTurnTwoToolHash(args: {
    harness: string;
    carrier: string;
    agent: string;
    provider?: string;
    observedToolSurface?: readonly string[];
}): string | null {
    const surface = openCodeTurnTwoToolSurface(args);
    return surface === undefined ? null : lifecycleToolHash(surface);
}

/** The exact Magic Context tool bytes used for both request persistence and carrier reports. */
export function openCodeTurnTwoToolSurface(
    args: Parameters<typeof openCodeTurnTwoToolHash>[0],
): unknown {
    const lane = turnTwoLaneForReport(args);
    if (lane === "opencode-2") return args.observedToolSurface;
    if (lane !== "opencode-1") return undefined;
    const registrations = buildHiddenAgentRegistrations({
        dreamerPrompt: undefined,
        historianPrompt: undefined,
        historianEditorPrompt: undefined,
        historianDisallowed: [],
    });
    const agent = needsBlockedRead(args.agent, args.provider)
        ? `${args.agent}${ZEN_READ_AGENT_SUFFIX}`
        : args.agent;
    const registration = [...registrations, ...buildZenReadAgentRegistrations(registrations)].find(
        (entry) => entry.id === agent,
    );
    if (!registration) return undefined;
    if (registration.allowedTools.length === 0) return [];
    const config = buildHiddenAgentConfig(
        "",
        registration.allowedTools,
        registration.maxSteps,
        registration.overrides,
        registration.id,
        registration.lockPermissions,
    );
    return {
        allowedTools: registration.allowedTools,
        permissions: config.permission,
    };
}

export function reportedProfile(
    completion: HiddenCompletion,
    model: RetainedHistorianChild["model"],
    systemHash: string,
    identity: { harness: string; carrier: string; agent: string },
    formatInstructions?: string,
): ReportedProfile | null {
    const answered = answeredBy(completion);
    if (!answered) return null;
    return {
        lane: turnTwoLaneForReport(identity),
        carrier: identity.carrier,
        provider: answered.provider,
        modelId: answered.modelId,
        variant: toModelEntry(model)?.qualifier ?? null,
        // No OpenCode carrier reports the sampling temperature.
        temperature: null,
        thinkingLevel: null,
        systemHash,
        schemaHash: formatInstructions === undefined ? null : lifecycleTextHash(formatInstructions),
        toolHash: openCodeTurnTwoToolHash({
            ...identity,
            provider: answered.provider,
            observedToolSurface: completion.observedToolSurface,
        }),
    };
}

function parseCheckVerdicts(text: string | null): CheckReply["verdicts"] {
    const parsed = JSON.parse(text ?? "") as { verdicts?: unknown };
    if (!Array.isArray(parsed.verdicts)) throw new Error("check reply has no verdicts");
    return parsed.verdicts as CheckReply["verdicts"];
}

/**
 * The check prompt: an `Operands:` section listing each operand (or, for a
 * compatibility check, each A/B pair) under its identity, then the `Input:` text.
 */
export function renderCheckInput(request: CheckRequest): string {
    const operands =
        request.kind === "compatibility"
            ? request.pairs.map(
                  (pair) => `${pair.id}\n  A: ${pair.left.text}\n  B: ${pair.right.text}`,
              )
            : request.operands.map((operand) => `${operand.id}: ${operand.text}`);
    return [`Operands:`, ...operands, "", "Input:", request.input].join("\n");
}

export function createOpenCodeTurnTwoCarrier(args: {
    child: RetainedHistorianChild;
    parentSessionId: string;
    harness: string;
    carrier: string;
    enforcedJson?: boolean;
    /** Turn one's reply; a later reply that differs from it is turn two's. */
    turnOneText: string;
    timeoutMs: number;
    /** The persisted format-instruction bytes used on both historian turns. */
    formatInstructions?: string;
}): TurnTwoCarrier {
    const { child } = args;
    const historianSystemHash = lifecycleTextHash(child.system);
    // `continueConversation` asks a carrier that rebuilds each request's context
    // (OpenCode 2's hidden-child hook) to put turn one's prompt and reply before this
    // prompt. OpenCode 1 keeps the session's history itself and ignores the field.
    const prompt = (handle: HiddenRunHandle, text: string) => ({
        path: { id: handle.id },
        query: { directory: child.directory },
        continueConversation: true,
        body: {
            agent: child.agent,
            ...modelBodyField(child.model),
            parts: [{ type: "text", text, synthetic: true }],
        },
    });
    return {
        carrier: args.carrier,
        harness: args.harness,
        childSessionId: child.handle.childSessionId ?? child.handle.id,
        baseline: lifecycleTextHash(args.turnOneText),
        historianSystemHash,
        variant: toModelEntry(child.model)?.qualifier ?? null,
        async send(text: string): Promise<TurnTwoStageReply> {
            await withTimeout(
                child.executor.attempt(child.handle, prompt(child.handle, text)),
                args.timeoutMs,
            );
            const completion = await child.executor.collect(child.handle, 50);
            const toolActivity = hasHistorianToolActivity(completion);
            if (!toolActivity && (!completion.text || completion.text === args.turnOneText))
                throw new TurnTwoOutcomeUnknownError("turn two reply not yet available");
            return {
                text: completion.text ?? "",
                lengthCapped: completion.lengthCapped,
                toolActivity,
                profile: reportedProfile(
                    completion,
                    child.model,
                    historianSystemHash,
                    { ...args, agent: child.agent },
                    args.formatInstructions,
                ),
                usage: completion.usage,
            };
        },
        check: (request) => sendCheck(child.executor, child, args, request),
    };
}

/**
 * A narrow check: a fresh child per request, never the historian's, carrying only
 * the check's fixed system prompt, its operands and its input.
 */
async function sendCheck(
    executor: HiddenCompletionExecutor,
    child: RetainedHistorianChild,
    identity: { parentSessionId: string; harness: string; carrier: string; timeoutMs: number },
    request: CheckRequest,
): Promise<CheckReply> {
    const { parentSessionId, timeoutMs } = identity;
    const handle = await executor.open({
        parentSessionId,
        agent: child.agent,
        kind: "historian",
        // Narrow checks queue only behind other narrow checks. OpenCode 2 runs one
        // hidden run per role at a time, and turn two keeps its historian child open
        // while it waits on these checks, so queuing them as historian runs would
        // never let them start.
        metadata: { memoryCheck: true },
        system: request.system,
        model: child.model,
        configuredModels: child.model ? [child.model] : [],
        timeoutMs,
        title: `magic-context-memory-check-${request.key.slice(0, 16)}`,
        directory: child.directory,
    });
    let settled = false;
    try {
        await withTimeout(
            executor.attempt(handle, {
                path: { id: handle.id },
                query: { directory: child.directory },
                body: {
                    agent: child.agent,
                    system: request.system,
                    ...modelBodyField(child.model),
                    parts: [{ type: "text", text: renderCheckInput(request), synthetic: true }],
                },
            }),
            timeoutMs,
        ).catch((error) => {
            // A timed-out check is a known check transport failure (the fact is retried
            // with one attempt consumed), not an unknown outcome that keeps it reserved.
            if (error instanceof TurnTwoOutcomeUnknownError) throw new Error("check timed out");
            throw error;
        });
        const completion = await executor.collect(handle, 10);
        settled = true;
        const profile = reportedProfile(
            completion,
            child.model,
            lifecycleTextHash(request.system),
            { ...identity, agent: child.agent },
            CHECK_SCHEMA_CONTRACT,
        );
        if (!profile) throw new Error("check carrier reported no model");
        let verdicts: CheckReply["verdicts"];
        try {
            verdicts = parseCheckVerdicts(completion.text);
        } catch {
            // Unparseable check output becomes an empty verdict list, which the gates
            // treat as a malformed verdict (the decision is refused), not a transport
            // failure (which would retry it).
            verdicts = [];
        }
        return {
            verdicts: completion.lengthCapped ? [] : verdicts,
            profile,
            usage: completion.usage,
            toolActivity: hasHistorianToolActivity(completion),
        };
    } finally {
        await executor.close(handle, {
            promptSettled: settled,
            privacySensitive: false,
            context: "historian-check",
            log: () => {},
        });
    }
}

/**
 * Recovery access to a turn-two send that an earlier run or process left without a
 * known outcome (its stage record still open), for records sent through this
 * carrier kind and harness.
 * - A child this process retained for turn two is reached through the handle the
 *   executor issued for it (OpenCode 2 knows its runs only by that object). While a
 *   turn two here is still working on it, the stage is "busy".
 * - Any other child is reached by its session id. A stage younger than the
 *   historian timeout may still be served by another live process, so it is "busy".
 * A recovered reply carries the profile the provider reported for it, with the
 * historian system hash and variant the stage recorded when it was sent.
 */
export function createOpenCodeTurnTwoRecovery(args: {
    executor: HiddenCompletionExecutor;
    carrier: string;
    harness: string;
    directory: string;
    timeoutMs: number;
    now?: () => number;
}): TurnTwoRecoveryResolver {
    return (record) => {
        if (record.carrier !== args.carrier || record.harness !== args.harness) return null;
        const childId = record.childSessionId;
        if (!childId) return null;
        const retained = retainedTurnTwoChild(childId);
        if (retained?.active) return "busy";
        const young = (args.now?.() ?? Date.now()) - record.startedAt < args.timeoutMs;
        if (!retained && young) return "busy";
        const handle = (retained?.handle as HiddenRunHandle | undefined) ?? {
            id: childId,
            childSessionId: childId,
        };
        return {
            async reattach(): Promise<TurnTwoReattach> {
                let completion: HiddenCompletion;
                try {
                    completion = await args.executor.collect(handle, 50);
                } catch {
                    // For a child retained in this process the run still exists, so a
                    // failed read means its reply has not settled yet. A child known
                    // only by session id that cannot be read no longer exists.
                    return retained ? { kind: "unknown" } : { kind: "gone" };
                }
                const toolActivity = hasHistorianToolActivity(completion);
                if (
                    !toolActivity &&
                    (!completion.text || lifecycleTextHash(completion.text) === record.baseline)
                )
                    return { kind: "unknown" };
                return {
                    kind: "reply",
                    reply: {
                        text: completion.text ?? "",
                        lengthCapped: completion.lengthCapped,
                        toolActivity: hasHistorianToolActivity(completion),
                        profile: recoveredProfile(completion, record),
                        usage: completion.usage,
                    },
                };
            },
            // A check child opened by an earlier process cannot be found again.
            // Rejecting makes the gates treat the check as a transport failure, so
            // the fact it belongs to is retried rather than left reserved forever.
            reattachCheck: () => Promise.reject(new Error("check session is not recoverable")),
            check: () => Promise.reject(new Error("recovered stage cannot open checks")),
            async close() {
                if (retained) {
                    await closeTurnTwoChild(childId);
                    return;
                }
                await args.executor.close(handle, {
                    promptSettled: true,
                    privacySensitive: false,
                    context: "historian-turn-two-recovery",
                    log: () => {},
                });
            },
        };
    };
}

function recoveredProfile(
    completion: HiddenCompletion,
    record: TurnTwoStageRecord,
): ReportedProfile | null {
    const answered = answeredBy(completion);
    if (!answered || !record.historianSystemHash) return null;
    return {
        lane: turnTwoLaneForReport(record),
        carrier: record.carrier,
        provider: answered.provider,
        modelId: answered.modelId,
        variant: record.variant,
        temperature: null,
        thinkingLevel: null,
        systemHash: record.historianSystemHash,
        // Old stage records do not retain the format bytes or the registered agent.
        schemaHash: null,
        toolHash:
            record.harness === "opencode2" && completion.observedToolSurface !== undefined
                ? lifecycleToolHash(completion.observedToolSurface)
                : null,
    };
}
