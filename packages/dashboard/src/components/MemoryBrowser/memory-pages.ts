import type { Memory } from "../../lib/types";

/** Rows requested per category page. The header count is never this number. */
export const MEMORY_PAGE_SIZE = 200;

/**
 * Default status chip. Category totals from the stats query omit archived rows
 * unless a status is chosen, and the list pages that same set so the header
 * count is the number of rows that category can reach. "All status" is an
 * explicit choice that includes archived rows.
 */
export const DEFAULT_STATUS_SELECTION = "live";

export interface StatusScope {
  /** Exact status, when the chip is Active, Permanent, or Archived. */
  status?: string;
  /** Unset status and not "All status": omit archived rows, matching stats. */
  excludeArchived: boolean;
  /** "All status": category totals include every status. */
  includeArchived: boolean;
}

export function statusScope(selection: string): StatusScope {
  if (selection === "any") {
    return { excludeArchived: false, includeArchived: true };
  }
  if (selection === "" || selection === DEFAULT_STATUS_SELECTION) {
    return { excludeArchived: true, includeArchived: false };
  }
  return { status: selection, excludeArchived: false, includeArchived: false };
}

export interface MemoryPageQuery {
  project?: string;
  workspaceId?: number;
  status?: string;
  category?: string;
  search?: string;
  excludeArchived: boolean;
  limit: number;
  offset: number;
}

export function memoryPageRequest(offset: number): { limit: number; offset: number } {
  return { limit: MEMORY_PAGE_SIZE, offset };
}

/** The request for one category page. Filters travel with the offset. */
export function memoryListQuery(input: {
  project?: string;
  workspaceId?: number;
  statusSelection: string;
  category?: string;
  search?: string;
  offset: number;
}): MemoryPageQuery {
  const scope = statusScope(input.statusSelection);
  const page = memoryPageRequest(input.offset);
  return {
    project: input.project,
    workspaceId: input.workspaceId,
    status: scope.status,
    category: input.category,
    search: input.search || undefined,
    excludeArchived: scope.excludeArchived,
    limit: page.limit,
    offset: page.offset,
  };
}

export interface MemoryStatsQuery {
  project?: string;
  workspaceId?: number;
  status?: string;
  search?: string;
  includeArchived: boolean;
}

/** Stats over the same project, status, and search as the list. Not paged. */
export function memoryStatsQuery(input: {
  project?: string;
  workspaceId?: number;
  statusSelection: string;
  search?: string;
}): MemoryStatsQuery {
  const scope = statusScope(input.statusSelection);
  return {
    project: input.project,
    workspaceId: input.workspaceId,
    status: scope.status,
    search: input.search || undefined,
    includeArchived: scope.includeArchived,
  };
}

export interface CategoryTotal {
  category: string;
  count: number;
}

/** Headers for the current category chip, in stable alphabetical order. */
export function visibleCategoryCounts(
  counts: readonly CategoryTotal[],
  categoryFilter: string,
): CategoryTotal[] {
  const rows = categoryFilter ? counts.filter((row) => row.category === categoryFilter) : counts;
  return rows.filter((row) => row.count > 0).sort((a, b) => a.category.localeCompare(b.category));
}

export function categoryCountText(count: number): string {
  return `(${count.toLocaleString("en-US")})`;
}

/**
 * Shown only while a loaded page is shorter than the category total, so a
 * page size is never mistaken for the size of the category.
 */
export function showingLabel(loaded: number, total: number): string | null {
  if (loaded >= total) return null;
  return `showing ${loaded.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
}

export function pageIsComplete(pageLength: number, pageSize: number = MEMORY_PAGE_SIZE): boolean {
  return pageLength < pageSize;
}

/** Append a page. An empty or short page means the query has no further rows. */
export function appendMemoryPage<T extends Pick<Memory, "id">>(
  loaded: readonly T[],
  page: readonly T[],
): { rows: T[]; complete: boolean } {
  return {
    rows: [...loaded, ...page],
    complete: pageIsComplete(page.length),
  };
}
