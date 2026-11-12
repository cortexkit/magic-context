import { afterEach, expect, test } from "bun:test";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { markLkgRecoveryDirty } from "./lkg-recovery-fence";
import {
    clearLkgRecoverySession,
    lkgRecoveryEntryUnproven,
    lkgRecoveryReplayUnproven,
    noteLkgRecoveryPrefix,
    readLkgRecoveryPrefix,
} from "./lkg-recovery-prefix";
import { projectLkgEntry } from "./lkg-replay";
import {
    captureSlot,
    getSlot,
    lkgContentDigest,
    noteEntry,
    resetLkgSlotsForTest,
} from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

afterEach(resetLkgSlotsForTest);

function message(id: string, text: string): MessageLike {
    return { info: { id, role: "user" }, parts: [{ type: "text", text }] };
}

function recovery() {
    const head = message("head", "head content");
    const tail = message("tail", "raw tail");
    const raw = [head, tail];
    captureSlot("session", {
        inputIdSeq: ["head"],
        inputContentDigests: [lkgContentDigest(head) as string],
        lastInputMessageId: "head",
        modelKey: null,
        providerKey: null,
        jsonPrefix: JSON.stringify([message("head", "§1§ head content")]),
        capturedAt: 1,
    });
    const entry = noteEntry("session", raw);
    if (!entry) throw new Error("Expected recovery entry");
    const output = [message("head", "§1§ head content"), tail];
    expect(
        noteLkgRecoveryPrefix({
            sessionId: "session",
            entry,
            messages: output,
            modelKey: null,
            providerKey: null,
            hostTailDigests: entry.pristineTail.map(lkgContentDigest),
        }),
    ).toBe(true);
    return { raw, entry, output };
}

test("recovered output and content evidence are detached from host mutations", () => {
    const { raw, output } = recovery();
    const pristine = structuredClone(raw);
    output[1].parts.length = 0;
    const read = readLkgRecoveryPrefix("session", projectLkgEntry(pristine), pristine);
    expect(read.prefix?.json).toContain("raw tail");
    expect(read.prefix?.untaggedInputIds.has("tail")).toBe(true);
    expect(readLkgRecoveryPrefix("session", projectLkgEntry(raw), raw).rebuildReason).toBe(
        "lkg_recovery_input_rebuild",
    );
});

for (const change of ["edited", "contracted", "reordered"] as const) {
    test(`recovery refuses ${change} identities/content rather than guessing positions`, () => {
        const { raw } = recovery();
        const next =
            change === "edited"
                ? [raw[0], message("tail", "edited tail")]
                : change === "contracted"
                  ? raw.slice(1)
                  : [raw[1], raw[0]];
        expect(readLkgRecoveryPrefix("session", projectLkgEntry(next), next).rebuildReason).toBe(
            "lkg_recovery_input_rebuild",
        );
        const entry = noteEntry("session", next);
        if (entry) expect(lkgRecoveryEntryUnproven("session", entry, next)).toBe(true);
    });
}

test("restart refuses busy replay and declares a healthy rebuild of an unproven request", () => {
    const { dir } = createTestTempDir("mc-prefix-restart-");
    const previous = process.env.MAGIC_CONTEXT_STORAGE_DIR;
    process.env.MAGIC_CONTEXT_STORAGE_DIR = dir;
    try {
        const { raw } = recovery();
        markLkgRecoveryDirty({
            sessionId: "session",
            slot: getSlot("session")!,
            processLocalProof: true,
        });
        clearLkgRecoverySession("session");
        expect(lkgRecoveryReplayUnproven("session")).toBe(true);
        expect(readLkgRecoveryPrefix("session", projectLkgEntry(raw), raw).rebuildReason).toBe(
            "lkg_restart_rebuild",
        );
    } finally {
        if (previous === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
        else process.env.MAGIC_CONTEXT_STORAGE_DIR = previous;
        cleanupTestTempDir(dir);
    }
});
