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
import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
} from "./compartment-runner-types";

export type RescoreRecovery =
    | { state: "completed"; completion: HiddenCompletion }
    | { state: "active" | "unavailable" | "unknown" };
export class RescorePayloadError extends Error {}
export class RescoreCarrierActiveError extends Error {}

export function validateRescoreCompletion(
    completion: HiddenCompletion,
    profile: RescoreModelProfile,
): string {
    const model = splitModel(profile.model);
    if (!model) throw new Error("No historian model configured for rescore");
    if (
        (completion.providerId && completion.providerId !== model.providerID) ||
        (completion.modelId && completion.modelId !== model.modelID)
    ) {
        throw new Error("Score carrier answered with a different model than the frozen profile");
    }
    if (completion.failed || completion.lengthCapped || !completion.text)
        throw new Error("Score completion failed, empty or length capped");
    return completion.text;
}

export interface RescoreCarrier {
    complete(
        request: RescoreAdmission,
        signal: AbortSignal,
        opened: (id: string, previousId?: string) => boolean,
        stage?: (text: string) => boolean,
    ): Promise<string>;
    /** Reads a finished durable child only. Never opens or prompts a child. */
    recover(id: string): Promise<RescoreRecovery>;
    /** Resolves true only after the previous inference is known to be terminal. */
    interrupt(id: string): Promise<boolean>;
    release?(id: string, preserveRecovery?: boolean): Promise<void>;
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
    const active = new Map<string, Promise<void>>();
    return {
        async complete(request, signal, opened, stage) {
            const reference = request.profile.model;
            const model = splitModel(reference);
            if (!model || !reference) throw new Error("No historian model configured for rescore");
            let handle: HiddenRunHandle | null = null;
            let settled = false;
            let accepted = false;
            let staged = false;
            let unsafeToClose = false;
            let finished!: () => void;
            const done = new Promise<void>((resolve) => {
                finished = resolve;
            });
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
                active.set(handle.id, done);
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
                const text = validateRescoreCompletion(completion, request.profile);
                accepted = true;
                if (stage) {
                    try {
                        staged = stage(text);
                    } catch {
                        throw new RescorePayloadError("Score payload could not be staged");
                    }
                    if (!staged)
                        throw new RescoreCarrierActiveError(
                            "Score owner lost before payload staging",
                        );
                }
                return text;
            } catch (error) {
                if (handle && !settled) {
                    try {
                        await executor.interrupt?.(handle.id);
                    } catch {
                        unsafeToClose = true;
                        throw new RescoreCarrierActiveError(
                            "Score child termination could not be confirmed",
                        );
                    }
                }
                throw error;
            } finally {
                try {
                    try {
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
                    } finally {
                        await executor.close(handle, {
                            promptSettled: settled,
                            retainForRecovery: unsafeToClose || (accepted && !staged),
                            privacySensitive: false,
                            context: "rescore",
                            log: () => {},
                        });
                    }
                } finally {
                    if (handle) active.delete(handle.id);
                    finished();
                }
            }
        },
        async recover(id) {
            if (active.has(id)) return { state: "active" };
            const state = await executor.recoveryState?.(id);
            if (state === "active") return { state };
            const completion = await executor.recover?.(id);
            if (completion) return { state: "completed", completion };
            return {
                state: state === "terminal" || state === "unavailable" ? "unavailable" : "unknown",
            };
        },
        async interrupt(id) {
            if (!executor.interrupt) return false;
            await executor.interrupt(id);
            await active.get(id);
            return true;
        },
        async release(id, preserveRecovery) {
            if (preserveRecovery) return;
            await executor.close(
                { id },
                { promptSettled: true, privacySensitive: false, context: "rescore", log: () => {} },
            );
        },
    };
}

