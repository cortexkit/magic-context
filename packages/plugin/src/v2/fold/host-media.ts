/**
 * Rebuilding attachment payloads in the host's own `Media.Asset` class.
 *
 * From OpenCode 2.0.15 a media content part carries its bytes in a `Media.Asset` class
 * instance, and after the context hook the host rebuilds every message with
 * `Message.make`. Every OpenCode 2 host the plugin supports is at least that new (the
 * oldest one the e2e lane pins is 2.0.22), so a media part handed to the host must hold
 * a real host instance: on 2.0.x the schema's `instanceof Asset` check rejects anything
 * else, and on 2.3.x `Message.make` turns a part without one into an asset that has no
 * bytes, which fails the request before any provider call. Rows restored from the store
 * after a host checkpoint are built by Magic Context, not by the host, so their
 * attachments need a real host instance. The plugin cannot import that class: a second
 * copy of `@opencode/ai` has a different `Asset`, which fails the host's instanceof check.
 *
 * Two zero-loss ways to get one, in order:
 * 1. The constructor of any `Media.Asset` the host itself put into a draft during this
 *    process. `new Asset({ source: { type: "base64", data, mediaType } })` is exactly what
 *    the host's own `Media.base64(data, mediaType)` does when it renders a stored row.
 * 2. The host's own schema, reached from a draft message's class:
 *    `fields.content.value` (the content-part union) → the member whose `type` is the
 *    literal "media" → `fields.media` (`Media.AssetSchema`) → `ast.encoding[0]
 *    .transformation.decode`. OpenCode 2.0.22 (Effect 4.0.0-rc.112) exposes a getter whose
 *    `run(some(encoded), {})` returns `Success(some(asset))`. OpenCode 2.2.3 (Effect 4.0.6)
 *    uses a plain `{ _tag: "Transform", transform }` getter whose `transform(encoded)`
 *    returns the asset directly. Both invoke the host's `new Asset(encoded)`. Other getter
 *    tags are unavailable: they need optional/effectful evaluation rather than a direct
 *    synchronous transform. This depends on Effect Schema internals, so every step is
 *    checked and any mismatch counts as unavailable.
 *
 * OpenCode 2.0 and 2.1 have one message class for every role. From 2.3 each role has its
 * own class, and the system and tool classes have no media member at all; a draft can
 * start with a system message (a reasoning-effort change, for one). So the schema is
 * taken from the first message class whose content union has a media member, never from
 * whichever message happens to come first.
 */

type Part = Record<string, unknown>;
type AssetConstructor = new (input: Part & { source: Part }) => object;

const isRecord = (value: unknown): value is Part =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function isClassInstance(value: unknown): value is object {
    if (!isRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype !== Object.prototype && prototype !== null;
}

let rememberedAssetClass: AssetConstructor | undefined;
/** The `media` field schema of the host's media content part (`Media.AssetSchema`). */
let rememberedAssetSchema: Part | undefined;
/** Per message class: its media field schema, or null when its content has no media member. */
const assetSchemaByClass = new WeakMap<object, Part | null>();

/** Test hook: forget what earlier drafts taught this process. */
export function resetHostMediaForTests(): void {
    rememberedAssetClass = undefined;
    rememberedAssetSchema = undefined;
}

/**
 * The `media` field schema of the content-part union member whose `type` is the literal
 * "media", reached from a host message class; undefined when the class has no such member.
 */
function assetSchemaOf(messageClass: object): Part | undefined {
    const known = assetSchemaByClass.get(messageClass);
    if (known !== undefined) return known ?? undefined;
    const fields = (messageClass as Part).fields as Part | undefined;
    const union = (fields?.content as Part | undefined)?.value as Part | undefined;
    const members = union?.members;
    const mediaPart = Array.isArray(members)
        ? (members.find((member) => {
              const memberFields = (member as Part | undefined)?.fields as Part | undefined;
              const literal = ((memberFields?.type as Part | undefined)?.ast as Part | undefined)
                  ?.literal;
              return literal === "media";
          }) as Part | undefined)
        : undefined;
    const media = (mediaPart?.fields as Part | undefined)?.media;
    // Effect schemas can be callable, so a function counts as a schema object here.
    const schema =
        (typeof media === "object" && media !== null) || typeof media === "function"
            ? (media as Part)
            : undefined;
    assetSchemaByClass.set(messageClass, schema ?? null);
    return schema;
}

/** Learn the host's media schema and, when present, its `Media.Asset` class from a draft. */
export function rememberHostMedia(messages: ReadonlyArray<unknown>): void {
    for (const message of messages) {
        if (rememberedAssetClass && rememberedAssetSchema) return;
        if (!isClassInstance(message)) continue;
        rememberedAssetSchema ??= assetSchemaOf(Object.getPrototypeOf(message).constructor);
        if (rememberedAssetClass) continue;
        const content = (message as Part).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
            if (!isRecord(part) || part.type !== "media") continue;
            const media = part.media;
            if (isClassInstance(media) && isRecord((media as Part).source)) {
                rememberedAssetClass = Object.getPrototypeOf(media).constructor as AssetConstructor;
                break;
            }
        }
    }
}

