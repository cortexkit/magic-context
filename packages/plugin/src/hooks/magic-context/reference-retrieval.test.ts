import { describe, expect, it } from "bun:test";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    buildReferenceBlocks,
    renderSeedExamplesBlock,
    renderSessionReferencesBlock,
    SEED_FLOOR,
    SESSION_REF_LIMIT,
    SESSION_REF_WINDOW,
    selectSeeds,
    selectSessionReferences,
} from "./reference-retrieval";
import { REFERENCE_SEEDS } from "./reference-seeds.generated";

function makeCompartment(over: Partial<Compartment> & { sequence: number }): Compartment {
    return {
        id: over.sequence,
        sessionId: "ses_test",
        sequence: over.sequence,
        startMessage: over.startMessage ?? over.sequence * 10 + 1,
        endMessage: over.endMessage ?? over.sequence * 10 + 9,
        startMessageId: `m${over.sequence}a`,
        endMessageId: `m${over.sequence}b`,
        title: over.title ?? `Compartment ${over.sequence}`,
        content: over.content ?? `flat content ${over.sequence}`,
        p1: over.p1 ?? null,
        p2: over.p2 ?? null,
        p3: over.p3 ?? null,
        p4: over.p4 ?? null,
        importance: over.importance ?? 50,
        episodeType: over.episodeType ?? null,
        legacy: over.legacy ?? (over.p1 ? 0 : 1),
        createdAt: 1000 + over.sequence,
    };
}

// Independent band oracle: boundary coverage must not reuse the selector's helper.
function band(importance: number): number {
    return importance >= 85
        ? 0
        : importance >= 60
          ? 1
          : importance >= 30
            ? 2
            : importance >= 10
              ? 3
              : 4;
}

const history = (scores: number[]) =>
    scores.map((importance, sequence) => makeCompartment({ sequence, importance }));
const anchors = (scores: number[]) => scores.map((importance) => ({ importance, block: "" }));
const choose = (
    scores: number[],
    seedScores = [90, 70, 40],
    sessionId = "ses-diverse",
    chunkStart = 42,
) => selectSessionReferences(history(scores), anchors(seedScores), sessionId, chunkStart);

