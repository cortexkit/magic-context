import { beforeEach, describe, expect, test } from "bun:test";
import {
    beginHostCheckpointPass,
    completeHostCheckpointPass,
    hostCheckpointHeadChange,
    noteHostCheckpointCommit,
    resetServedHeadsForTest,
    revertHostCheckpointPass,
    type ServedHead,
    servedHeadChanged,
    stageServedHead,
} from "./host-checkpoint-ride";
import {
    clearPendingMaterializationOrigin,
    hasPendingMaterializationOrigin,
    pendingMaterializationOrigin,
    requestPendingMaterialization,
} from "./pending-materialization";

beforeEach(() => resetServedHeadsForTest());

/** A pass that injects `head` and completes. */
function servePass(sessionId: string, head: ServedHead, pending = new Set<string>()) {
    beginHostCheckpointPass(sessionId, pending);
    stageServedHead(sessionId, head, 0);
    completeHostCheckpointPass(sessionId, pending, false);
}

const changed = (sessionId: string, head: ServedHead) =>
    hostCheckpointHeadChange(sessionId, () => head).changed;

describe("comparison with the head the last completed pass served", () => {
    test("a head that differs from the one the previous pass served is a ride", () => {
        servePass("s", { m0Text: "<session-history></session-history>", m1Text: "NEW" });
        expect(
            hostCheckpointHeadChange("s", () => ({
                m0Text: "<session-history>NEW</session-history>",
                m1Text: "(no new content)",
            })),
        ).toEqual({ changed: true, source: "served_head", previousCoverage: 0 });
    });

    test("an unchanged head keeps its cache: no ride", () => {
        const mural = "data:image/png;base64,AA";
        servePass("s", { m0Text: "M0", m1Text: "M1", muralDataUrl: mural });
        expect(changed("s", { m0Text: "M0", m1Text: "M1", muralDataUrl: mural })).toBe(false);
    });

    test("a changed mural image alone is a changed head", () => {
        servePass("s", { m0Text: "M0", m1Text: "M1", muralDataUrl: null });
        expect(
            changed("s", { m0Text: "M0", m1Text: "M1", muralDataUrl: "data:image/png;base64,AA" }),
        ).toBe(true);
    });

    test("a mural block the wire never carries is not a change", () => {
        // Without a mural image, m[0] is served with its mural block stripped.
        const m0 = (text: string) => `M0\n\n<memory-mural>\n${text}\n</memory-mural>`;
        expect(
            servedHeadChanged(
                { m0Text: m0("one"), m1Text: "M1" },
                { m0Text: m0("two"), m1Text: "M1" },
            ),
        ).toBe(false);
        expect(
            servedHeadChanged(
                { m0Text: m0("one"), m1Text: "M1", muralDataUrl: "data:a" },
                { m0Text: m0("two"), m1Text: "M1", muralDataUrl: "data:a" },
            ),
        ).toBe(true);
    });

    test("without a recorded head or cached head bytes the change is not proven", () => {
        expect(hostCheckpointHeadChange("s", () => ({ m0Text: "M0", m1Text: "M1" }))).toEqual({
            changed: false,
            source: "none",
            previousCoverage: null,
        });
        servePass("other", { m0Text: "M0", m1Text: "M1" });
        expect(changed("s", { m0Text: "X", m1Text: "Y" })).toBe(false);
        servePass("s", { m0Text: "M0", m1Text: "M1" });
        expect(changed("s", { m0Text: null, m1Text: "M1" })).toBe(false);
        expect(changed("s", { m0Text: "M0", m1Text: undefined })).toBe(false);
        // A pass that served no head leaves nothing to compare with.
        servePass("s", { m0Text: null, m1Text: null });
        expect(changed("s", { m0Text: "X", m1Text: "Y" })).toBe(false);
    });

    test("a pass that did not complete records nothing", () => {
        servePass("s", { m0Text: "M0", m1Text: "M1" });
        beginHostCheckpointPass("s", new Set());
        stageServedHead("s", { m0Text: "NEW", m1Text: "M1" }, 1);
        // The pass failed before completing: the provider never saw NEW.
        expect(changed("s", { m0Text: "NEW", m1Text: "M1" })).toBe(true);
    });
});

