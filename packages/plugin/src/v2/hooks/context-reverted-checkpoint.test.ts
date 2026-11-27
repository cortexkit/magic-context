import { expect, spyOn, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { clearCachedM0M1 } from "../../features/magic-context/storage-meta-shared";
import { NativeFoldReplay } from "../fold/native-replay";
import type { AdmissionV3, CapturedReplayV3 } from "../fold/native-replay-v3";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import { HEAD_IDS } from "./payload";
import type { SessionContext } from "./types";

async function revertedCheckpoint() {
    const f = await oc2ContextFixture(62971, {
        area: "oc2-reverted-checkpoint",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
    });
    try {
        await f.pass();
        const early = await f.nativeFold(3, 2, "", "manual");
        const earlyMessage = structuredClone(f.checkpoint!);
        for (let index = 0; index < 6; index++) {
            f.user(`turn between checkpoints ${index}`, 1000);
            f.respond();
        }
        const retained = f.rows[27]!;
        const firstSummary = f.rows[29]!;
        const laterSummary = f.rows[33]!;
        f.compartment(29);
        f.compartment(33);
        await f.pass();
        const late = await f.nativeFold(3, 2, "", "manual");
        const key = `native-fold/v3/${encodeURIComponent(f.session)}`;
        const captureKey = `native-fold-state/v3/${encodeURIComponent(f.session)}`;
        const staleAdmission = (await f.hostStorage.get(key)) as { payload: string };
        const staleCapture = (await f.hostStorage.get(captureKey)) as { payload: string };
        expect((JSON.parse(staleAdmission.payload) as AdmissionV3).proof.admissionID).toBe(late);
        expect(JSON.parse(staleCapture.payload).replay.floor.seq).toBeGreaterThan(retained.seq);
        const pass = () =>
            f.pass((draft) => {
                // On revert the host presents the earlier local checkpoint and its
                // kept tail, not the checkpoint deleted with the newer suffix.
                draft.messages = [
                    structuredClone(earlyMessage),
                    ...f.rows.slice(23).map((row) => ({
                        id: row.id,
                        role: row.type,
                        content: [{ type: "text" as const, text: row.text }],
                        ...(row.type === "user" ? { metadata: {} } : {}),
                    })),
                ];
            });
        f.revertBefore(f.rows[28]!.id);
        f.raw.prepare("DELETE FROM session_message WHERE id = ?").run(late);
        await f.restart();
        const receiptsUnchanged = async () => {
            expect(await f.hostStorage.get(key)).toEqual(staleAdmission);
            expect(await f.hostStorage.get(captureKey)).toEqual(staleCapture);
        };
        const stored = (after: number) =>
            (
                f.raw
                    .prepare(
                        "SELECT id FROM session_message WHERE session_id = ? AND seq > ? AND type IN ('user', 'assistant') ORDER BY seq",
                    )
                    .all(f.session, after) as { id: string }[]
            ).map(({ id }) => id);
        expect(
            f.raw.prepare("SELECT id FROM session_message WHERE id = ?").get(early),
        ).toBeTruthy();
        expect(
            f.raw.prepare("SELECT id FROM session_message WHERE id = ?").get(firstSummary.id),
        ).toBeNull();
        expect(
            f.raw.prepare("SELECT id FROM session_message WHERE id = ?").get(laterSummary.id),
        ).toBeNull();
        return { f, pass, receiptsUnchanged, stored };
    } catch (error) {
        await f.cleanup();
        throw error;
    }
}

function rawIDs(draft: SessionContext) {
    return draft.messages.flatMap(({ id }) =>
        id && !HEAD_IDS.some((head) => head === id) ? [id] : [],
    );
}

test("reverting to an older checkpoint still refuses when none of the summaries survive", async () => {
    const { f, pass, receiptsUnchanged } = await revertedCheckpoint();
    try {
        await expect(pass()).rejects.toThrow("Magic Context refused to send an unsafe prompt");
        expect(f.sessionLogs().join("\n")).toMatch(
            /history boundary unresolved:.*no older compartment end is in the host store/,
        );
        expect(f.sessionLogs().join("\n")).toContain(
            "replay refused: invalid checkpoint floor or provenance",
        );
        expect(f.sessionLogs().join("\n")).toMatch(
            /\[MC-S06\].*Host checkpoint replay boundary is unavailable/,
        );
        await receiptsUnchanged();
    } finally {
        await f.cleanup();
    }
});

test("a rebuilt summary recovers an older checkpoint even though the reverted receipt survives", async () => {
    const { f, pass, receiptsUnchanged, stored } = await revertedCheckpoint();
    try {
        // Model a committed summary rebuild: a new summary and no baseline,
        // without revoking the newer checkpoint's native receipts.
        f.db.prepare("DELETE FROM compartments WHERE session_id = ?").run(f.session);
        const rebuilt = f.rows[4]!;
        appendCompartments(f.db, f.session, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 5,
                startMessageId: f.rows[0]!.id,
                endMessageId: rebuilt.id,
                title: "Rebuilt surviving history",
                content: "The five surviving opening rows were reviewed.",
                p1: "The five surviving opening rows were reviewed.",
                p2: "The five surviving opening rows were reviewed.",
                p3: "Reviewed the opening history.",
                p4: "Reviewed the opening history.",
            },
        ]);
        clearCachedM0M1(f.db, f.session);
        await receiptsUnchanged();
        const first = await pass();
        expect(first.logs.join("\n")).toContain(
            "replay refused: invalid checkpoint floor or provenance",
        );
        expect(first.logs.join("\n")).not.toContain("history boundary repair:");
        expect(rawIDs(first.draft)).toEqual(stored(rebuilt.seq));
        const next = await pass();
        expect(rawIDs(next.draft)).toEqual(stored(rebuilt.seq));
        expect(next.bytes).toBe(first.bytes);
        expect(next.logs.join("\n")).not.toMatch(/history boundary repair:|HARD.*executed=true/);
    } finally {
        await f.cleanup();
    }
});

