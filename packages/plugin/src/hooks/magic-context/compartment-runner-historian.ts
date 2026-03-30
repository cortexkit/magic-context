import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORIAN_AGENT } from "../../agents/historian";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../../config/schema/magic-context";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import { extractLatestAssistantText } from "../../shared/assistant-message-extractor";
import { getErrorMessage } from "../../shared/error-message";
import type {
    HistorianProgressCallbacks,
    HistorianRunResult,
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";
import {
    buildHistorianRepairPrompt,
    validateHistorianOutput,
} from "./compartment-runner-validation";

// Intentionally kept: historian validation failure dumps are preserved for debugging.
// These are written to /tmp and survive until manual cleanup or OS temp pruning.
// The user has explicitly requested keeping these dumps for now (see audit #21).
const HISTORIAN_RESPONSE_DUMP_DIR = join(tmpdir(), "magic-context-historian");

export async function runValidatedHistorianPass(args: {
    client: PluginContext["client"];
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
    };
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    callbacks?: HistorianProgressCallbacks;
}): Promise<ValidatedHistorianPassResult> {
    const firstRun = await runHistorianPrompt({
        ...args,
        dumpLabel: `${args.dumpLabelBase}-initial`,
    });
    if (!firstRun.ok || !firstRun.result) {
        return { ok: false, error: firstRun.error ?? "historian run failed" };
    }

    const firstValidation = validateHistorianOutput(
        firstRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (firstValidation.ok) {
        cleanupHistorianDump(args.parentSessionId, firstRun.dumpPath);
        return firstValidation;
    }

    await args.callbacks?.onRepairRetry?.(firstValidation.error ?? "invalid compartment output");
    const repairPrompt = buildHistorianRepairPrompt(
        args.prompt,
        firstRun.result,
        firstValidation.error ?? "invalid compartment output",
    );
    const repairRun = await runHistorianPrompt({
        ...args,
        prompt: repairPrompt,
        dumpLabel: `${args.dumpLabelBase}-repair`,
    });
    if (!repairRun.ok || !repairRun.result) {
        return { ok: false, error: repairRun.error ?? "historian repair run failed" };
    }

    const repairValidation = validateHistorianOutput(
        repairRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (repairValidation.ok) {
        cleanupHistorianDump(args.parentSessionId, firstRun.dumpPath);
        cleanupHistorianDump(args.parentSessionId, repairRun.dumpPath);
    }

    return repairValidation;
}

async function runHistorianPrompt(args: {
    client: PluginContext["client"];
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    timeoutMs?: number;
    dumpLabel?: string;
}): Promise<HistorianRunResult> {
    const { client, parentSessionId, sessionDirectory, prompt, timeoutMs, dumpLabel } = args;
    let agentSessionId: string | null = null;

    try {
        const createResponse = await client.session.create({
            body: {
                parentID: parentSessionId,
                title: "magic-context-compartment",
            },
            query: { directory: sessionDirectory },
        });

        const createdSession = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;

        if (!agentSessionId) {
            return { ok: false, error: "Historian could not create its child session." };
        }

        await shared.promptSyncWithModelSuggestionRetry(
            client,
            {
                path: { id: agentSessionId },
                query: { directory: sessionDirectory },
                body: {
                    agent: HISTORIAN_AGENT,
                    parts: [{ type: "text", text: prompt }],
                },
            },
            { timeoutMs: timeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS },
        );

        const messagesResponse = await client.session.messages({
            path: { id: agentSessionId },
            query: { directory: sessionDirectory },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const result = extractLatestAssistantText(messages);
        if (!result) {
            return { ok: false, error: "Historian returned no assistant output." };
        }

        const dumpPath = dumpHistorianResponse(
            parentSessionId,
            dumpLabel ?? "historian-response",
            result,
        );
        return { ok: true, result, dumpPath };
    } catch (modelError: unknown) {
        const modelMsg = getErrorMessage(modelError);
        const modelStack = modelError instanceof Error ? modelError.stack : undefined;
        shared.sessionLog(parentSessionId, "compartment agent: historian attempt failed", {
            error: modelMsg,
            promptLength: prompt.length,
            stack: modelStack,
        });
        return { ok: false, error: `Historian failed while processing this session: ${modelMsg}` };
    } finally {
        if (agentSessionId) {
            await client.session
                .delete({ path: { id: agentSessionId }, query: { directory: sessionDirectory } })
                .catch((e: unknown) => {
                    shared.sessionLog(
                        parentSessionId,
                        "compartment agent: session cleanup failed",
                        getErrorMessage(e),
                    );
                });
        }
    }
}

function cleanupHistorianDump(sessionId: string, dumpPath?: string): void {
    if (!dumpPath) return;

    try {
        unlinkSync(dumpPath);
    } catch (error: unknown) {
        shared.sessionLog(
            sessionId,
            "compartment agent: failed to remove historian response dump",
            {
                dumpPath,
                error: getErrorMessage(error),
            },
        );
    }
}

function dumpHistorianResponse(sessionId: string, label: string, text: string): string | undefined {
    try {
        mkdirSync(HISTORIAN_RESPONSE_DUMP_DIR, { recursive: true });
        const safeSessionId = sanitizeDumpName(sessionId);
        const safeLabel = sanitizeDumpName(label);
        const dumpPath = join(
            HISTORIAN_RESPONSE_DUMP_DIR,
            `${safeSessionId}-${safeLabel}-${Date.now()}.xml`,
        );
        writeFileSync(dumpPath, text, "utf8");
        shared.sessionLog(sessionId, "compartment agent: historian response dumped", {
            label,
            dumpPath,
        });
        return dumpPath;
    } catch (error: unknown) {
        shared.sessionLog(sessionId, "compartment agent: failed to dump historian response", {
            label,
            error: getErrorMessage(error),
        });
        return undefined;
    }
}

function sanitizeDumpName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