describe("selectSessionReferences", () => {
    it("fills bands uncovered by seeds even when mixed recent scores cover them", () => {
        const refs = choose([5, 20, 40, 70, 90, 5, 20, 40, 70, 90, 70, 90, 70, 90]);
        expect(refs).toHaveLength(7);
        expect(refs.slice(-4).map((c) => c.importance)).toEqual([70, 90, 70, 90]);
        const diverseBands = refs.slice(0, 3).map((c) => band(c.importance ?? 50));
        expect(diverseBands).toContain(4);
        expect(diverseBands).toContain(3);
        const changedRecent = choose([5, 20, 40, 70, 90, 5, 20, 40, 70, 90, 5, 20, 5, 20]);
        expect(changedRecent.slice(0, 3)).toEqual(refs.slice(0, 3));
        expect(refs.map((c) => c.startMessage)).toEqual(
            refs.map((c) => c.startMessage).sort((a, b) => a - b),
        );
    });

    it("uses least-represented bands when fewer than 3 are uncovered", () => {
        // Only low-mid is uncovered AND available; after filling it, choose among
        // bands with one visible anchor, not the recent rows' hidden scores.
        const refs = choose([20, 40, 70, 90, 20, 40, 70, 90, 5, 20, 40, 70]);
        expect(refs).toHaveLength(7);
        const bands = refs.slice(0, 3).map((c) => band(c.importance ?? 50));
        expect(bands).toContain(3);
        for (const b of [0, 1, 2, 3])
            expect(bands.filter((value) => value === b).length).toBeLessThanOrEqual(
                b === 3 ? 2 : 1,
            );
        expect(new Set(refs).size).toBe(7);
    });

    it("fills all 3 diverse slots when older history lacks low bands", () => {
        const refs = choose([40, 70, 90, 40, 70, 90, 70, 70, 70, 70]);
        expect(refs).toHaveLength(7);
        const scores = refs.slice(0, 3).map((c) => c.importance);
        expect(scores).toContain(40);
        expect(scores).toContain(90);
        expect(scores).toContain(70);
        expect(new Set(refs).size).toBe(7);
    });

    it("is deterministic per session/chunk and rotates within older bands", () => {
        const scores = [...Array(20).fill(40), 70, 70, 70, 70];
        const ids = (sid: string, start: number) =>
            choose(scores, [90, 70, 40], sid, start).map((c) => c.startMessage);
        expect(ids("🚀", 42)).toEqual(ids("🚀", 42));
        expect(ids("🚀", 42)).toHaveLength(7);
        expect(
            new Set(Array.from({ length: 20 }, (_, i) => ids("🚀", i).join(","))).size,
        ).toBeGreaterThan(1);
        expect(
            new Set(["a", "b", "c", "d"].map((sid) => ids(sid, 42).join(","))).size,
        ).toBeGreaterThan(1);
    });

    it("excludes no-content rows before both recent and diverse selection", () => {
        const comps = history([5, 20, 40, 70, 90, 50, 70, 90]);
        const marker = makeCompartment({ sequence: 99, title: "", content: "" });
        const seeds = selectSeeds("ses-diverse", 42);
        const expected = selectSessionReferences(comps, seeds, "ses-diverse", 42);
        expect(expected).toHaveLength(7);
        expect(
            selectSessionReferences(
                [marker, ...comps.slice(0, 4), marker, ...comps.slice(4), marker],
                seeds,
                "ses-diverse",
                42,
            ),
        ).toEqual(expected);
    });

    it("shows every eligible compartment in young sessions without duplicates", () => {
        expect(SESSION_REF_WINDOW).toBe(4);
        for (let count = 0; count <= 7; count++) {
            const scores = Array(count).fill(50);
            expect(choose(scores)).toEqual(history(scores));
        }
    });

    it("trims diverse first, then the oldest recent, without reselection", () => {
        const refs = choose([5, 20, 40, 70, 90, 50, 70, 90, 50, 70, 90, 50]);
        expect(refs).toHaveLength(7);
        for (let count = 0; count <= 7; count++) {
            const block = renderSessionReferencesBlock(refs, count);
            const starts = [...block.matchAll(/<compartment start="(\d+)"/g)].map((m) =>
                Number(m[1]),
            );
            expect(starts).toEqual(
                count === 0 ? [] : refs.slice(-count).map((c) => c.startMessage),
            );
            expect((block.match(/ importance="/g) ?? []).length).toBe(Math.max(0, count - 4));
        }
        expect(refs.slice(-4).map((c) => c.startMessage)).toEqual([81, 91, 101, 111]);
    });
});

describe("reference seed corpus", () => {
    it("ships exactly 60 seeds spanning all 5 importance bands", () => {
        expect(REFERENCE_SEEDS.length).toBe(60);
        const imps = REFERENCE_SEEDS.map((s) => s.importance);
        expect(Math.min(...imps)).toBeLessThanOrEqual(9);
        expect(Math.max(...imps)).toBeGreaterThanOrEqual(85);
        // every block is a real compartment unit
        for (const s of REFERENCE_SEEDS) {
            expect(s.block.startsWith("<compartment")).toBe(true);
            expect(s.block).toContain("</compartment>");
        }
    });
});

describe("selectSeeds", () => {
    it("returns exactly 3 seeds by default", () => {
        expect(SEED_FLOOR).toBe(3);
        expect(selectSeeds("ses_a", 1).length).toBe(3);
    });

    it("keeps the exact examples across chunk starts of the same session", () => {
        const first = selectSeeds("ses_a", 1);
        for (let chunk = 1; chunk <= 30; chunk++) {
            expect(selectSeeds("ses_a", chunk)).toEqual(first);
        }
    });

    it("covers 3 distinct rotating bands every run", () => {
        for (let session = 1; session <= 20; session++) {
            const imps = selectSeeds(`ses_${session}`, 1).map((s) => s.importance);
            expect(new Set(imps.map(band)).size).toBe(3);
        }
    });

    it("never returns duplicate seeds within one selection", () => {
        for (let session = 1; session <= 20; session++) {
            const picks = selectSeeds(`ses_dup_${session}`, 1);
            expect(new Set(picks).size).toBe(picks.length);
        }
    });

    it("different sessionIds can produce different combinations", () => {
        const a = selectSeeds("ses_aaaa", 1)
            .map((s) => s.importance)
            .join(",");
        const b = selectSeeds("ses_zzzz", 1)
            .map((s) => s.importance)
            .join(",");
        // not asserting inequality strictly (hash collisions possible), but the
        // mechanism must consider sessionId — verify by sampling several.
        const distinct = new Set<string>();
        for (const sid of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
            distinct.add(
                selectSeeds(sid, 1)
                    .map((s) => s.importance)
                    .join(","),
            );
        }
        expect(distinct.size).toBeGreaterThan(1);
        void a;
        void b;
    });
});

describe("renderSeedExamplesBlock", () => {
    it("wraps seeds in the exact tag the prompt expects", () => {
        const block = renderSeedExamplesBlock(selectSeeds("ses_a", 1));
        expect(block.startsWith("<compartment_examples_from_other_projects>")).toBe(true);
        expect(block.endsWith("</compartment_examples_from_other_projects>")).toBe(true);
        expect(block).toContain("<compartment ");
    });

    it("returns empty string for zero seeds", () => {
        expect(renderSeedExamplesBlock([])).toBe("");
    });
});

describe("renderSessionReferencesBlock", () => {
    it("keeps diverse importance but hides recent scores, preserving episode_type everywhere", () => {
        const refs = selectSessionReferences(
            history([5, 20, 40, 70, 90, 5, 20, 40, 70, 90]).map((c) => ({
                ...c,
                episodeType: "feature",
            })),
            selectSeeds("score-visibility", 42),
            "score-visibility",
            42,
        );
        expect(refs).toHaveLength(7);
        const block = renderSessionReferencesBlock(refs);
        const headers = block.match(/<compartment [^>]+>/g) ?? [];
        expect(headers).toHaveLength(7);
        headers.forEach((header, i) => {
            expect(header).toContain('episode_type="feature"');
            expect(header.includes(' importance="')).toBe(i < 3);
            if (i < 3) expect(header).toContain(`importance="${refs[i].importance}"`);
        });
        const young = renderSessionReferencesBlock(refs.slice(-4));
        expect(young).not.toContain('importance="');
        expect((young.match(/episode_type="feature"/g) ?? []).length).toBe(4);
    });
    it("returns empty string for a young session (no compartments)", () => {
        expect(renderSessionReferencesBlock([])).toBe("");
    });

    it("renders a selected suffix up to the 7-reference budget", () => {
        const comps = Array.from({ length: 10 }, (_, i) =>
            makeCompartment({
                sequence: i,
                p1: `tier1-${i}`,
                p2: `t2-${i}`,
                p3: `t3-${i}`,
                p4: `t4-${i}`,
            }),
        );
        const block = renderSessionReferencesBlock(comps);
        // Rendering is separate from selection so fitting cannot reshuffle picks.
        expect(block).toContain("tier1-9");
        expect(block).toContain("tier1-3");
        expect(block).not.toContain("tier1-2");
        const count = (block.match(/<compartment /g) ?? []).length;
        expect(count).toBe(SESSION_REF_LIMIT);
    });

    it("renders v2 rows with all four tiers (p4 self-closes when empty)", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({
                sequence: 0,
                p1: "P1",
                p2: "P2",
                p3: "P3",
                p4: "",
                importance: 70,
                episodeType: "bug",
            }),
        ]);
        expect(block).toContain("<p1>\nP1\n</p1>");
        expect(block).toContain("<p2>\nP2\n</p2>");
        expect(block).toContain("<p3>\nP3\n</p3>");
        expect(block).toContain("<p4/>"); // empty p4 self-closes
        expect(block).not.toContain('importance="');
        expect(block).toContain('episode_type="bug"');
    });

    it("renders legacy rows as flat content with no tier tags", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({ sequence: 0, content: "old flat body", legacy: 1 }),
        ]);
        expect(block).toContain("old flat body");
        expect(block).not.toContain("<p1>");
    });

    it("escapes title attribute", () => {
        const block = renderSessionReferencesBlock([
            makeCompartment({
                sequence: 0,
                title: 'a "quoted" & <wild>',
                p1: "x",
                p2: "y",
                p3: "z",
                p4: "",
            }),
        ]);
        expect(block).not.toContain('title="a "quoted"');
        expect(block).toContain("&quot;");
    });
});

