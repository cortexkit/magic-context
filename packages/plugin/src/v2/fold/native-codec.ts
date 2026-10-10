import type { V2Message } from "../hooks/types";
import { hostMediaFromEncoded } from "./host-media";

export class NativeReplayUnavailable extends Error {}

/** Use the host Asset's JSON codec before copying, so its bytes and provider
 * bindings survive without retaining caller-owned metadata. Assets carrying request
 * credentials, or lacking a lossless host codec, must not enter the replay cache.
 */
export function encodeNative(messages: readonly V2Message[]): V2Message[] {
    for (const message of messages)
        for (const part of message.content) {
            if (part.type !== "media" || !part.media) continue;
            const asset = part.media as {
                toJSON?: () => Record<string, unknown>;
                headers?: unknown;
            };
            if (typeof asset.toJSON !== "function" || asset.headers !== undefined)
                throw new NativeReplayUnavailable("Native media has no lossless replay codec");
            const encoded = asset.toJSON();
            const revived = hostMediaFromEncoded(encoded);
            if (typeof revived === "string" || JSON.stringify(revived) !== JSON.stringify(asset))
                throw new NativeReplayUnavailable(
                    "Native media cannot be decoded losslessly before admission",
                );
        }
    const encoded = JSON.parse(JSON.stringify(messages)) as V2Message[];
    const freeze = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
    };
    freeze(encoded);
    return encoded;
}
export function reviveNative(messages: readonly V2Message[]): V2Message[] {
    const result = structuredClone([...messages]);
    for (const message of result)
        for (const part of message.content) {
            if (part.type !== "media" || !part.media) continue;
            const asset = hostMediaFromEncoded(part.media as Record<string, unknown>);
            if (typeof asset === "string") throw new NativeReplayUnavailable(asset);
            part.media = asset;
        }
    return result;
}
