import { expect, it } from "bun:test";
import {
    appendCompartments,
    buildCompartmentBlock,
    getCompartments,
} from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { Database } from "../../shared/sqlite";
import { renderCompartmentAtTier, renderDecayedCompartments } from "./decay-render";
import { readCurrentM0SnapshotMarkers, renderM0, renderM1 } from "./inject-compartments";
import { countCompartmentsNeedingUpgrade } from "./legacy-compartments";
import { persistFilteredNoise } from "./persist-filtered-noise";
import { readSessionChunk, setRawMessageProvider } from "./read-session-chunk";
import { renderSessionReferencesBlock } from "./reference-retrieval";

it("noise markers render no m0/m1 bytes and do not affect decay, references or upgrades", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "noise-render";
    const real = {
        sequence: 0,
        startMessage: 1,
        endMessage: 1,
        startMessageId: "m1",
        endMessageId: "m1",
        title: "Real",
        content: "Full",
        p1: "Full",
        p2: "Short",
        p3: "Tiny",
        p4: "Title",
    };
    appendCompartments(db, sessionId, [real]);
    const before = getCompartments(db, sessionId);
    const markers = readCurrentM0SnapshotMarkers({ db, sessionId });
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => [
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [{ type: "reasoning", text: "noise" }],
            },
        ],
    });
    try {
        expect(
            persistFilteredNoise(db, sessionId, readSessionChunk(sessionId, 1000, 2, 3), 3),
        ).toBe(true);
        const after = getCompartments(db, sessionId);
        const marker = after[1];
        for (const tier of [1, 2, 3, 4, 5]) expect(renderCompartmentAtTier(marker, tier)).toBe("");
        expect(buildCompartmentBlock([marker], [])).toBe("");
        for (const budget of [1, 100, 60000]) {
            expect(
                renderDecayedCompartments({ compartments: after, historyBudgetTokens: budget }),
            ).toBe(
                renderDecayedCompartments({ compartments: before, historyBudgetTokens: budget }),
            );
        }
        const m0 = (compartments: typeof before) =>
            renderM0({
                projectDocs: "",
                userProfileBaseline: [],
                compartments,
                memories: [],
                facts: [],
            });
        expect(m0(after)).toBe(m0(before));
        expect(
            renderM1({ db, sessionId, state: getOrCreateSessionMeta(db, sessionId) }, markers),
        ).not.toContain("new-compartments");
        expect(renderSessionReferencesBlock([...before, ...Array(8).fill(marker)])).toBe(
            renderSessionReferencesBlock(before),
        );
        expect(countCompartmentsNeedingUpgrade(db, sessionId)).toBe(0);
    } finally {
        unregister();
        db.close();
    }
});

it("does not persist empty, zero-width or incompletely observed ranges as filtered noise", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "missing-not-noise";
    const unregister = setRawMessageProvider(sessionId, {
        readMessages: () => [
            {
                ordinal: 2,
                id: "m2",
                role: "assistant",
                parts: [{ type: "reasoning", text: "noise" }],
            },
        ],
    });
    try {
        for (const [start, end] of [
            [1, 1],
            [1, 2],
            [1, 3],
            [3, 4],
        ]) {
            expect(
                persistFilteredNoise(
                    db,
                    sessionId,
                    readSessionChunk(sessionId, 1000, start, end),
                    end,
                ),
            ).toBe(false);
        }
        expect(getCompartments(db, sessionId)).toHaveLength(0);
    } finally {
        unregister();
        db.close();
    }
});

it("does not persist a filtered-noise marker whose end row the host dropped after the chunk was read", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "noise-end-dropped";
    const messages = [
        {
            ordinal: 1,
            id: "m1",
            role: "assistant",
            parts: [{ type: "reasoning", text: "noise" }],
        },
        {
            ordinal: 2,
            id: "m2",
            role: "assistant",
            parts: [{ type: "reasoning", text: "noise" }],
        },
    ];
    const unregister = setRawMessageProvider(sessionId, { readMessages: () => messages });
    try {
        const chunk = readSessionChunk(sessionId, 1000, 1, 3);
        // The host removes the interrupted step the chunk ended on.
        messages.splice(1, 1);
        expect(persistFilteredNoise(db, sessionId, chunk, 3)).toBe(false);
        expect(getCompartments(db, sessionId)).toHaveLength(0);
    } finally {
        unregister();
        db.close();
    }
});