function decodeThroughHostSchema(encoded: Part & { source: Part }): object | string {
    const source = encoded.source;
    const assetSchema = rememberedAssetSchema;
    if (!assetSchema) return "no host message schema with a media member seen";
    const encoding = (assetSchema.ast as Part | undefined)?.encoding;
    const decode = Array.isArray(encoding)
        ? ((encoding[0] as Part | undefined)?.transformation as Part | undefined)?.decode
        : undefined;
    const getter = decode as Part | undefined;
    let asset: unknown;
    if (getter?._tag === "Transform") {
        if (typeof getter.transform !== "function")
            return "host media schema has no decode transformation";
        asset = getter.transform(encoded);
    } else {
        if (getter?._tag !== undefined)
            return `host media schema has unsupported decode transformation: ${String(getter._tag)}`;
        const run = getter?.run;
        if (typeof run !== "function") return "host media schema has no decode transformation";
        const result = run.call(decode, { _tag: "Some", value: encoded }, {}) as Part | undefined;
        const option = result?._tag === "Success" ? (result.value as Part | undefined) : undefined;
        asset = option?._tag === "Some" ? option.value : undefined;
    }
    if (!isClassInstance(asset) || (asset as Part).source !== source)
        return "host media schema decode did not return an asset";
    return asset;
}

/**
 * The host's own `Media.Asset` for a base64 payload, or the reason neither zero-loss way
 * produced one.
 */
export function hostMediaAsset(data: string, mediaType: string): object | string {
    return hostMediaFromEncoded({ source: { type: "base64", data, mediaType } });
}

/** Decode the complete host codec record, including caller-owned bindings/info. */
export function hostMediaFromEncoded(value: Part): object | string {
    if (!isRecord(value.source)) return "missing Media.Asset source";
    const encoded = structuredClone(value) as Part & { source: Part };
    if (encoded.source.type === "bytes") {
        if (typeof encoded.source.data !== "string") return "bytes media has no JSON codec payload";
        encoded.source.data = new Uint8Array(Buffer.from(encoded.source.data, "base64"));
    }
    if (!["bytes", "base64", "url", "ref"].includes(String(encoded.source.type)))
        return "unknown Media.Asset source";
    let first = "no Media.Asset seen in this process";
    if (rememberedAssetClass) {
        try {
            return new rememberedAssetClass(encoded);
        } catch (error) {
            first = `remembered asset class threw: ${String(error)}`;
        }
    }
    let second: string;
    try {
        const decoded = decodeThroughHostSchema(encoded);
        if (typeof decoded !== "string") return decoded;
        second = decoded;
    } catch (error) {
        second = `host media schema decode threw: ${String(error)}`;
    }
    return `${first}; ${second}`;
}
