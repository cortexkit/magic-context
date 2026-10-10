/**
 * Row model for the Protected Tools editor. The config stores a plain object
 * mapping tool names to keep counts (for example `{ "read": 2 }`); the editor
 * shows one row per entry plus read-only rows for the built-in defaults.
 */

/**
 * Built-in keep counts the runtime merges user entries over. Mirrors
 * DEFAULT_PROTECTED_TOOLS in packages/plugin/src/shared/protected-tools-policy.ts
 * and default_protected_tools() in crates/mc-module/src/selection.rs; a parity
 * test reads both so the dashboard cannot drift from what the runtime does.
 */
export const DEFAULT_PROTECTED_TOOLS: Readonly<Record<string, number>> = {
  todowrite: 1,
  ctx_reduce: 3,
};

/** One editable row. The count stays text so a half-typed value can be shown and flagged. */
export interface ProtectedToolRow {
  name: string;
  count: string;
}

export interface ProtectedToolRowError {
  name?: string;
  count?: string;
}

/** Same normalization the runtime applies: case-insensitive, leading `mcp_` ignored. */
export function normalizeProtectedToolName(name: string): string {
  return name.trim().toLowerCase().replace(/^mcp_/, "");
}

export function protectedToolRows(value: unknown): ProtectedToolRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([name, count]) => ({
    name,
    count: String(count),
  }));
}

/** Per-row problems, index-aligned with `rows`; `undefined` marks a valid row. */
export function protectedToolRowErrors(
  rows: ProtectedToolRow[],
): (ProtectedToolRowError | undefined)[] {
  const firstRow = new Map<string, number>();
  return rows.map((row, index) => {
    const error: ProtectedToolRowError = {};
    const normalized = normalizeProtectedToolName(row.name);
    if (!normalized) {
      error.name = "Enter a tool name.";
    } else if (firstRow.has(normalized)) {
      error.name = `Same tool as row ${(firstRow.get(normalized) ?? 0) + 1}. Names ignore capitals and a leading mcp_.`;
    } else {
      firstRow.set(normalized, index);
    }
    if (!/^\d+$/.test(row.count.trim())) error.count = "Enter a whole number, 0 or more.";
    return error.name || error.count ? error : undefined;
  });
}

/**
 * The config value for valid rows: user entries only, so the built-in defaults
 * are written only when a row overrides them, and 0 is kept because it switches
 * a default off. Returns `undefined` for no rows (the key is removed) and `null`
 * when any row is invalid, meaning the change must not be saved yet.
 */
export function protectedToolsConfig(
  rows: ProtectedToolRow[],
): Record<string, number> | undefined | null {
  if (protectedToolRowErrors(rows).some(Boolean)) return null;
  if (rows.length === 0) return undefined;
  return Object.fromEntries(rows.map((row) => [row.name.trim(), Number(row.count.trim())]));
}

/** The user row, if any, that replaces a built-in default. */
export function overridingRow(
  rows: ProtectedToolRow[],
  defaultName: string,
): ProtectedToolRow | undefined {
  return rows.find((row) => normalizeProtectedToolName(row.name) === defaultName);
}
