import { describe, expect, it } from "bun:test";
import type { OpenCodeStoreRow } from "../../lib/types";
import {
  configuredStorePaths,
  dashboardWithStorePaths,
  isAbsoluteStorePath,
  sessionStoreViews,
  storePathError,
} from "./session-stores";
import { structuredConfigSaveContent } from "./structured-save";

const rows: OpenCodeStoreRow[] = [
  {
    path: "/home/me/.local/share/opencode/opencode.db",
    origin: "default",
    found: true,
    read: true,
  },
  {
    path: "/data/thalamus/opencode2-server/data/opencode/opencode.db",
    origin: "runner",
    found: true,
    read: false,
    note: "Skipped: -wal exists without -shm.",
  },
  {
    path: "/srv/copy/opencode.db",
    origin: "configured",
    found: false,
    read: false,
    note: "Not found.",
    configured_value: "/srv/copy",
  },
];

describe("session stores section", () => {
  it("lists found stores read-only, then each configured path with its saved status", () => {
    const views = sessionStoreViews(rows, ["/srv/copy", "D:\\stores\\opencode.db"]);
    expect(views.map((view) => [view.origin, view.status, view.configuredIndex])).toEqual([
      ["default", "Found", undefined],
      ["runner", "Skipped: -wal exists without -shm.", undefined],
      ["configured", "Not found.", 0],
      ["configured", "Not saved yet.", 1],
    ]);
    // A saved folder shows the file the dashboard resolved inside it.
    expect(views[2].path).toBe("/srv/copy/opencode.db");
    expect(views[3].path).toBe("D:\\stores\\opencode.db");
    expect(views.map((view) => view.tone)).toEqual(["ok", "problem", "problem", "pending"]);
  });

  it("still shows configured paths when the store list could not be read", () => {
    expect(sessionStoreViews(undefined, ["/srv/a"])).toEqual([
      {
        path: "/srv/a",
        origin: "configured",
        configuredIndex: 0,
        status: "Not saved yet.",
        tone: "pending",
      },
    ]);
  });

  it("refuses relative, token and duplicate paths and accepts absolute ones", () => {
    for (const path of ["/srv/opencode.db", "C:\\Users\\me\\opencode", "C:/x", "\\\\nas\\share"]) {
      expect(isAbsoluteStorePath(path)).toBe(true);
      expect(storePathError(path, [])).toBeNull();
    }
    for (const path of ["opencode.db", "./x", "~/x", "C:relative"]) {
      expect(storePathError(path, [])).toContain("absolute path");
    }
    expect(storePathError("{env:HOME}/opencode.db", [])).toContain("{env:}");
    expect(storePathError("/srv/{file:x}", [])).toContain("{file:}");
    expect(storePathError("   ", [])).toBe("Enter a path.");
    expect(storePathError(" /srv/a ", ["/srv/a"])).toBe("This path is already listed.");
  });

  it("reads only string entries from the config value", () => {
    expect(configuredStorePaths(["/a", 3, null, "/b"])).toEqual(["/a", "/b"]);
    expect(configuredStorePaths(undefined)).toEqual([]);
    expect(configuredStorePaths("/a")).toEqual([]);
  });

  it("saves added and removed paths into the file without losing its comments", () => {
    const content = `{
  // my stores
  "dashboard": {
    // keep this comment
    "opencode_db_paths": ["/srv/a"],
  },
  "enabled": true,
}
`;
    const added = structuredConfigSaveContent(content, {
      dashboard: { opencode_db_paths: ["/srv/a", "C:\\stores"] },
      enabled: true,
    });
    expect(added).toContain("// my stores");
    expect(added).toContain("// keep this comment");
    expect(added).toContain('["/srv/a","C:\\\\stores"]');

    const removed = structuredConfigSaveContent(added, {
      dashboard: dashboardWithStorePaths({ opencode_db_paths: ["/srv/a", "C:\\stores"] }, []),
      enabled: true,
    });
    expect(removed).not.toContain("opencode_db_paths");
    expect(removed).toContain('"enabled": true');
  });

  it("keeps other dashboard keys and drops an emptied block", () => {
    expect(dashboardWithStorePaths({ other: 1, opencode_db_paths: ["/a"] }, [])).toEqual({
      other: 1,
    });
    expect(dashboardWithStorePaths({ opencode_db_paths: ["/a"] }, [])).toBeUndefined();
    expect(dashboardWithStorePaths(undefined, ["/b"])).toEqual({ opencode_db_paths: ["/b"] });
    // Adding then removing a path before saving leaves no change to save.
    const untouched = '{\n  // mine\n  "enabled": true,\n}\n';
    expect(
      structuredConfigSaveContent(untouched, {
        enabled: true,
        dashboard: dashboardWithStorePaths(dashboardWithStorePaths(undefined, ["/x"]), []),
      }),
    ).toBe(untouched);
  });
});
