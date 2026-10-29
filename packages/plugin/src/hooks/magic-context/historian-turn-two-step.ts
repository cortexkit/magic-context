/**
 * Runs historian turn two after turn one's publication committed, on the child
 * turn one ran in. Only a lane enabled by `selectTurnOneExecution` reaches this.
 */

import { HISTORIAN_AGENT } from "../../agents/historian";
import type { ReportedProfile } from "../../features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import { HISTORIAN_FORMAT_INSTRUCTION } from "../../features/magic-context/memory/turn-one-publication";
import {
    buildTurnOneAuthorizationRequest,
    runTurnTwo,
    type TurnTwoRunResult,
} from "../../features/magic-context/memory/turn-two";
import {
    type TurnTwoTrialAuthorization,
    turnTwoLaneForReport,
} from "../../features/magic-context/memory/turn-two-allowlist";
import {
    closeTurnTwoChild,
    registerTurnTwoChild,
    retainedTurnTwoChild,
} from "../../features/magic-context/memory/turn-two-children";
import type { TurnTwoQueryEmbedder } from "../../features/magic-context/memory/turn-two-retrieval";
import type { TurnTwoExcerptReader } from "../../features/magic-context/memory/turn-two-scoring";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/project-embedding-registry";
import { needsBlockedRead } from "../../shared/hidden-zen-read";
import { sessionLog } from "../../shared/logger";
import type { ModelInput } from "../../shared/model-resolution";
import { toModelEntry } from "../../shared/resolve-fallbacks";
import type { Database } from "../../shared/sqlite";
import type { RetainedHistorianChild } from "./compartment-runner-types";
import {
    createOpenCodeTurnTwoCarrier,
    createOpenCodeTurnTwoRecovery,
    openCodeTurnTwoToolSurface,
} from "./historian-turn-two-carrier";
import { readSessionChunk } from "./read-session-chunk";

/** Build identity from the same agent registration and context-hook surface the carriers use. */
export function openCodeTurnOneAuthorization(input: {
    harness: string;
    carrier: string;
    model?: ModelInput;
    system: string;
}) {
    const entry = toModelEntry(input.model);
    const route = entry?.model ?? "";
    const slash = route.indexOf("/");
    const provider = slash < 0 ? "" : route.slice(0, slash);
    const lane = turnTwoLaneForReport(input);
    const blocked = needsBlockedRead(HISTORIAN_AGENT, provider);
    const toolSurface =
        openCodeTurnTwoToolSurface({
            ...input,
            provider,
            agent: HISTORIAN_AGENT,
            observedToolSurface: blocked ? ["read"] : [],
        }) ?? [];
    return buildTurnOneAuthorizationRequest(
        {
            lane: lane!,
            carrier: input.carrier as "hidden-completion" | "opencode-session",
            provider,
            modelId: slash < 0 ? route : route.slice(slash + 1),
            variant: entry?.qualifier ?? null,
            temperature: null,
            thinkingLevel: null,
        },
        {
            system: input.system,
            formatInstruction: HISTORIAN_FORMAT_INSTRUCTION,
            toolSurface,
            checkToolSurface: toolSurface,
        },
    );
}

/** Reads a save's excerpt window from the session's raw source. */
export const readTurnTwoExcerpt: TurnTwoExcerptReader = (sessionId, from, to) => {
    const chunk = readSessionChunk(sessionId, Number.MAX_SAFE_INTEGER, from, to + 1, {
        singleMessageLines: true,
    });
    const blocks = (chunk.printedBlocks ?? []).filter(
        (block) => block.startOrdinal >= from && block.endOrdinal <= to,
    );
    if (blocks.length === 0) return null;
    const ordinals: number[] = [];
    for (const block of blocks)
        for (let ordinal = block.startOrdinal; ordinal <= block.endOrdinal; ordinal++)
            ordinals.push(ordinal);
    const text = blocks
        .map(
            (block) =>
                `[${block.startOrdinal === block.endOrdinal ? block.startOrdinal : `${block.startOrdinal}-${block.endOrdinal}`}] ${block.role}: ${block.parts.join(" / ")}`,
        )
        .join("\n");
    return { text, ordinals };
};

/** Embeds a fact under the project's current embedding model, for neighbour ranking. */
function projectEmbedder(projectPath: string): TurnTwoQueryEmbedder {
    return async (text) => {
        if (!getProjectEmbeddingSnapshot(projectPath)) return null;
        const embedded = await embedTextForProject(projectPath, text);
        return embedded ? { vector: embedded.vector, modelId: embedded.modelId } : null;
    };
}

type HistorianTurnTwoArgs = Parameters<typeof runHistorianTurnTwo>[0];

const scheduled = new Set<Promise<void>>();

/**
 * Run turn two after the compartment run that published turn one has settled, as its
 * own background task: it holds neither the session's compartment lease nor the run
 * a transform waits for at high context pressure, so a user request never waits on
 * turn two or its checks. The task owns the retained child: it closes it when turn
 * two resolves, and otherwise leaves it registered (see turn-two-children.ts) for
 * recovery or session deletion to close.
 */