test("an older checkpoint restores from the first stored row after every summary is retired", async () => {
    const { f, pass, receiptsUnchanged, stored } = await revertedCheckpoint();
    try {
        // The committed-revert cleanup has removed all summaries and their cache.
        f.db.prepare("DELETE FROM compartments WHERE session_id = ?").run(f.session);
        clearCachedM0M1(f.db, f.session);
        await receiptsUnchanged();

        const first = await pass();
        expect(rawIDs(first.draft)).toEqual(stored(-1));
        expect(first.bytes).not.toContain("Review history");
        const captured = (await f.hostStorage.get(`native-fold-state/v3/${f.session}`)) as {
            payload: string;
        };
        expect((JSON.parse(captured.payload) as CapturedReplayV3).replay.floor).toMatchObject({
            kind: "start",
            id: stored(-1)[0],
        });
        await f.restart();
        const next = await pass();
        expect(rawIDs(next.draft)).toEqual(stored(-1));
        expect(next.bytes).toBe(first.bytes);
        expect(next.logs.join("\n")).not.toContain("starting at stored row");
        await f.nativeFold(3, 2, "", "manual");
        expect(rawIDs((await f.pass()).draft)).toEqual(stored(-1));
    } finally {
        await f.cleanup();
    }
});

test("a null cached boundary restores all rows even when the first-row capture failed", async () => {
    const { f, pass, receiptsUnchanged, stored } = await revertedCheckpoint();
    const capture = spyOn(NativeFoldReplay.prototype, "capture").mockRejectedValueOnce(
        new Error("capture store unavailable"),
    );
    try {
        f.db.prepare("DELETE FROM compartments WHERE session_id = ?").run(f.session);
        clearCachedM0M1(f.db, f.session);
        const first = await pass();
        expect(rawIDs(first.draft)).toEqual(stored(-1));
        await receiptsUnchanged();
        await f.restart();
        const next = await pass();
        expect(rawIDs(next.draft)).toEqual(stored(-1));
        expect(next.bytes).toBe(first.bytes);
        expect(next.logs.join("\n")).toContain("starting at stored row");
    } finally {
        capture.mockRestore();
        await f.cleanup();
    }
});

test("a priced pass starting at a null boundary captures the new summary that it serves", async () => {
    const { f, pass, stored } = await revertedCheckpoint();
    const capture = spyOn(NativeFoldReplay.prototype, "capture").mockRejectedValueOnce(
        new Error("capture store unavailable"),
    );
    try {
        f.db.prepare("DELETE FROM compartments WHERE session_id = ?").run(f.session);
        clearCachedM0M1(f.db, f.session);
        expect(rawIDs((await pass()).draft)).toEqual(stored(-1));
        await f.restart();

        const end = f.rows[4]!;
        appendCompartments(f.db, f.session, [
            {
                sequence: 0,
                startMessage: 1,
                endMessage: 5,
                startMessageId: f.rows[0]!.id,
                endMessageId: end.id,
                title: "Published while the cached boundary was empty",
                content: "Five opening rows were summarized.",
                p1: "Five opening rows were summarized.",
            },
        ]);
        f.setSystem("Independently changed system prefix permits the history refresh.");
        const first = await pass();
        expect(first.logs.join("\n")).toContain("starting at stored row");
        expect(first.bytes).toContain("Published while the cached boundary was empty");
        expect(rawIDs(first.draft)).toEqual(stored(end.seq));
        const key = `native-fold-state/v3/${f.session}`;
        const captured = (await f.hostStorage.get(key)) as { payload: string };
        expect((JSON.parse(captured.payload) as CapturedReplayV3).replay.floor).toMatchObject({
            kind: "summary",
            id: end.id,
        });
        const next = await pass();
        expect(next.bytes).toBe(first.bytes);
        expect(next.logs.join("\n")).not.toContain("starting at stored row");
    } finally {
        capture.mockRestore();
        await f.cleanup();
    }
});