describe("the compaction hook's record", () => {
    test("is the proof whatever this process served before", () => {
        noteHostCheckpointCommit("s", { changed: true, previousCoverage: 3 });
        expect(hostCheckpointHeadChange("s", () => ({ m0Text: "M0", m1Text: "M1" }))).toEqual({
            changed: true,
            source: "commit",
            previousCoverage: 3,
        });
        servePass("t", { m0Text: "M0", m1Text: "M1" });
        noteHostCheckpointCommit("t", { changed: false, previousCoverage: 3 });
        expect(changed("t", { m0Text: "DIFFERENT", m1Text: "M1" })).toBe(false);
    });

    test("a completed pass that settles the request withdraws it and its record", () => {
        const pending = new Set<string>();
        noteHostCheckpointCommit("s", { changed: true, previousCoverage: 0 });
        requestPendingMaterialization(pending, "s", "host_compaction");
        beginHostCheckpointPass("s", pending);
        stageServedHead("s", { m0Text: "NEW", m1Text: "M1" }, 1);
        completeHostCheckpointPass("s", pending, true);
        expect(hasPendingMaterializationOrigin(pending, "s", "host_compaction")).toBe(false);
        // The served head now matches: no second ride on the same bytes.
        expect(changed("s", { m0Text: "NEW", m1Text: "M1" })).toBe(false);
    });

    test("a pass that could not take the ride keeps the request and its record", () => {
        const pending = new Set<string>();
        noteHostCheckpointCommit("s", { changed: true, previousCoverage: 0 });
        requestPendingMaterialization(pending, "s", "host_compaction");
        beginHostCheckpointPass("s", pending);
        completeHostCheckpointPass("s", pending, false);
        expect(hasPendingMaterializationOrigin(pending, "s", "host_compaction")).toBe(true);
        expect(changed("s", { m0Text: "NEW", m1Text: "M1" })).toBe(true);
    });

    test("a request the shared drain cleared drops its record", () => {
        const pending = new Set<string>();
        noteHostCheckpointCommit("s", { changed: true, previousCoverage: 0 });
        requestPendingMaterialization(pending, "s", "host_compaction");
        beginHostCheckpointPass("s", pending);
        pending.delete("s");
        completeHostCheckpointPass("s", pending, false);
        expect(hostCheckpointHeadChange("s", () => ({ m0Text: "M0", m1Text: "M1" })).source).toBe(
            "none",
        );
    });

    test("a pass refused after it settled the request puts the request, record and served head back", () => {
        const pending = new Set<string>();
        servePass("s", { m0Text: "OLD", m1Text: "M1" });
        noteHostCheckpointCommit("s", { changed: true, previousCoverage: 0 });
        requestPendingMaterialization(pending, "s", "host_compaction");
        beginHostCheckpointPass("s", pending);
        stageServedHead("s", { m0Text: "NEW", m1Text: "M1" }, 1);
        completeHostCheckpointPass("s", pending, true);
        revertHostCheckpointPass("s", pending);
        expect(hasPendingMaterializationOrigin(pending, "s", "host_compaction")).toBe(true);
        expect(hostCheckpointHeadChange("s", () => ({ m0Text: "NEW", m1Text: "M1" }))).toEqual({
            changed: true,
            source: "commit",
            previousCoverage: 0,
        });
    });

    test("reverting a pass that saw no request changes nothing pending", () => {
        const pending = new Set<string>();
        beginHostCheckpointPass("s", pending);
        revertHostCheckpointPass("s", pending);
        expect(pending.has("s")).toBe(false);
    });
});

describe("clearPendingMaterializationOrigin", () => {
    test("withdraws one cause and keeps the session pending for the others", () => {
        const sessions = new Set<string>();
        requestPendingMaterialization(sessions, "s", "host_compaction");
        requestPendingMaterialization(sessions, "s", "user_flush");
        clearPendingMaterializationOrigin(sessions, "s", "host_compaction");
        expect(sessions.has("s")).toBe(true);
        expect(hasPendingMaterializationOrigin(sessions, "s", "host_compaction")).toBe(false);
        expect(hasPendingMaterializationOrigin(sessions, "s", "user_flush")).toBe(true);
        expect(pendingMaterializationOrigin(sessions, "s")).toBe("user_flush");
    });

    test("withdrawing the only cause leaves nothing pending", () => {
        const sessions = new Set<string>();
        requestPendingMaterialization(sessions, "s", "host_compaction");
        clearPendingMaterializationOrigin(sessions, "s", "host_compaction");
        expect(sessions.has("s")).toBe(false);
        expect(pendingMaterializationOrigin(sessions, "s")).toBe("pending_materialization");
    });

    test("a cause that was never requested changes nothing", () => {
        const sessions = new Set<string>();
        requestPendingMaterialization(sessions, "s", "system_hash");
        clearPendingMaterializationOrigin(sessions, "s", "host_compaction");
        expect(sessions.has("s")).toBe(true);
        expect(pendingMaterializationOrigin(sessions, "s")).toBe("system_hash");
    });
});
