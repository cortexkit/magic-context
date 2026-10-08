/**
 * Rebuilding attachment payloads in the host's own `Media.Asset` class.
 *
 * From OpenCode 2.0.15 a media content part carries its bytes in a `Media.Asset` class
 * instance, and after the context hook the host rebuilds every message with
 * `Message.make`, whose schema checks `value instanceof Asset`. Rows restored from the
 * store after a host checkpoint are built by Magic Context, not by the host, so their
 * attachments need a real host instance. The plugin cannot import that class: a second
 * copy of `@opencode/ai` has a different `Asset`, which fails the host's instanceof check.
 *
 * Two zero-loss ways to get one, in order:
 * 1. The constructor of any `Media.Asset` the host itself put into a draft during this
 *    process. `new Asset({ source: { type: "base64", data, mediaType } })` is exactly what
 *    the host's own `Media.base64(data, mediaType)` does when it renders a stored row.
 * 2. The host's own schema, reached from the draft message's class:
 *    `Message.fields.content.value` (the content-part union) → the member whose `type` is
 *    the literal "media" → `fields.media` (`Media.AssetSchema`) → `ast.encoding[0]
 *    .transformation.decode`, whose `run(some(encoded))` returns `Success(some(asset))`.
 *    That transformation is the host's `new Asset(encoded)`. It depends on Effect Schema
 *    internals, so every step is checked and any mismatch counts as unavailable.
 */

import { getOpenCodeProviderProjection } from "../../hooks/magic-context/host-runner/opencode-adapter";

type Part = Record<string, unknown>;
type AssetConstructor = new (input: { source: Part }) => object;

const isRecord = (value: unknown): value is Part =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function isClassInstance(value: unknown): value is object {
    if (!isRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype !== Object.prototype && prototype !== null;
}

let rememberedAssetClass: AssetConstructor | undefined;
let rememberedMessageClass: object | undefined;
const schemaUsesAssets = new WeakMap<object, boolean>();

/** Test hook: forget what earlier drafts taught this process. */
export function resetHostMediaForTests(): void {
    rememberedAssetClass = undefined;
    rememberedMessageClass = undefined;
}

/** Learn the host's message class and, when present, its `Media.Asset` class from a draft. */
export function rememberHostMedia(messages: ReadonlyArray<unknown>, sessionId?: string): void {
    const provider = sessionId ? getOpenCodeProviderProjection(sessionId) : undefined;
    for (const message of messages) {
        if (!isClassInstance(message)) continue;
        rememberedMessageClass ??= Object.getPrototypeOf(message).constructor as object;
        if (
            provider &&
            typeof (message as Part).id === "string" &&
            provider.ids.has((message as Part).id as string)
        )
            continue;
        if (rememberedAssetClass) return;
        const content = (message as Part).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (!isRecord(part) || part.type !== "media") continue;
            const media = part.media;
            if (isClassInstance(media) && isRecord((media as Part).source)) {
                rememberedAssetClass = Object.getPrototypeOf(media).constructor as AssetConstructor;
                return;
            }
        }
    }
}

/**
 * True when the remembered host message schema declares attachments as `Media.Asset`
 * (OpenCode 2.0.15 and later). Earlier hosts take the plain `{ mediaType, data }` shape.
 */
export function hostUsesMediaAssets(): boolean {
    const messageClass = rememberedMessageClass;
    if (!messageClass) return rememberedAssetClass !== undefined;
    const cached = schemaUsesAssets.get(messageClass);
    if (cached !== undefined) return cached;
    let uses = rememberedAssetClass !== undefined;
    if (!uses) {
        try {
            uses = JSON.stringify((messageClass as Part).ast).includes('"Media.Asset"');
        } catch {
            uses = false;
        }
    }
    schemaUsesAssets.set(messageClass, uses);
    return uses;
}

function decodeThroughHostSchema(source: Part): object | string {
    const messageClass = rememberedMessageClass as Part | undefined;
    if (!messageClass) return "no host message class seen";
    const fields = messageClass.fields as Part | undefined;
    const union = (fields?.content as Part | undefined)?.value as Part | undefined;
    const members = union?.members;
    if (!Array.isArray(members)) return "host content schema has no union members";
    const mediaPart = members.find((member) => {
        const typeField = (member as Part)?.fields as Part | undefined;
        const literal = ((typeField?.type as Part | undefined)?.ast as Part | undefined)?.literal;
        return literal === "media";
    }) as Part | undefined;
    const assetSchema = (mediaPart?.fields as Part | undefined)?.media as Part | undefined;
    const encoding = (assetSchema?.ast as Part | undefined)?.encoding;
    const decode = Array.isArray(encoding)
        ? ((encoding[0] as Part | undefined)?.transformation as Part | undefined)?.decode
        : undefined;
    const run = (decode as Part | undefined)?.run;
    if (typeof run !== "function") return "host media schema has no decode transformation";
    const result = run.call(decode, { _tag: "Some", value: { source } }, {}) as Part | undefined;
    const option = result?._tag === "Success" ? (result.value as Part | undefined) : undefined;
    const asset = option?._tag === "Some" ? option.value : undefined;
    if (!isClassInstance(asset) || (asset as Part).source !== source)
        return "host media schema decode did not return an asset";
    return asset;
}

/**
 * The host's own `Media.Asset` for a base64 payload, or the reason neither zero-loss way
 * produced one.
 */
export function hostMediaAsset(data: string, mediaType: string): object | string {
    const source = { type: "base64", data, mediaType };
    let first = "no Media.Asset seen in this process";
    if (rememberedAssetClass) {
        try {
            return new rememberedAssetClass({ source });
        } catch (error) {
            first = `remembered asset class threw: ${String(error)}`;
        }
    }
    let second: string;
    try {
        const decoded = decodeThroughHostSchema(source);
        if (typeof decoded !== "string") return decoded;
        second = decoded;
    } catch (error) {
        second = `host media schema decode threw: ${String(error)}`;
    }
    return `${first}; ${second}`;
}