describe("buildReferenceBlocks", () => {
    it("always produces seed examples; session refs empty when young", () => {
        const blocks = buildReferenceBlocks({
            sessionId: "ses_a",
            chunkStart: 1,
            sessionCompartments: [],
        });
        expect(blocks.seedExamples).toContain("<compartment_examples_from_other_projects>");
        expect(blocks.sessionReferences).toBe("");
    });

    it("produces both blocks for a mature session", () => {
        const comps = [makeCompartment({ sequence: 0, p1: "a", p2: "b", p3: "c", p4: "" })];
        const blocks = buildReferenceBlocks({
            sessionId: "ses_a",
            chunkStart: 200,
            sessionCompartments: comps,
        });
        expect(blocks.seedExamples).toContain("<compartment_examples_from_other_projects>");
        expect(blocks.sessionReferences).toContain("<session_references>");
    });

    it("is fully deterministic (no embedding/clock/db)", () => {
        const comps = [makeCompartment({ sequence: 0, p1: "a", p2: "b", p3: "c", p4: "d" })];
        const a = buildReferenceBlocks({
            sessionId: "ses_z",
            chunkStart: 5,
            sessionCompartments: comps,
        });
        const b = buildReferenceBlocks({
            sessionId: "ses_z",
            chunkStart: 5,
            sessionCompartments: comps,
        });
        expect(a).toEqual(b);
    });
});
