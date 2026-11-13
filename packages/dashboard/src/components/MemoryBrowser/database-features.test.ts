import { describe, expect, test } from "bun:test";
import type { DatabaseCapabilities } from "../../lib/api";
import { archiveConfirmation, memoryHistoryAvailable } from "./database-features";

const modern: DatabaseCapabilities = {
  schemaVersion: 106,
  memoryRevision: true,
  memoryHistory: true,
  memoryUndo: true,
  compartmentScores: true,
};

describe("database feature presentation", () => {
  test("history and undo stay hidden on a store ck-mc hasn't upgraded and while capabilities load", () => {
    expect(memoryHistoryAvailable(undefined)).toBe(false);
    expect(
      memoryHistoryAvailable({
        ...modern,
        schemaVersion: 105,
        memoryHistory: false,
        memoryUndo: false,
      }),
    ).toBe(false);
    expect(memoryHistoryAvailable({ ...modern, memoryUndo: false })).toBe(false);
    expect(memoryHistoryAvailable(modern)).toBe(true);
  });

  test("legacy archive confirmation never promises unavailable undo", () => {
    expect(archiveConfirmation(1, false)).toBe("Archive 1 memory? They stop going into sessions.");
    expect(archiveConfirmation(2, true)).toBe(
      "Archive 2 memories? They stop going into sessions. You can undo this from History.",
    );
  });

  test("both history entry points use the capability gate", async () => {
    const browser = await Bun.file(new URL("./MemoryBrowser.tsx", import.meta.url)).text();
    const detail = await Bun.file(new URL("./MemoryDetail.tsx", import.meta.url)).text();
    expect(browser).toContain("embedded() && historyAvailable()");
    expect(browser).toContain('view() === "history" && embedded() && historyAvailable()');
    expect(browser).toContain("historyAvailable={historyAvailable()}");
    expect(detail).toContain("<Show when={props.historyAvailable}>");
    expect(detail).toContain('tab() === "history" && props.historyAvailable');
  });
});