/** Recovery never admits a paid call; an explicit resume is a separate operation. */
export async function recoverRescore(
    service: RescoreService,
    authority: RescoreAuthority,
    carrier: RescoreCarrier,
): Promise<void> {
    if (!service.hasAuthority(authority)) return;
    const status = service.status(authority.jobId);
    const attempt = status.attempts.find((attempt) => attempt.state === "admitted");
    if (!attempt) return;
    let recovered: RescoreRecovery = { state: "unavailable" };
    if (attempt.carrier_run_id) {
        try {
            recovered = await carrier.recover(attempt.carrier_run_id);
            if (recovered.state === "active" && service.hasAuthority(authority)) {
                if (!(await carrier.interrupt(attempt.carrier_run_id))) {
                    service.waitForCarrier(authority, attempt.id);
                    return;
                }
                recovered = await carrier.recover(attempt.carrier_run_id);
                if (recovered.state === "active") recovered = { state: "unavailable" };
            }
        } catch {
            recovered = { state: "unknown" };
        }
    }
    if (recovered.state === "active" || recovered.state === "unknown") {
        service.waitForCarrier(authority, attempt.id);
        return;
    }
    if (!service.hasAuthority(authority)) return;
    // A staged payload is authoritative, but the carrier must be terminal before its reservation is released.
    const published = service.publish(authority, attempt.id);
    if (published) {
        if (attempt.carrier_run_id) await carrier.release?.(attempt.carrier_run_id);
        return;
    }
    if (recovered.state === "completed") {
        let text: string;
        try {
            text = validateRescoreCompletion(
                recovered.completion,
                JSON.parse(status.job.model_profile) as RescoreModelProfile,
            );
        } catch {
            const receipt = service.fail(authority, attempt.id, {
                class: "invalid-completion",
                message:
                    "Recovered score completion is failed, length capped or outside the frozen model",
            });
            if (attempt.carrier_run_id) await carrier.release?.(attempt.carrier_run_id, !receipt);
            return;
        }
        try {
            if (!service.persistPayload(authority, attempt.id, text)) return;
        } catch {
            const receipt = service.fail(authority, attempt.id, {
                class: "invalid-payload",
                message: "Recovered score payload is invalid",
            });
            if (attempt.carrier_run_id) await carrier.release?.(attempt.carrier_run_id, !receipt);
            return;
        }
        if (attempt.carrier_run_id) await carrier.release?.(attempt.carrier_run_id);
        service.publish(authority, attempt.id);
    } else {
        const receipt = service.abandon(authority, attempt.id);
        if (attempt.carrier_run_id) await carrier.release?.(attempt.carrier_run_id, !receipt);
    }
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
                await recoverRescore(service, authority, carrier);
                if (service.status(authority.jobId).job.pause_reason === "carrier-active") return;
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
            let carrierId: string | undefined;
            try {
                if (!admission.profile.model)
                    throw new Error("No historian model configured for rescore");
                text = await carrier.complete(
                    admission,
                    controller.signal,
                    (id, previousId) => {
                        if (
                            !service.recordCarrier(
                                authority,
                                admission.attempt.id,
                                id,
                                previousId ?? null,
                            )
                        )
                            return false;
                        carrierId = id;
                        return true;
                    },
                    (body) => service.persistPayload(authority, admission.attempt.id, body),
                );
            } catch (error) {
                if (error instanceof RescoreCarrierActiveError) {
                    service.waitForCarrier(authority, admission.attempt.id);
                    return;
                }
                // Carrier/provider failures are messages, not score output or parsed reasons.
                const receipt = service.fail(authority, admission.attempt.id, {
                    class:
                        error instanceof RescorePayloadError ? "invalid-payload" : "model-failure",
                    message: error instanceof Error ? error.message : "Score carrier failed",
                });
                if (carrierId) await carrier.release?.(carrierId, !receipt);
                continue;
            }
            try {
                if (!service.persistPayload(authority, admission.attempt.id, text)) {
                    if (carrierId) await carrier.release?.(carrierId, true);
                    return;
                }
            } catch {
                const receipt = service.fail(authority, admission.attempt.id, {
                    class: "invalid-payload",
                    message: "Score payload is invalid",
                });
                if (carrierId) await carrier.release?.(carrierId, !receipt);
                continue;
            }
            if (carrierId) await carrier.release?.(carrierId);
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
    if (service.status(authority.jobId).job.pause_reason === "carrier-active") return false;
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
    await Promise.all(
        ids.map(async (id) => {
            try {
                if (await carrier.interrupt(id)) await carrier.release?.(id);
            } catch {
                /* The cancelled spend record remains even when the host cannot acknowledge interruption. */
            }
        }),
    );
}