export function scheduleHistorianTurnTwo(args: HistorianTurnTwoArgs): void {
    const childId = args.child.handle.childSessionId ?? args.child.handle.id;
    registerTurnTwoChild({
        childSessionId: childId,
        parentSessionId: args.sessionId,
        harness: args.harness,
        handle: args.child.handle,
        active: true,
        close: () => args.child.close(),
    });
    const task = new Promise<void>((resolve) => setTimeout(resolve, 0))
        .then(() => runHistorianTurnTwo(args))
        .then(
            async (result) => {
                const retained = retainedTurnTwoChild(childId);
                if (retained) retained.active = false;
                if (!result.childInFlight) await closeTurnTwoChild(childId);
            },
            async (error) => {
                sessionLog(args.sessionId, "historian turn two failed:", error);
                const retained = retainedTurnTwoChild(childId);
                if (retained) retained.active = false;
                // Facts it reserved stay in flight until recovery gives the stage up,
                // which closes the child; with nothing reserved, close it now.
                if (!hasOpenTurnTwoStage(args.db, childId)) await closeTurnTwoChild(childId);
            },
        );
    scheduled.add(task);
    void task.finally(() => scheduled.delete(task));
}

/** True when a turn-two stage carried by this child has not finished. */
function hasOpenTurnTwoStage(db: Database, childId: string): boolean {
    return (
        db
            .prepare(
                "SELECT 1 FROM memory_stage_attempts WHERE stage='turn_two' AND child_session_id=? AND state IN ('reserved','sending','replied') LIMIT 1",
            )
            .get(childId) != null
    );
}

/** Wait until every scheduled turn two of this process has settled (tests, shutdown). */
export async function settleHistorianTurnTwoRuns(): Promise<void> {
    while (scheduled.size > 0) await Promise.allSettled([...scheduled]);
}

export async function runHistorianTurnTwo(args: {
    db: Database;
    sessionId: string;
    projectPath: string;
    publicationId: string;
    child: RetainedHistorianChild;
    harness: string;
    carrier: string;
    memoryEnabled: boolean;
    autoPromote: boolean;
    timeoutMs: number;
    validatedProfiles?: readonly ReportedProfile[];
    trialAuthorization?: TurnTwoTrialAuthorization;
    formatInstructions?: string;
    beforeResolve?: () => Promise<boolean | void>;
    embedQuery?: TurnTwoQueryEmbedder;
}): Promise<TurnTwoRunResult> {
    const log = (message: string) => sessionLog(args.sessionId, message);
    const carrier = createOpenCodeTurnTwoCarrier({
        child: args.child,
        parentSessionId: args.sessionId,
        harness: args.harness,
        carrier: args.carrier,
        turnOneText: args.child.turnOneText,
        timeoutMs: args.timeoutMs,
        formatInstructions: args.formatInstructions,
    });
    const recovery = createOpenCodeTurnTwoRecovery({
        executor: args.child.executor,
        carrier: args.carrier,
        harness: args.harness,
        directory: args.child.directory,
        timeoutMs: args.timeoutMs,
    });
    if ((await args.beforeResolve?.()) === false)
        return { status: "skipped", reason: "turn_two_off", childInFlight: false };
    const result = await runTurnTwo(args.db, {
        projectPath: args.projectPath,
        publicationId: args.publicationId,
        sessionId: args.sessionId,
        // Only an enabled lane retains turn one's child and reaches this step.
        // The carrier requests the prompt contract, and replies are validated locally.
        lane: "enabled",
        carrier: {
            ...carrier,
            send: async (...input) => {
                if ((await args.beforeResolve?.()) === false)
                    throw new Error("Turn two was revoked before send");
                try {
                    return await carrier.send(...input);
                } finally {
                    await args.beforeResolve?.();
                }
            },
            check: async (...input) => {
                if ((await args.beforeResolve?.()) === false)
                    throw new Error("Turn two was revoked before check");
                try {
                    return await carrier.check(...input);
                } finally {
                    await args.beforeResolve?.();
                }
            },
        },
        memoryEnabled: args.memoryEnabled,
        autoPromote: args.autoPromote,
        validatedProfiles: args.validatedProfiles,
        trialAuthorization: args.trialAuthorization,
        embedQuery: args.embedQuery ?? projectEmbedder(args.projectPath),
        readExcerpt: readTurnTwoExcerpt,
        recover: (record) => {
            const recovered = recovery(record);
            if (!recovered || recovered === "busy") return recovered;
            return {
                ...recovered,
                check: async (...input) => {
                    if ((await args.beforeResolve?.()) === false)
                        throw new Error("Recovered stage was revoked before check");
                    try {
                        return await recovered.check(...input);
                    } finally {
                        await args.beforeResolve?.();
                    }
                },
                reattach: async () => {
                    try {
                        return await recovered.reattach();
                    } finally {
                        await args.beforeResolve?.();
                    }
                },
                reattachCheck: recovered.reattachCheck
                    ? async (...input) => {
                          try {
                              return await recovered.reattachCheck!(...input);
                          } finally {
                              await args.beforeResolve?.();
                          }
                      }
                    : undefined,
            };
        },
        log,
    });
    log(
        `historian turn two: ${result.status}${result.reason ? ` (${result.reason})` : ""}${result.childInFlight ? "; child kept open while a stage is in flight" : ""} historianSystem=${lifecycleTextHash(args.child.system).slice(0, 12)}`,
    );
    return result;
}
