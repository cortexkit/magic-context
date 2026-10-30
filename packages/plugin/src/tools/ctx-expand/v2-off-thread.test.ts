import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { contextStore } from "../../features/magic-context/__tests__/host-stalls.fixture";
import { createTagger } from "../../features/magic-context/tagger";
import { setBoundedRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { createV2RawMessageProvider, createV2RawMessageReader } from "../../v2/hooks/store";
import { ordinalFixture } from "../../v2/ordinal-range.fixture";
import { V2StoreReader } from "../../v2/store-reader";
import { renderSearchArchive, renderSearchArchiveOffThread } from "./search-archive";
import { createCtxExpandTools } from "./tools";
import { stopV2ArchiveReader } from "./v2-archive-reader";

test("v2 ctx_expand range, message and tag never call synchronous provider readers", async () => {
    const f = ordinalFixture();
    const db = contextStore(join(f.path, "..", "context.db"));
    const read = createV2RawMessageReader(() => new V2StoreReader(f.path), f.path);
    const provider = createV2RawMessageProvider(read, "s");
    const range = spyOn(provider, "readMessageIdOrdinalsForRange");
    const byId = spyOn(provider, "readMessageById");
    const ordinal = spyOn(provider, "readMessageOrdinalById");
    const unregister = setBoundedRawMessageProvider("s", provider);
    try {
        const ids = read.ordinalMapForRange("s", 26_640, 26_662);
        const insert = db.prepare(
            "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES ('s',?,?, 'user',?)",
        );
        for (const [id, n] of ids) insert.run(n, n % 2 ? id : `pruned-${n}`, `archive ${n}`);
        const expected = renderSearchArchive(db, "s", 26_640, 26_662, 6000, false, () => ids);
        expect(expected).toContain("archive 26640");
        expect(await renderSearchArchiveOffThread(db, "s", 26_640, 26_662, 6000)).toBe(expected);
        const expand = createCtxExpandTools({ db }).ctx_expand;
        expect(await expand.execute({ message: 26_640 }, { sessionID: "s" } as never)).toContain(
            "archive 26640",
        );
        const tag = createTagger().assignTag("s", "m-39996:p0", "message", 10, db);
        expect(await expand.execute({ tag }, { sessionID: "s" } as never)).toBe(
            "  [text]\nturn 39996",
        );
        f.db.exec("DELETE FROM session_message WHERE session_id='s' AND seq >= 119_940");
        const revertedIds = read.ordinalMapForRange("s", 26_640, 26_662);
        const reverted = renderSearchArchive(
            db,
            "s",
            26_640,
            26_662,
            6000,
            false,
            () => revertedIds,
        );
        expect(await renderSearchArchiveOffThread(db, "s", 26_640, 26_662, 6000)).toBe(reverted);
        expect(await expand.execute({ tag }, { sessionID: "s" } as never)).toBe(
            "Tag 1's original text is no longer in stored history.",
        );
        expect(range).not.toHaveBeenCalled();
        expect(byId).not.toHaveBeenCalled();
        expect(ordinal).not.toHaveBeenCalled();
    } finally {
        await stopV2ArchiveReader();
        range.mockRestore();
        byId.mockRestore();
        ordinal.mockRestore();
        unregister();
        db.close();
        f.cleanup();
    }
}, 30_000);

test("v2 archive and tag worker failures never fall back to synchronous readers", async () => {
    const f = ordinalFixture();
    const db = contextStore(join(f.path, "..", "context.db"));
    const read = createV2RawMessageReader(() => new V2StoreReader(f.path), `${f.path}.missing`);
    const provider = createV2RawMessageProvider(read, "s");
    const range = spyOn(provider, "readMessageIdOrdinalsForRange");
    const byId = spyOn(provider, "readMessageById");
    const unregister = setBoundedRawMessageProvider("s", provider);
    try {
        db.prepare(
            "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES ('s',1,'pruned','user','archive')",
        ).run();
        createTagger().assignTag("s", "m-0:p0", "message", 10, db);
        await expect(renderSearchArchiveOffThread(db, "s", 1, 1, 6000)).rejects.toThrow(
            "Search archive worker unavailable",
        );
        await expect(
            createCtxExpandTools({ db }).ctx_expand.execute({ tag: 1 }, {
                sessionID: "s",
            } as never),
        ).rejects.toThrow("Search archive worker unavailable");
        expect(range).not.toHaveBeenCalled();
        expect(byId).not.toHaveBeenCalled();
    } finally {
        await stopV2ArchiveReader();
        range.mockRestore();
        byId.mockRestore();
        unregister();
        db.close();
        f.cleanup();
    }
}, 30_000);
