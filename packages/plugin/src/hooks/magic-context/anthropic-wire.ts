import type { PluginContext } from "../../plugin/types";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { log } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";

/**
 * Which `(providerID, modelID)` pairs ride OpenCode's Anthropic transport.
 *
 * OpenCode filters empty text/reasoning parts off the wire in exactly ONE
 * branch, and that branch is gated on the resolved adapter —
 * `model.api.npm === "@ai-sdk/anthropic"` — not on the provider id. Magic
 * Context's empty-part sentinels are only valid inside that branch, so the
 * capability has to come from the same fact OpenCode itself uses.
 *
 * The provider id is the wrong key twice over. A custom provider in
 * `opencode.json` can declare `npm: "@ai-sdk/anthropic"` under any id (a
 * Bedrock or Vertex gateway fronted by an Anthropic-format API), and one
 * provider can serve different models through different adapters. So the
 * answer is read per model from `client.provider.list()`, and never asserted by
 * configuration: neither a repo nor a user can declare a wire format that
 * OpenCode does not actually use.
 *
 * Only `@ai-sdk/anthropic` qualifies. `@ai-sdk/amazon-bedrock` (Converse) and
 * `@ai-sdk/google-vertex/anthropic` run their own transforms and stay excluded,
 * as documented on `modelAcceptsEmptyContent` in `sentinel.ts`.
 */
const ANTHROPIC_WIRE_NPM = "@ai-sdk/anthropic";

/** Bound the lookup so a hung local request cannot stall the transform. */
const LOOKUP_DEADLINE_MS = 5_000;

/**
 * Retry window after a failed lookup. Long enough that a broken local API is not
 * re-probed on every transform pass, short enough that a session recovers without
 * a restart. Mirrors the 60s TTL the Synapse discovery probe already uses
 * (`plugin/embedding-routing.ts`), so both retry latches read the same way.
 */
const RETRY_COOLDOWN_MS = 60_000;

/**
 * Nested rather than a `providerID/modelID` string: model ids routinely contain
 * slashes (`@bedrock-region/vendor.model`, `anthropic/claude-*`), so a joined key
 * makes distinct pairs collide.
 */
let wireModelsByProvider: ReadonlyMap<string, ReadonlySet<string>> = new Map();
let loadPromise: Promise<void> | undefined;
let registryLoaded = false;
let lastFailureAt = 0;

/**
 * True when this exact model is serialized in Anthropic's message format,
 * whatever its provider is called in `opencode.json`.
 *
 * Fails closed: an unloaded registry, a missing model id, and a provider that
 * `provider.list()` never reported all answer `false`, which leaves native
 * parts in place — the behavior before this capability existed.
 */
export function isAnthropicWireModel(providerID?: string, modelID?: string): boolean {
    if (!providerID || !modelID) return false;
    return wireModelsByProvider.get(providerID)?.has(modelID) === true;
}

/**
 * Read the adapter of every configured model once per process.
 *
 * A SUCCESSFUL load is memoized on the promise, so concurrent transform passes
 * await one shared load and every later pass reads the same answer. That answer
 * has to be stable: `modelAcceptsEmptyContent` decides provider-visible bytes,
 * so a flip mid-session rewrites an already-served prefix.
 *
 * A FAILED load is not memoized: answering `false` is the more dangerous
 * direction (see `resolveEmptySentinelCapability`), so it retries after a
 * cooldown while that resolver holds the session's answer steady in the meantime.
 */
export function ensureAnthropicWireModelsLoaded(client?: PluginContext["client"]): Promise<void> {
    if (loadPromise) return loadPromise;
    if (!client) return Promise.resolve();
    if (lastFailureAt > 0 && Date.now() - lastFailureAt < RETRY_COOLDOWN_MS) {
        return Promise.resolve();
    }
    const attempt = loadAnthropicWireModels(client).then((loaded) => {
        if (loaded) return;
        lastFailureAt = Date.now();
        // This callback runs after the synchronous assignment below, so no
        // concurrent awaiter can observe a cleared memo and fire a second lookup;
        // clearing here only re-opens the slot for a later attempt.
        loadPromise = undefined;
    });
    loadPromise = attempt;
    return attempt;
}

