import {
    appendCompartments,
    saveRecompStagingPass,
} from "../../plugin/src/features/magic-context/compartment-storage";
import { clearCachedM0M1 } from "../../plugin/src/features/magic-context/storage-meta";
import { openTestDb } from "./test-db";

/** Seed summaries and optional staging for a history whose last stored message has no text. */
export function stageNoiseTailFixture(
    dbPath: string,
    sessionId: string,
    rawIds: string[],
    staged: boolean,
    aligned = true,
) {
    const first = rawIds[0];
    const end = rawIds.at(-2);
    const noise = rawIds.at(-1);
    if (!first || !end || !noise || rawIds.length < 5)
        throw new Error("Missing raw fixture history");
    const prefix = {
        sequence: 0,
        startMessage: 1,
        endMessage: rawIds.length - 1,
        startMessageId: first,
        endMessageId: end,
        title: "Stable ledger",
        content: "The fixture recorded the ledger through its previous turn.",
        p1: "The fixture recorded the ledger through its previous turn.",
        p2: "The fixture recorded the ledger.",
        p3: "Ledger recorded.",
        p4: "Ledger",
    };
    const tail = {
        sequence: 1,
        startMessage: rawIds.length,
        endMessage: rawIds.length,
        startMessageId: noise,
        endMessageId: noise,
        title: "",
        content: "",
        p1: "",
        p2: "",
        p3: "",
        p4: "",
        importance: 1,
        episodeType: "filtered-noise",
    };
    const db = openTestDb(dbPath, { create: false });
    try {
        const live = aligned
            ? [prefix, tail]
            : [{ ...prefix, endMessage: tail.endMessage, endMessageId: tail.endMessageId }];
        appendCompartments(db as never, sessionId, live);
        clearCachedM0M1(db as never, sessionId);
        if (staged) saveRecompStagingPass(db as never, sessionId, 1, [prefix], []);
    } finally {
        db.close();
    }
    return { prefix, tail };
}
