import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import type { V2Context } from "./types";

/** Once-per-process latch: the model-limit cache is process-global. */
let warmStarted = false;

/**
 * Build the `config.providers()` payload `refreshModelLimitsFromApi` consumes
 * from the v2 host's own model catalog. Each raw catalog row is passed through
 * (limit, capabilities, modalities, …) so the shared cache applies exactly the
 * same sane-filtering and output-reservation logic as the v1 boot warm.
 */
export function catalogProvidersPayload(listed: unknown): Array<{
    id: string;
    models: Record<string, Record<string, unknown>>;
}> {
    const rows = Array.isArray(listed)
        ? listed
        : listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
          ? (listed as { data: unknown[] }).data
          : [];
    const byProvider = new Map<string, Record<string, Record<string, unknown>>>();
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const entry = row as { id?: unknown; providerID?: unknown };
        if (typeof entry.id !== "string" || typeof entry.providerID !== "string") continue;
        const models = byProvider.get(entry.providerID) ?? {};
        models[entry.id] = entry as Record<string, unknown>;
        byProvider.set(entry.providerID, models);
    }
    return [...byProvider.entries()].map(([id, models]) => ({ id, models }));
}

/**
 * Seed Magic Context's model-limit cache from the v2 host catalog.
 *
 * The v1 lane warms `models-dev-cache` from its SDK client at boot. The v2 lane
 * has no SDK client and its harness-scoped persisted file starts empty, so every
 * limit resolved on this lane fell back to the generic 200k default — the
 * sidebar denominator, history budgets and window geometry all disagreed with
 * the transform's own catalog math. `context.model.list()` is the same resolved
 * catalog the host itself uses, so feeding it through the shared refresh keeps
 * one source of truth and persists a last-known-good file for cold starts.
 */
export async function warmModelLimitCacheFromCatalog(context: V2Context): Promise<void> {
    if (warmStarted) return;
    warmStarted = true;
    try {
        await refreshModelLimitsFromApi(
            {
                config: {
                    providers: async () => ({
                        data: {
                            providers: catalogProvidersPayload(
                                await Promise.resolve(context.model.list()),
                            ),
                        },
                    }),
                },
            },
            { retries: 3, retryDelayMs: 1000 },
        );
    } catch (error) {
        sessionLog("global", `v2 model-limit cache warm failed: ${getErrorMessage(error)}`);
    }
}
