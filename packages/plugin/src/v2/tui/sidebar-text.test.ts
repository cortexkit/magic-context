import { expect, test } from "bun:test";
import { COMPACTION_ENABLED_PATH } from "../../config/agent-disable";
import type { SidebarSnapshot, StatusDetail } from "../../shared/rpc-types";
import { sidebarText, statusText } from "./index";

function snapshot(overrides: Partial<SidebarSnapshot>): SidebarSnapshot {
    return {
        sessionId: "ses-test",
        usagePercentage: 42,
        inputTokens: 4200,
        contextLimit: 10000,
        systemPromptTokens: 0,
        compartmentCount: 3,
        memoryCount: 7,
        memoryBlockCount: 2,
        pendingOpsCount: 1,
        historianRunning: false,
        lastTransformError: null,
        ...overrides,
    } as SidebarSnapshot;
}

test("compaction-off sidebar mirrors the v1 rows and native context label", () => {
    const text = sidebarText(
        snapshot({
            compaction_enabled: false,
            archivedCompartmentCount: 4,
            sessionNoteCount: 2,
            readySmartNoteCount: 1,
        }),
    );
    expect(text).toContain("Context: 42.0% · native compaction");
    expect(text).toContain("Memories 7");
    expect(text).toContain("Notes 2");
    expect(text).toContain("Archived compartments 4");
    expect(text).toContain("Smart Notes 1 ready");
    expect(text).not.toContain("Historian");
});

test("compaction-on sidebar keeps the historian/compartment line", () => {
    const text = sidebarText(snapshot({ compaction_enabled: true }));
    expect(text).toContain("Historian idle · C:3");
    expect(text).toContain("Memories 2/7 · Q:1");
    expect(text).not.toContain("native compaction");
});

test("status dialog prefixes the compaction-off notice", () => {
    const detail = {
        ...snapshot({ compaction_enabled: false }),
    } as unknown as StatusDetail;
    expect(statusText(detail)).toContain(
        `Compaction: disabled (${COMPACTION_ENABLED_PATH}: false) — native compaction owns the context window.`,
    );
    expect(statusText({ ...detail, compaction_enabled: true } as StatusDetail)).not.toContain(
        "Compaction: disabled",
    );
});
