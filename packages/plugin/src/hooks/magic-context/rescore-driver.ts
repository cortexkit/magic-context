import type {
    RescoreAdmission,
    RescoreAuthority,
    RescoreModelProfile,
    RescoreService,
} from "../../features/magic-context/rescore-service";
import { RESCORE_HEARTBEAT_MS } from "../../features/magic-context/rescore-service";
import { recordSubagentInvocation } from "../../features/magic-context/storage-subagent-invocations";
import type { HarnessId } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";
import { historianPromptAdmissionFailure } from "./compartment-runner-historian";
import type { HiddenCompletionExecutor, HiddenRunHandle } from "./compartment-runner-types";

export interface RescoreCarrier {
    complete(
        request: RescoreAdmission,
        signal: AbortSignal,
        opened: (id: string) => boolean,
    ): Promise<string>;
    /** Reads a finished durable child only. Never opens or prompts a child. */
    recover(id: string): Promise<string | null>;
    interrupt(id: string): Promise<void>;
}

export function rescoreAdmissionFailure(parentSessionId: string) {
    return (prompt: string, system: string, profile: RescoreModelProfile): string | null =>
        historianPromptAdmissionFailure({
            prompt,
            system,
            parentSessionId,
            model: splitModel(profile.model),
            maxOutputTokens: profile.maxOutputTokens,
        });
}
export function splitModel(model: string | null) {
    if (!model) return undefined;
    const [providerID, ...rest] = model.split("/");
    if (!providerID || !rest.join("/")) throw new Error("Invalid rescore model");
    return { providerID, modelID: rest.join("/") };
}

export function createOpenCodeRescoreCarrier(options: {
    executor: HiddenCompletionExecutor;
    db: Database;
    sessionId: string;
    harness: HarnessId;
    directory: string;
    timeoutMs: number;
}): RescoreCarrier {
    const { executor } = options;
    return {
        async complete(request, signal, opened) {
            const reference = request.profile.model;
            const model = splitModel(reference);
            if (!model || !reference) throw new Error("No historian model configured for rescore");
            let handle: HiddenRunHandle | null = null;
            let settled = false;
            let accepted = false;
            const start = Date.now();
            let completion: Awaited<ReturnType<HiddenCompletionExecutor["collect"]>> | undefined;
            try {
                handle = await executor.open({
                    kind: "rescore",
                    agent: "rescore",
                    title: "magic-context-rescore",
                    system: request.system,
                    model: { model: reference, qualifier: request.profile.variant },
                    configuredModels: [{ model: reference, qualifier: request.profile.variant }],
                    parentSessionId: options.sessionId,
                    directory: options.directory,
                    timeoutMs: options.timeoutMs,
                    maxOutputTokens: request.profile.maxOutputTokens,
                    metadata: { temperature: request.profile.temperature },
                });
                if (!opened(handle.childSessionId ?? handle.id) || signal.aborted)
                    throw new Error("Rescore owner lost before prompt");
                await executor.attempt(handle, {
                    path: { id: handle.id },
                    query: { directory: options.directory },
                    signal,
                    body: {
                        agent: "rescore",
                        model,
                        variant: request.profile.variant,
                        system: request.system,
                        temperature: request.profile.temperature,
                        maxTokens: request.profile.maxOutputTokens,
                        tools: {},
                        parts: [{ type: "text", text: request.prompt }],
                    },
                });
                settled = true;
                completion = await executor.collect(handle, 10);
                if (
                    (completion.providerId && completion.providerId !== model.providerID) ||
                    (completion.modelId && completion.modelId !== model.modelID)
                )
                    throw new Error(
                        "Score carrier answered with a different model than the frozen profile",
                    );
                if (completion.lengthCapped || !completion.text)
                    throw new Error("Score completion empty or length capped");
                accepted = true;
                return completion.text;
            } finally {
                recordSubagentInvocation(options.db, {
                    sessionId: options.sessionId,
                    harness: options.harness,
                    subagent: "rescore",
                    task: request.attempt.id,
                    providerId: completion?.providerId ?? model.providerID,
                    modelId: completion?.modelId ?? model.modelID,
                    startedAt: start,
                    endedAt: Date.now(),
                    status: accepted ? "completed" : signal.aborted ? "aborted" : "failed",
                    inputTokens: completion?.usage.input ?? 0,
                    outputTokens: completion?.usage.output ?? 0,
                    cacheReadTokens: completion?.usage.cacheRead ?? 0,
                    cacheWriteTokens: completion?.usage.cacheWrite ?? 0,
                });
                await executor.close(handle, {
                    promptSettled: settled,
                    privacySensitive: false,
                    context: "rescore",
                    log: () => {},
                });
            }
        },
        async recover(id) {
            return executor.recover ? ((await executor.recover(id))?.text ?? null) : null;
        },
        async interrupt(id) {
            await executor.interrupt?.(id);
        },
    };
}

