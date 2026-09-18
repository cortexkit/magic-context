import { isFable51ThinkingBindingModel } from "../../features/magic-context/overflow-detection";
import { canonicalModelIdentity } from "../../shared/harness-provider-map";
import { isRecord } from "../../shared/record-type-guard";
import { isAnthropicWireModel } from "./anthropic-wire";

/**
 * Whole-message sentinel placeholder for providers that must not receive empty
 * assistant content on the wire.
 *
 * Background: when `stripDroppedPlaceholderMessages` /
 * `stripSystemInjectedMessages` / `replaySentinelByMessageIds` reduce a whole
 * assistant message to one sentinel part, the resulting AI-SDK `ModelMessage`
 * can become `{ role: "assistant", content: "" }`. OpenCode's canonical
 * Anthropic adapter filters that empty message before the wire; most other
 * providers can forward it and stricter backends reject it (e.g. Moonshot/Kimi:
 * "must not be empty").
 *
 * Using a non-empty placeholder text whose value won't be filtered keeps the
 * wire valid while still telling the model honestly that something was dropped.
 */
export const WHOLE_MESSAGE_PLACEHOLDER_TEXT = "[dropped]";

/**
 * Decide whether empty-text sentinels are safe for the model's wire path.
 *
 * The gate is the `@ai-sdk/anthropic` adapter, not the provider name. OpenCode
 * filters empty text/reasoning parts only in that branch before sending to the
 * provider; other adapters forward `{type:"text", text:""}` parts as real
 * content blocks. Bedrock Converse also filters empty text later, but native
 * `step-start` boundaries and empty sentinels are not byte-equivalent before
 * that filter runs. Google Vertex Anthropic maps to an Anthropic SDK key but
 * does not enter OpenCode's `@ai-sdk/anthropic` empty-part filter.
 *
 * Canonical `anthropic` answers true without a lookup so the registry is never
 * on the critical path for the common case. Any other provider must be reported
 * by `provider.list()` as serving this model on `@ai-sdk/anthropic` — see
 * `anthropic-wire.ts`. Unknown models keep native parts (or use non-empty
 * whole-message placeholders) rather than producing empty sentinels.
 *
 * This is the only place the WIRE RULE lives. `resolveEmptySentinelCapability`
 * in `anthropic-wire.ts` wraps it with the unresolved-model policy and is what
 * the transform calls; every consumer downstream takes the resolved boolean, so
 * no two phases of one pass can disagree and oscillate the cached prefix.
 */
export function modelAcceptsEmptyContent(providerID?: string, modelID?: string): boolean {
    return providerID === "anthropic" || isAnthropicWireModel(providerID, modelID);
}

/**
 * Provider-cache facts for model identities whose effort can change without
 * invalidating cached prompt bytes: Anthropic Fable 5.1 was observed on
 * 2026-09-02 and OpenAI GPT-6 Astra on 2026-09-05.
 */
const VARIANT_CACHE_PRESERVING_MODELS: Readonly<Record<string, string>> = {
    "anthropic/claude-fable-5-1": "2026-09-02",
    "openai/gpt-6-astra": "2026-09-05",
};

function canonicalVariantModelIdentity(providerID: string, modelID: string): string {
    const normalizedProviderID = providerID.toLowerCase();
    const isAnthropicFamily =
        normalizedProviderID === "anthropic" ||
        normalizedProviderID === "google-vertex-anthropic" ||
        normalizedProviderID.includes("bedrock");
    if (isAnthropicFamily && isFable51ThinkingBindingModel("anthropic", modelID)) {
        return "anthropic/claude-fable-5-1";
    }
    return canonicalModelIdentity(`${providerID}/${modelID}`).toLowerCase();
}

/**
 * Decide whether a reasoning-variant change busts the provider cache naturally.
 *
 * Older Anthropic-family models serialize thinking configuration into cached
 * message blocks, so an effort/budget change already busts that prefix and
 * pending work can ride the provider's bust. The explicit models above instead
 * carry effort outside the cached prefix; manufacturing our own flush would
 * rewrite an otherwise byte-identical suffix.
 *
 * Deferring is the safe side of the ambiguity: pending work rides the next
 * natural bust (ARCHITECTURE.md invariant 3), while a false-positive flush
 * costs a full suffix rewrite on every effort change. Unknown provider/model
 * combinations therefore defer rather than opening an unproven bust.
 */
export function variantChangeBustsProviderCache(providerID?: string, modelID?: string): boolean {
    if (!providerID || !modelID) return false;
    const identity = canonicalVariantModelIdentity(providerID, modelID);
    if (Object.hasOwn(VARIANT_CACHE_PRESERVING_MODELS, identity)) return false;

    const normalizedProviderID = providerID.toLowerCase();
    return (
        normalizedProviderID === "anthropic" ||
        normalizedProviderID === "google-vertex-anthropic" ||
        normalizedProviderID.includes("bedrock")
    );
}

