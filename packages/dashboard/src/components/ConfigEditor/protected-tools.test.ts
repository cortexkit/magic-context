import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_PROTECTED_TOOLS as PLUGIN_DEFAULTS } from "../../../../plugin/src/shared/protected-tools-policy";
import {
  DEFAULT_PROTECTED_TOOLS,
  overridingRow,
  protectedToolRowErrors,
  protectedToolRows,
  protectedToolsConfig,
} from "./protected-tools";

describe("protected tools editor", () => {
  it("round-trips config through rows without writing unlisted defaults and keeps 0", () => {
    const config = { read: 2, bash: 1, ctx_reduce: 0 };
    const rows = protectedToolRows(config);
    expect(rows).toEqual([
      { name: "read", count: "2" },
      { name: "bash", count: "1" },
      { name: "ctx_reduce", count: "0" },
    ]);
    const written = protectedToolsConfig(rows);
    expect(written).toEqual(config);
    // todowrite is a default with no row, so it must stay out of the file.
    expect(written).not.toHaveProperty("todowrite");
    expect(protectedToolRows(written)).toEqual(rows);
  });

  it("writes a default only when a row overrides it", () => {
    expect(protectedToolsConfig([{ name: "read", count: "2" }])).toEqual({ read: 2 });
    const rows = [{ name: " todowrite ", count: "4" }];
    expect(protectedToolsConfig(rows)).toEqual({ todowrite: 4 });
    expect(overridingRow(rows, "todowrite")).toEqual(rows[0]);
    expect(overridingRow(rows, "ctx_reduce")).toBeUndefined();
    expect(overridingRow([{ name: "MCP_ctx_reduce", count: "0" }], "ctx_reduce")).toBeDefined();
  });

  it("removes the key when no rows remain and reads non-objects as no rows", () => {
    expect(protectedToolsConfig([])).toBeUndefined();
    expect(protectedToolRows(undefined)).toEqual([]);
    expect(protectedToolRows([1, 2])).toEqual([]);
    expect(protectedToolRows({})).toEqual([]);
  });

  it("flags empty names, non-whole counts and duplicate names, and refuses to write them", () => {
    const rows = [
      { name: "read", count: "2" },
      { name: "", count: "1" },
      { name: "bash", count: "1.5" },
      { name: "bash", count: "-1" },
      { name: "MCP_Read", count: "" },
    ];
    const errors = protectedToolRowErrors(rows);
    expect(errors[0]).toBeUndefined();
    expect(errors[1]).toEqual({ name: "Enter a tool name." });
    expect(errors[2]).toEqual({ count: "Enter a whole number, 0 or more." });
    expect(errors[3]?.name).toStartWith("Same tool as row 3.");
    expect(errors[3]?.count).toBe("Enter a whole number, 0 or more.");
    expect(errors[4]?.name).toStartWith("Same tool as row 1.");
    expect(protectedToolsConfig(rows)).toBeNull();
    expect(protectedToolsConfig([{ name: "  ", count: "1" }])).toBeNull();
  });

  it("built-in defaults match the plugin and the Rust selection module", () => {
    expect(DEFAULT_PROTECTED_TOOLS).toEqual({ todowrite: 1, ctx_reduce: 3 });
    expect(DEFAULT_PROTECTED_TOOLS).toEqual({ ...PLUGIN_DEFAULTS });
    const rust = readFileSync(
      resolve(import.meta.dir, "../../../../../crates/mc-module/src/selection.rs"),
      "utf8",
    );
    const body = /fn default_protected_tools\(\)[^{]*\{([^}]*)\}/.exec(rust)?.[1] ?? "";
    const entries = Object.fromEntries(
      [...body.matchAll(/\("([^"]+)"\.to_string\(\),\s*(\d+)\)/g)].map((m) => [m[1], Number(m[2])]),
    );
    expect(entries).toEqual({ ...DEFAULT_PROTECTED_TOOLS });
  });
});