/** Recovery never admits a paid call; an explicit resume is a separate operation. */
export async function recoverRescore(
    service: RescoreService,
    authority: RescoreAuthority,
    carrier: RescoreCarrier,
): Promise<void> {
    const attempt = service
        .status(authority.jobId)
        .attempts.find((attempt) => attempt.state === "admitted");
    if (!attempt) return;
    // Status intentionally omits private payloads. Publication reads staging directly.
    const published = service.publish(authority, attempt.id);
    if (published) return;
    let text: string | null = null;
    if (attempt.carrier_run_id) {
        try {
            text = await carrier.recover(attempt.carrier_run_id);
        } catch {
            /* Unreadable children retain their admitted spend record. */
        }
    }
    if (text !== null) {
        try {
            if (!service.persistPayload(authority, attempt.id, text)) return;
        } catch {
            service.fail(authority, attempt.id, {
                class: "invalid-payload",
                message: "Recovered score payload is invalid",
            });
            return;
        }
        service.publish(authority, attempt.id);
    } else service.abandon(authority, attempt.id);
}

export async function driveRescore(
    service: RescoreService,
    authority: RescoreAuthority,
    carrier: RescoreCarrier,
    options: { recoveryOnly?: boolean } = {},
): Promise<void> {
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
        try {
            if (!service.heartbeat(authority)) controller.abort();
        } catch {
            controller.abort();
        }
    }, RESCORE_HEARTBEAT_MS);
    try {
        while (!controller.signal.aborted) {
            const existing = service
                .status(authority.jobId)
                .attempts.find((attempt) => attempt.state === "admitted");
            if (existing) {
                const result = service.publish(authority, existing.id);
                if (!result) return;
                if (result.state === "waiting") {
                    await waitForHeartbeat(controller.signal);
                    continue;
                }
            }
            if (options.recoveryOnly) return;
            const admission = service.admit(authority);
            if (!admission) return;
            let text: string;
            try {
                if (!admission.profile.model)
                    throw new Error("No historian model configured for rescore");
                text = await carrier.complete(admission, controller.signal, (id) =>
                    service.recordCarrier(authority, admission.attempt.id, id),
                );
            } catch (error) {
                // Carrier/provider failures are messages, not score output or parsed reasons.
                service.fail(authority, admission.attempt.id, {
                    class: "model-failure",
                    message: error instanceof Error ? error.message : "Score carrier failed",
                });
                continue;
            }
            try {
                if (!service.persistPayload(authority, admission.attempt.id, text)) return;
            } catch {
                service.fail(authority, admission.attempt.id, {
                    class: "invalid-payload",
                    message: "Score payload is invalid",
                });
                continue;
            }
            for (;;) {
                const result = service.publish(authority, admission.attempt.id);
                if (!result) return;
                if (result.state !== "waiting") break;
                await waitForHeartbeat(controller.signal);
                if (controller.signal.aborted) return;
            }
        }
    } finally {
        clearInterval(heartbeat);
    }
}

function waitForHeartbeat(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(done, RESCORE_HEARTBEAT_MS);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
    });
}

export async function resumeRescore(
    service: RescoreService,
    authority: RescoreAuthority,
    carrier: RescoreCarrier,
): Promise<boolean> {
    await recoverRescore(service, authority, carrier);
    await driveRescore(service, authority, carrier, { recoveryOnly: true });
    if (!service.resume(authority)) return false;
    await driveRescore(service, authority, carrier);
    return true;
}

export async function cancelRescore(
    service: RescoreService,
    jobId: string,
    carrier: RescoreCarrier,
): Promise<void> {
    const ids = service.cancel(jobId);
    await Promise.all(ids.map((id) => carrier.interrupt(id).catch(() => {})));
}
