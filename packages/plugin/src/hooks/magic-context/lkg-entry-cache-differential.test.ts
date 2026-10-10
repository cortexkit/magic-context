/// <reference types="bun-types" />

/**
 * The entry digest cache must give exactly the digests, and so exactly the
 * replay decisions and bytes, that the projector it replaced gave. That
 * projector is frozen below as it shipped in v0.47.0 (flatten every message,
 * reuse a digest only after comparing the whole token list); both run side by
 * side over randomized histories: edits to earlier messages (content, value
 * type, keys added, removed or reordered), removals, reorders and appends,
 * with the host handing over either fresh copies or the same objects edited in
 * place.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
    buildLkgPrefix,
    captureLkgSlot,
    createLkgEntryProjector,
    type LkgEntryProjection,
    projectLkgEntry,
    replayLkg,
} from "./lkg-replay";
import {
    captureSlot,
    exactReusablePrefix,
    getLkgEntryWorkForTest,
    getSlot,
    type LkgInputSnapshot,
    type LkgSlot,
    lkgContentDigest,
    lkgContentDigestFromFields,
    lkgContentFields,
    noteEntry,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import { providerVisibleMessage } from "./provider-visible-parts";
import type { MessageLike } from "./transform-operations";

/** The v0.47.0 projector's digest selection, without its shared memo (which returns the same digests). */
function frozenProjector(maxBytes = 64 * 1024 * 1024) {
    const priors = new Map<
        string,
        {
            entries: Map<string, { snapshot: LkgInputSnapshot; digest: string | null }>;
            bytes: number;
        }
    >();
    let bytes = 0;
    return (sessionId: string, messages: MessageLike[]): (string | null)[] => {
        const prior = priors.get(sessionId);
        // The selection logic is v0.47.0's; the input is reduced to what the
        // provider sees first, as the digest itself now is.
        const snapshots = messages.map((message) => ({
            id: typeof message.info?.id === "string" ? message.info.id : "",
            fields: lkgContentFields(providerVisibleMessage(message)),
        }));
        const digests = snapshots.map((snapshot) => {
            const cached = prior?.entries.get(snapshot.id);
            if (
                snapshot.fields &&
                cached &&
                exactReusablePrefix([snapshot as LkgInputSnapshot], [cached.snapshot]) === 1
            ) {
                return cached.digest;
            }
            if (!snapshot.fields) return null;
            return lkgContentDigestFromFields(snapshot.fields);
        });
        if (prior) {
            bytes -= prior.bytes;
            priors.delete(sessionId);
        }
        let size = 0;
        const retained = new Map<string, { snapshot: LkgInputSnapshot; digest: string | null }>();
        snapshots.forEach((snapshot, index) => {
            const entrySize =
                snapshot.id.length * 2 +
                (snapshot.fields?.reduce<number>(
                    (sum, field) => sum + 16 + (typeof field === "string" ? field.length * 2 : 0),
                    0,
                ) ?? 0) +
                166;
            if (!snapshot.fields || retained.has(snapshot.id) || size + entrySize > maxBytes)
                return;
            size += entrySize;
            retained.set(snapshot.id, {
                snapshot: snapshot as LkgInputSnapshot,
                digest: digests[index] ?? null,
            });
        });
        if (size <= maxBytes && retained.size > 0) {
            while (priors.size >= 16 || bytes + size > maxBytes) {
                const oldest = priors.entries().next().value;
                if (!oldest) break;
                bytes -= oldest[1].bytes;
                priors.delete(oldest[0]);
            }
            priors.set(sessionId, { entries: retained, bytes: size });
            bytes += size;
        }
        return digests;
    };
}

function rng(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 0x100000000;
    };
}

/** Deep copy that keeps undefined-valued keys, as a host's fresh objects may. */
function clone<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
    if (value && typeof value === "object") {
        const copy: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) copy[key] = clone(entry);
        return copy as T;
    }
    return value;
}