/**
 * Create an empty-text sentinel to replace a stripped message PART (not a
 * whole message) while preserving the array's length and index positions
 * across passes.
 *
 * Why sentinels exist: Anthropic prompt caching is sensitive to serialized
 * message-array shape. Replacing removed parts with inert `{type:"text",
 * text:""}` placeholders keeps indices stable across passes, and OpenCode's
 * canonical Anthropic adapter filters those empty text parts before the wire.
 *
 * Call sites must gate this helper with `modelAcceptsEmptyContent()`. For
 * non-Anthropic providers the empty text part can survive onto the wire and
 * break provider-specific adjacency or non-empty-content invariants.
 *
 * `cache_control` inheritance: if the original part carried provider-side
 * cache-breakpoint metadata (`cache_control` / `cacheControl`), the
 * sentinel inherits it. OpenCode currently only sets cache markers on the
 * last two system+non-system messages (never on mid-history parts we
 * strip), so this is defensive, but cheap.
 */
export function makeSentinel(originalPart: unknown): {
    type: "text";
    text: string;
} & Record<string, unknown> {
    const sentinel: { type: "text"; text: string } & Record<string, unknown> = {
        type: "text",
        text: "",
    };
    if (isRecord(originalPart)) {
        if (originalPart.cache_control !== undefined) {
            sentinel.cache_control = originalPart.cache_control;
        }
        if (originalPart.cacheControl !== undefined) {
            sentinel.cacheControl = originalPart.cacheControl;
        }
    }
    return sentinel;
}

/**
 * Create a sentinel for replacing a WHOLE assistant message's parts list.
 *
 * Picks `""` when the live model rides the Anthropic wire (whose AI-SDK
 * normalization filters empty content off the wire), `[dropped]` otherwise.
 * See `modelAcceptsEmptyContent` for the rule that resolves the flag.
 *
 * The chosen placeholder text is kept in `WHOLE_MESSAGE_PLACEHOLDER_TEXT`
 * so `isSentinel` recognizes both shapes (idempotency on replay).
 */
export function makeWholeMessageSentinel(
    acceptsEmptySentinels?: boolean,
): { type: "text"; text: string } & Record<string, unknown> {
    return {
        type: "text",
        text: acceptsEmptySentinels ? "" : WHOLE_MESSAGE_PLACEHOLDER_TEXT,
    };
}

/**
 * Detect whether a part is already a sentinel produced by `makeSentinel`
 * or `makeWholeMessageSentinel`. Used by strip functions to stay
 * idempotent — don't re-count or re-mutate a sentinel we already
 * installed.
 *
 * Recognizes both empty (`""`) and whole-message-placeholder
 * (`[dropped]`) sentinel text values.
 */
export function isSentinel(part: unknown): boolean {
    if (!isRecord(part)) return false;
    if (part.type !== "text") return false;
    if (typeof part.text !== "string") return false;
    return part.text === "" || part.text === WHOLE_MESSAGE_PLACEHOLDER_TEXT;
}

/**
 * Replay persisted whole-message decisions onto a fresh host projection.
 * Anthropic-wire models keep empty sentinels because the adapter filters them.
 * For non-empty-sentinel models, hidden seam rows are removed instead: they
 * were absent on the fold pass, so removal is the only byte-identical replay.
 */
export function replaySentinelByMessageIds(
    messages: Array<{ info: { id?: string }; parts: unknown[] }>,
    ids: Set<string>,
    acceptsEmptySentinels?: boolean,
    hiddenSeamIds: ReadonlySet<string> = new Set(),
): { replayed: number; missingIds: string[] } {
    if (ids.size === 0) return { replayed: 0, missingIds: [] };
    const seen = new Set<string>();
    let replayed = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const msg = messages[index];
        const id = msg.info.id;
        if (!id || !ids.has(id)) continue;
        seen.add(id);
        if (!acceptsEmptySentinels && hiddenSeamIds.has(id)) {
            messages.splice(index, 1);
            replayed += 1;
            continue;
        }
        const sentinel = msg.parts.length === 1 ? msg.parts[0] : undefined;
        const expectedText = acceptsEmptySentinels ? "" : WHOLE_MESSAGE_PLACEHOLDER_TEXT;
        if (
            sentinel !== undefined &&
            isSentinel(sentinel) &&
            isRecord(sentinel) &&
            sentinel.text === expectedText
        ) {
            continue;
        }
        msg.parts.length = 0;
        msg.parts.push(makeWholeMessageSentinel(acceptsEmptySentinels));
        replayed += 1;
    }
    const missingIds: string[] = [];
    for (const id of ids) if (!seen.has(id)) missingIds.push(id);
    return { replayed, missingIds };
}
