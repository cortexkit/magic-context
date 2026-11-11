import type { OpenCodeStoreOrigin, OpenCodeStoreRow } from "../../lib/types";

/** How the "Session stores" section names where a store came from. */
export const STORE_ORIGIN_LABELS: Record<OpenCodeStoreOrigin, string> = {
  default: "Default",
  runner: "CortexKit runner",
  configured: "Configured",
};

/**
 * True for an absolute path on POSIX (`/srv/x`) or Windows (`C:\x`, `C:/x`,
 * `\\server\share`). Mirrors the config schema's check for
 * `dashboard.opencode_db_paths`, so the form refuses what a save would.
 */
export function isAbsoluteStorePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Why `value` cannot be added as a configured store, or null when it can. */
export function storePathError(value: string, existing: readonly string[]): string | null {
  const path = value.trim();
  if (!path) return "Enter a path.";
  if (/\{(env|file):/.test(path)) {
    return "{env:} and {file:} tokens are not expanded here; write the absolute path.";
  }
  if (!isAbsoluteStorePath(path)) {
    return "Write an absolute path to an opencode.db file or to the folder that holds it.";
  }
  if (existing.some((entry) => entry.trim() === path)) return "This path is already listed.";
  return null;
}

export interface SessionStoreView {
  path: string;
  origin: OpenCodeStoreOrigin;
  status: string;
  tone: "ok" | "problem" | "pending";
  /** Position in `dashboard.opencode_db_paths`; only configured rows have one. */
  configuredIndex?: number;
}

function statusOf(row: OpenCodeStoreRow): Pick<SessionStoreView, "status" | "tone"> {
  if (row.read) return { status: "Found", tone: "ok" };
  if (!row.found) return { status: row.note || "Not found.", tone: "problem" };
  return { status: row.note || "Found, not read.", tone: "problem" };
}

/**
 * The rows the section shows: the stores the dashboard found by itself (read
 * only), then one row per configured path in the form's current value. A
 * configured path that has not been saved yet has no backend status.
 */
export function sessionStoreViews(
  rows: readonly OpenCodeStoreRow[] | undefined,
  configured: readonly string[],
): SessionStoreView[] {
  const found = (rows ?? [])
    .filter((row) => row.origin !== "configured")
    .map((row) => ({ path: row.path, origin: row.origin, ...statusOf(row) }));
  const saved = (rows ?? []).filter((row) => row.origin === "configured");
  const listed = configured.map((value, configuredIndex): SessionStoreView => {
    const row = saved.find((candidate) => candidate.configured_value === value);
    return row
      ? { path: row.path, origin: "configured", configuredIndex, ...statusOf(row) }
      : {
          path: value,
          origin: "configured",
          configuredIndex,
          status: "Not saved yet.",
          tone: "pending",
        };
  });
  return [...found, ...listed];
}

/** The configured paths in a parsed config, ignoring entries that are not strings. */
export function configuredStorePaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The `dashboard` block after the configured paths change to `entries`. Other
 * keys in the block are kept; when nothing is left the block is removed, so
 * adding and then removing a path leaves the file as it was.
 */
export function dashboardWithStorePaths(
  current: unknown,
  entries: readonly string[],
): Record<string, unknown> | undefined {
  const rest: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  delete rest.opencode_db_paths;
  if (entries.length > 0) return { ...rest, opencode_db_paths: [...entries] };
  return Object.keys(rest).length > 0 ? rest : undefined;
}
