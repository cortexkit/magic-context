import type { HiddenCompletionExecutor } from "../hooks/magic-context/compartment-runner-types";
import { BoundedSessionMap } from "../shared/bounded-session-map";
import { dreamerRunConfig } from "./live-run-config";
import type { MagicContextConfig } from "./schema/magic-context";

const historianCaps = new BoundedSessionMap<{ value: number | undefined }>(4096);
const rescoreSampling = new BoundedSessionMap<{ cap: number; temperature: number }>(4096);

export function rememberRescoreSampling(sessionId: string, cap: number, temperature: number) {
    rescoreSampling.set(sessionId, { cap, temperature });
}

export function forgetRescoreSampling(sessionId: string) {
    rescoreSampling.delete(sessionId);
}

/** Keep the historian child session's output cap fixed across later config changes. */
export function rememberHistorianOutputCap(sessionId: string, cap: number | undefined) {
    historianCaps.set(sessionId, { value: cap });
}

export function forgetHistorianOutputCap(sessionId: string) {
    historianCaps.delete(sessionId);
}

/** Set a hidden child's output cap when it opens, without changing later attempts in that child. */
export function withLiveDreamerOutputCap<T extends MagicContextConfig>(
    executor: HiddenCompletionExecutor,
    boot: T,
    fresh: () => T,
): HiddenCompletionExecutor {
    return {
        capabilities: executor.capabilities,
        open: (run) =>
            executor.open({
                ...run,
                maxOutputTokens: dreamerRunConfig(boot, fresh()).dreamer?.maxTokens,
            }),
        attempt: (handle, request) => executor.attempt(handle, request),
        collect: (handle, limit) => executor.collect(handle, limit),
        close: (handle, settlement) => executor.close(handle, settlement),
    };
}

/** Retain the OpenCode 1 child's cap across its provider requests, including tool turns. */
export function createDreamerOutputCapSampler<T extends MagicContextConfig>(
    boot: T,
    fresh: () => T,
) {
    const caps = new BoundedSessionMap<{ value: number | undefined }>(4096);
    return {
        apply(
            input: { sessionID: string; agent: string },
            output: { maxOutputTokens: number | undefined; temperature?: number },
        ) {
            if (input.agent === "rescore") {
                const sampling = rescoreSampling.get(input.sessionID);
                if (sampling) {
                    output.maxOutputTokens = sampling.cap;
                    output.temperature = sampling.temperature;
                }
                return;
            }
            // An unset cap must leave the host's own output limit in place. Writing
            // `undefined` over it removes the limit OpenCode computed from the model,
            // and some providers then send no usable max_tokens (a local Anthropic-
            // compatible server answered every historian run with zero output).
            if (input.agent.startsWith("historian")) {
                const historian = historianCaps.get(input.sessionID);
                if (historian?.value !== undefined) output.maxOutputTokens = historian.value;
                return;
            }
            if (
                input.agent !== "dreamer" &&
                !input.agent.startsWith("dreamer-") &&
                input.agent !== "smart-note-compiler"
            )
                return;
            let cap = caps.get(input.sessionID);
            if (!cap) {
                cap = { value: dreamerRunConfig(boot, fresh()).dreamer?.maxTokens };
                caps.set(input.sessionID, cap);
            }
            if (cap.value !== undefined) output.maxOutputTokens = cap.value;
        },
        delete(sessionId: string) {
            caps.delete(sessionId);
            forgetHistorianOutputCap(sessionId);
            forgetRescoreSampling(sessionId);
        },
    };
}
