import { describe, expect, test } from "bun:test";
import {
    computeRescoreSourceIdentity,
    HISTORIAN_REFERENCE_FIX_SHIPPED_AT,
    RESCORE_RUBRIC_VERSION,
    type RescoreSource,
} from "./rescore-identity";
import goldens from "./rescore-source-identity.goldens.json";

describe("rescore source identity", () => {
    test("pins the shared rubric version and display-only fix timestamp", () => {
        expect(RESCORE_RUBRIC_VERSION).toBe(goldens.rubricVersion);
        expect(HISTORIAN_REFERENCE_FIX_SHIPPED_AT).toBe(goldens.fixShippedAtMs);
        expect(new Date(HISTORIAN_REFERENCE_FIX_SHIPPED_AT).toISOString()).toBe(
            "2026-10-06T10:13:16.000Z",
        );
    });

    // Literal source-identity streams using the documented field order and UTF-8
    // framing were hashed with Python hashlib, independently of this TS function.
    for (const vector of goldens.vectors) {
        test(`shared golden: ${vector.name}`, () => {
            expect(computeRescoreSourceIdentity(vector.source)).toBe(vector.sha256);
        });
    }

    test("every tiered source field invalidates identity, including creation and base score", () => {
        const source = goldens.vectors[0]!.source;
        const original = computeRescoreSourceIdentity(source);
        const changes: Partial<RescoreSource>[] = [
            { id: 8 },
            { sessionId: "moved" },
            { createdAt: source.createdAt + 1 },
            { title: "design" },
            { episodeType: null },
            { legacy: 1 },
            { p1: "new P1" },
            { p2: "new P2" },
            { p3: "new P3" },
            { p4: "new P4" },
            { sequence: 3 },
            { startMessage: 11 },
            { endMessage: 16 },
            { startMessageId: "new start" },
            { endMessageId: "new end" },
            { startBlockIndex: 0 },
            { endBlockIndex: 0 },
            { importance: 51 },
        ];
        for (const change of changes) {
            expect(computeRescoreSourceIdentity({ ...source, ...change })).not.toBe(original);
        }
    });

    test("legacy content, empty tiers and exact Unicode bytes are distinguished", () => {
        const legacy = goldens.vectors[2]!.source;
        expect(computeRescoreSourceIdentity({ ...legacy, content: "changed" })).not.toBe(
            computeRescoreSourceIdentity(legacy),
        );
        const unicode = goldens.vectors[1]!.source;
        expect(computeRescoreSourceIdentity({ ...unicode, p2: null })).not.toBe(
            computeRescoreSourceIdentity(unicode),
        );
        expect(computeRescoreSourceIdentity({ ...unicode, p1: "é\n雪" })).not.toBe(
            computeRescoreSourceIdentity(unicode),
        );
    });

    test("ignores tiered content alias, legacy tiers and absent whole-message indices", () => {
        const tiered = goldens.vectors[0]!.source;
        expect(
            computeRescoreSourceIdentity({
                ...tiered,
                content: "not a source tier",
                startBlockIndex: undefined,
                endBlockIndex: undefined,
            }),
        ).toBe(computeRescoreSourceIdentity(tiered));
        const legacy = goldens.vectors[2]!.source;
        expect(computeRescoreSourceIdentity({ ...legacy, p1: "unused" })).toBe(
            computeRescoreSourceIdentity(legacy),
        );
    });

    test("length framing cannot confuse delimiters between fields", () => {
        const source = goldens.vectors[0]!.source;
        expect(
            computeRescoreSourceIdentity({ ...source, title: "a;b", episodeType: "c" }),
        ).not.toBe(computeRescoreSourceIdentity({ ...source, title: "a", episodeType: "b;c" }));
    });

    test("rejects unsafe or non-integral numeric identities", () => {
        for (const id of [Number.MAX_SAFE_INTEGER + 1, 1.5, Number.NaN]) {
            expect(() =>
                computeRescoreSourceIdentity({ ...goldens.vectors[0]!.source, id }),
            ).toThrow("requires safe integers");
        }
    });
});
