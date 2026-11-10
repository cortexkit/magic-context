import { beforeEach, describe, expect, test } from "bun:test";
import {
    hostCheckpointChangedServedHead,
    rememberServedHead,
    resetServedHeadsForTest,
} from "./host-checkpoint-ride";
import {
    clearPendingMaterializationOrigin,
    hasPendingMaterializationOrigin,
    pendingMaterializationOrigin,
    requestPendingMaterialization,
} from "./pending-materialization";

beforeEach(() => resetServedHeadsForTest());

describe("hostCheckpointChangedServedHead", () => {
    test("a head that differs from the one the previous pass injected is a ride", () => {
        rememberServedHead("s", { m0Text: "<session-history></session-history>", m1Text: "NEW" });
        expect(
            hostCheckpointChangedServedHead("s", {
                m0Text: "<session-history>NEW</session-history>",
                m1Text: "(no new content)",
            }),
        ).toBe(true);
    });

    test("an unchanged head keeps its cache: no ride", () => {
        const mural = "data:image/png;base64,AA";
        rememberServedHead("s", { m0Text: "M0", m1Text: "M1", muralDataUrl: mural });
        expect(
            hostCheckpointChangedServedHead("s", {
                m0Text: "M0",
                m1Text: "M1",
                muralDataUrl: mural,
            }),
        ).toBe(false);
    });

    test("a changed mural image alone is a changed head", () => {
        rememberServedHead("s", { m0Text: "M0", m1Text: "M1", muralDataUrl: null });
        expect(
            hostCheckpointChangedServedHead("s", {
                m0Text: "M0",
                m1Text: "M1",
                muralDataUrl: "data:image/png;base64,AA",
            }),
        ).toBe(true);
    });

    test("without a recorded head or cached head bytes the change is not proven", () => {
        expect(hostCheckpointChangedServedHead("s", { m0Text: "M0", m1Text: "M1" })).toBe(false);
        rememberServedHead("other", { m0Text: "M0", m1Text: "M1" });
        expect(hostCheckpointChangedServedHead("s", { m0Text: "X", m1Text: "Y" })).toBe(false);
        rememberServedHead("s", { m0Text: "M0", m1Text: "M1" });
        expect(hostCheckpointChangedServedHead("s", { m0Text: null, m1Text: "M1" })).toBe(false);
        expect(hostCheckpointChangedServedHead("s", { m0Text: "M0", m1Text: undefined })).toBe(
            false,
        );
        // A pass that served no head leaves nothing to compare with.
        rememberServedHead("s", { m0Text: null, m1Text: null });
        expect(hostCheckpointChangedServedHead("s", { m0Text: "X", m1Text: "Y" })).toBe(false);
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