type Random = () => number;
const pick = <T>(random: Random, items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;

function leaf(random: Random): unknown {
    return pick(random, [
        () => `text ${Math.floor(random() * 1000)} ünï ${"x".repeat(Math.floor(random() * 40))}`,
        () => Math.floor(random() * 100),
        () => -0,
        () => Number.NaN,
        () => random() < 0.5,
        () => null,
        () => undefined,
        () => [1, undefined, "a"],
    ])();
}

let messageCounter = 0;
function newMessage(random: Random, created: number, role?: "user" | "assistant"): MessageLike {
    messageCounter += 1;
    const id = `msg_${String(messageCounter).padStart(6, "0")}`;
    const chosenRole = role ?? (random() < 0.5 ? "user" : "assistant");
    const parts: Array<Record<string, unknown>> = [
        { type: "text", text: `${id} says ${"lorem ".repeat(1 + Math.floor(random() * 20))}` },
    ];
    if (chosenRole === "assistant" && random() < 0.6) {
        const failed = random() < 0.2;
        const time: Record<string, number> = { start: created, end: created + 1 };
        if (random() < 0.2) time.compacted = created + 2;
        parts.push({
            type: "tool",
            callID: `call_${id}`,
            tool: random() < 0.5 ? "edit" : "bash",
            state: {
                status: failed ? "error" : "completed",
                input: { path: `src/${id}.ts`, flag: leaf(random) },
                ...(failed
                    ? { error: "aborted" }
                    : {
                          output:
                              random() < 0.5
                                  ? "output ".repeat(50)
                                  : { rows: [leaf(random), leaf(random)] },
                      }),
                title: `src/${id}.ts`,
                time,
                // UI data the provider never receives, except an interrupted
                // call's output on an error state.
                metadata: failed
                    ? { interrupted: true, output: "partial output", preview: leaf(random) }
                    : {
                          diagnostics: {
                              [`src/${id}.ts`]: [
                                  { range: { start: { line: 1, character: 0 } }, message: "x" },
                              ],
                          },
                          diff: leaf(random),
                      },
                extra: leaf(random),
            },
        });
    }
    return {
        info: {
            id,
            role: chosenRole,
            sessionID: "session",
            time: { created },
            ...(chosenRole === "assistant"
                ? { finish: "stop", providerID: "test", modelID: "model" }
                : { model: { providerID: "test", modelID: "model" } }),
        } as never,
        parts,
    };
}

/** One edit to an existing message, applied in place. */
function editMessage(random: Random, message: MessageLike): void {
    const part = pick(random, message.parts) as Record<string, unknown>;
    const edits = [
        () => {
            part.text = `${String(part.text ?? "")}!`;
        },
        () => {
            // Same length, different content.
            const text = String(part.text ?? "abc");
            part.text = `${text.slice(0, -1)}${text.endsWith("Z") ? "Y" : "Z"}`;
        },
        () => {
            (message.info as unknown as { time: { created: number } }).time.created += 1;
        },
        () => {
            // A number becomes the same digits as a string.
            const time = (message.info as unknown as { time: Record<string, unknown> }).time;
            time.created = String(time.created);
        },
        () => {
            part.added = leaf(random);
        },
        () => {
            delete part.type;
        },
        () => {
            // Same keys and values, different order.
            const entries = Object.entries(part).reverse();
            for (const key of Object.keys(part)) delete part[key];
            for (const [key, value] of entries) part[key] = value;
        },
        () => {
            part.text = undefined;
        },
        () => {
            const state = part.state as Record<string, unknown> | undefined;
            if (state) state.output = { rows: [leaf(random)] };
            else part.text = -0;
        },
        () => {
            (message.info as unknown as Record<string, unknown>).summary = { diffs: [] };
        },
        // Provider-invisible edits: tool metadata, title and times.
        () => {
            const state = part.state as Record<string, unknown> | undefined;
            if (!state) return;
            const metadata = (state.metadata ?? {}) as Record<string, unknown>;
            state.metadata = { ...metadata, diagnostics: { "src/other.ts": [leaf(random)] } };
        },
        () => {
            const state = part.state as Record<string, unknown> | undefined;
            if (state) state.title = `${String(state.title ?? "")} (renamed)`;
        },
        () => {
            const state = part.state as Record<string, unknown> | undefined;
            const time = state?.time as Record<string, unknown> | undefined;
            if (time) time.end = Number(time.end ?? 0) + 5;
        },
        // Provider-visible: an interrupted call's output on an error state.
        () => {
            const state = part.state as Record<string, unknown> | undefined;
            const metadata = state?.metadata as Record<string, unknown> | undefined;
            if (state?.status === "error" && metadata) {
                metadata.output = `${String(metadata.output)}!`;
            }
        },
    ];
    pick(random, edits)();
}

function projectionDigests(projection: LkgEntryProjection[]): (string | null)[] {
    return projection.map((entry) => entry.contentDigest?.() ?? null);
}

function replayOutcome(
    slot: LkgSlot,
    messages: MessageLike[],
    entry: ReturnType<typeof noteEntry>,
): unknown {
    captureSlot("session", { ...slot });
    const result = replayLkg({
        sessionId: "session",
        messages,
        modelKey: "test/model",
        providerKey: "test",
        entry,
    });
    return result.ok ? { ok: true, bytes: JSON.stringify(result.messages) } : result;
}

describe("entry digest cache against the v0.47.0 projector", () => {
    beforeEach(() => {
        resetLkgSlotsForTest();
        messageCounter = 0;
    });

    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        test(`randomized history ${seed}: same digests, prefixes and replay decisions`, () => {
            const random = rng(seed);
            let reused = 0;
            const project = createLkgEntryProjector({
                onReuse: (stats) => {
                    reused += stats.reused;
                },
            });
            const outcomes = new Set<string>();
            const frozen = frozenProjector();
            let created = 1;
            let history: MessageLike[] = [];
            for (let index = 0; index < 12; index += 1) {
                history.push(newMessage(random, created++, index % 2 ? "assistant" : "user"));
            }
            let previousSlot: LkgSlot | undefined;
            for (let pass = 0; pass < 60; pass += 1) {
                const operation = random();
                if (operation < 0.35 && history.length > 1) {
                    editMessage(random, pick(random, history.slice(0, -1)));
                } else if (operation < 0.45 && history.length > 4) {
                    history.splice(Math.floor(random() * (history.length - 1)), 1);
                } else if (operation < 0.55 && history.length > 4) {
                    const at = Math.floor(random() * (history.length - 2));
                    const [moved] = history.splice(at, 1);
                    history.splice(at + 1, 0, moved as MessageLike);
                } else {
                    history.push(newMessage(random, created++, "assistant"));
                    history.push(newMessage(random, created++, "user"));
                }
                // OpenCode 1 reloads every message from its database for each request, so
                // it hands over fresh copies; another host may hand over the
                // same objects, edited in place. Neither may be trusted on its own.
                const served = random() < 0.7 ? clone(history) : history;
                history = served;

                const expected = served.map((message) => lkgContentDigest(message));
                // The messages handler notes the entry before the transform projects it.
                const slot = getSlot("session");
                const entry = slot ? noteEntry("session", served) : null;
                const projection = project("session", served);
                const fresh = projectionDigests(projection);
                expect(fresh).toEqual(expected);
                expect(frozen("session", served)).toEqual(expected);
                if (entry) {
                    expect(entry.entryContentDigests).toEqual(
                        expected.slice(0, entry.anchorIndex + 1),
                    );
                }

                const reference = projectLkgEntry(served);
                expect(buildLkgPrefix(projection, served)).toEqual(
                    buildLkgPrefix(reference, served),
                );
                if (previousSlot) {
                    const fullEntry =
                        entry &&
                        ({
                            ...entry,
                            entryContentDigests: expected
                                .slice(0, entry.anchorIndex + 1)
                                .map((digest) => digest as string),
                        } satisfies NonNullable<typeof entry>);
                    const outcome = replayOutcome(previousSlot, served, entry);
                    expect(outcome).toEqual(replayOutcome(previousSlot, served, fullEntry));
                    outcomes.add(
                        (outcome as { ok: boolean; reason?: string }).ok
                            ? "ok"
                            : String((outcome as { reason?: string }).reason),
                    );
                }
                captureLkgSlot({
                    sessionId: "session",
                    input: projection,
                    output: served,
                    modelKey: "test/model",
                    providerKey: "test",
                    capturedAt: pass,
                });
                previousSlot = getSlot("session");
            }
            // The comparison path ran, and replay both succeeded and was refused
            // for changed content, so the equalities above covered both outcomes.
            expect(reused).toBeGreaterThan(0);
            expect(getLkgEntryWorkForTest().comparedMessages).toBeGreaterThan(reused);
            expect(outcomes.has("ok")).toBe(true);
            expect(
                outcomes.has("lkg_content_mismatch") || outcomes.has("lkg_invalidated_reshape"),
            ).toBe(true);
        });
    }
});
