import { isRecord } from "../../shared/record-type-guard";
import { providerVisiblePart } from "./provider-visible-parts";
import { isStructuralNoiseSentinel } from "./strip-structural-noise";
import type { MessageLike } from "./tag-messages";

function groups(messages: readonly MessageLike[]): Map<string, MessageLike[]> {
    const result = new Map<string, MessageLike[]>();
    for (const message of messages) {
        if (!message.info.id) continue;
        const group = result.get(message.info.id) ?? [];
        group.push(message);
        result.set(message.info.id, group);
    }
    return result;
}

function visibleGroup(group: readonly MessageLike[]): string {
    return JSON.stringify(
        group.map((message) => ({
            role: message.info.role,
            parts: message.parts
                // The snapshot precedes structural stripping and persisted-edit
                // replay. Compare native markers and our later placeholders in
                // the same representation without hiding native empty text edits.
                .filter(
                    (part) =>
                        !isStructuralNoiseSentinel(part) &&
                        !(
                            isRecord(part) &&
                            (part.type === "step-start" ||
                                part.type === "step-finish" ||
                                part.type === "meta")
                        ),
                )
                .map(providerVisiblePart),
        })),
    );
}

export function snapshotRecoveryMessages(messages: readonly MessageLike[]): Map<string, string> {
    return new Map([...groups(messages)].map(([id, group]) => [id, visibleGroup(group)]));
}

/** Release authorized edits without re-rendering the untouched recovered messages. */
export function releaseRecoveryPrefix(args: {
    frozen: readonly MessageLike[];
    before: ReadonlyMap<string, string>;
    after: readonly MessageLike[];
}): MessageLike[] {
    const frozen = groups(args.frozen);
    const rendered = groups(args.after);
    const emitted = new Set<string>();
    return args.after.flatMap((message) => {
        const id = message.info.id;
        if (!id) return [message];
        if (emitted.has(id)) return [];
        emitted.add(id);
        const group = rendered.get(id) ?? [message];
        const previous = frozen.get(id);
        return previous && args.before.get(id) === visibleGroup(group) ? previous : group;
    });
}