async function loadAnthropicWireModels(client: PluginContext["client"]): Promise<boolean> {
    try {
        // Read structurally: the plugin's SDK client types do not declare `api`
        // on a model, so a typed access would not compile.
        const response = await Promise.race([
            client.provider.list(),
            new Promise<undefined>((resolve) =>
                setTimeout(() => resolve(undefined), LOOKUP_DEADLINE_MS),
            ),
        ]);
        const providers: unknown = isRecord(response?.data) ? response.data.all : undefined;
        if (!Array.isArray(providers)) {
            log(
                `anthropic wire model lookup returned no provider list (${response === undefined ? "timed out" : "unexpected shape"}); retrying later`,
            );
            return false;
        }
        const next = new Map<string, Set<string>>();
        let modelCount = 0;
        for (const provider of providers) {
            if (!isRecord(provider)) continue;
            const providerID = provider.id;
            if (typeof providerID !== "string" || providerID.length === 0) continue;
            const models = provider.models;
            if (!isRecord(models)) continue;
            for (const [recordKey, model] of Object.entries(models)) {
                modelCount += 1;
                const api = isRecord(model) ? model.api : undefined;
                if (!isRecord(api) || api.npm !== ANTHROPIC_WIRE_NPM) continue;
                const ids = next.get(providerID) ?? new Set<string>();
                // The record key and `model.id` are the same string in every
                // OpenCode release observed, and the harness reports one of them
                // as its model id. Registering both stops a divergence from
                // silently turning the capability off.
                ids.add(recordKey);
                const modelID = isRecord(model) ? model.id : undefined;
                if (typeof modelID === "string") ids.add(modelID);
                next.set(providerID, ids);
            }
        }
        wireModelsByProvider = next;
        registryLoaded = true;
        // "0 of N" on a machine that has Claude configured is the signal that this
        // lookup no longer reads the adapter it expects.
        let wireModels = 0;
        for (const ids of next.values()) wireModels += ids.size;
        log(`anthropic wire models resolved: ${wireModels} of ${modelCount} configured`);
        return true;
    } catch (error) {
        // Narrow before logging. A `provider.list()` rejection can echo the request
        // context, and that context carries provider `options`, `env`, `key` and
        // `headers` — including a gateway URL with inline credentials.
        log(
            `anthropic wire model lookup failed; retrying later: ${
                error instanceof Error ? error.message : typeof error
            }`,
        );
        return false;
    }
}

export interface EmptySentinelCapability {
    /** Whether empty-part sentinels are valid on this pass's wire. */
    acceptsEmptySentinels: boolean;
    /**
     * True only when a non-canonical provider was widened by the registry. This is
     * the case whose served bytes CHANGE relative to a session that predates the
     * registry, so it is the case the m[0] upgrade identity has to record.
     */
    widenedByCustomProvider: boolean;
}

/**
 * Resolve the pass's empty-sentinel capability, including the unresolved case.
 *
 * One function so no phase re-derives the rule: `modelAcceptsEmptyContent` owns
 * "is this the Anthropic wire", and this owns "what do we do when we cannot tell".
 *
 * Unresolved is NOT the same as "not widened". A model or registry we cannot read
 * this pass must not narrow a session that already served widened bytes: narrowing
 * stops replaying merged-reasoning strips that are already persisted, and native
 * signed thinking then goes back on the wire — the 400 this capability prevents.
 * So an unresolved pass carries forward what the session last materialized under.
 *
 * That carry-forward is keyed to the MODEL, not just the session. Otherwise a
 * session that switched from a widened gateway to an unrelated provider would keep
 * the widened answer while the registry is unresolved, and empty parts would reach
 * a wire that forwards them as real content (issue #135).
 */
export function resolveEmptySentinelCapability(args: {
    providerID?: string;
    modelID?: string;
    /**
     * Model key of the live request, or empty when it is not observable. Compared
     * against `cachedModelKey` after canonicalization, because the cached side is
     * stored canonicalized (`inject-compartments.ts` normalizes both sides of its
     * own model comparison the same way). Skipping that here would make the
     * comparison silently never match for the aliased provider ids.
     */
    modelKey?: string;
    /** Model key the cached m[0] baseline was materialized under. */
    cachedModelKey?: string | null;
    /** Whether that cached baseline was widened by the registry. */
    cachedWidenedByCustomProvider: boolean;
}): EmptySentinelCapability {
    const canonical = args.providerID === "anthropic";
    if (args.modelID && registryLoaded) {
        const widened = !canonical && isAnthropicWireModel(args.providerID, args.modelID);
        return { acceptsEmptySentinels: canonical || widened, widenedByCustomProvider: widened };
    }
    const liveKey = piModelRefToCanonical(args.modelKey ?? "");
    const sameModel =
        liveKey.length > 0 && liveKey === piModelRefToCanonical(args.cachedModelKey ?? "");
    const widened = sameModel && args.cachedWidenedByCustomProvider;
    return { acceptsEmptySentinels: canonical || widened, widenedByCustomProvider: widened };
}

/** Test seam: restore the unloaded state. */
export function resetAnthropicWireModelsForTest(): void {
    wireModelsByProvider = new Map();
    registryLoaded = false;
    loadPromise = undefined;
    lastFailureAt = 0;
}
