import { describe, expect, test } from "bun:test";

import {
  appendMemoryPage,
  categoryCountText,
  DEFAULT_STATUS_SELECTION,
  MEMORY_PAGE_SIZE,
  memoryListQuery,
  memoryStatsQuery,
  showingLabel,
  visibleCategoryCounts,
} from "./memory-pages";

interface Row {
  id: number;
  category: string;
}

function projectWithMoreThanOnePage(): Row[] {
  const architecture = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1,
    category: "ARCHITECTURE",
  }));
  const constraints = Array.from({ length: 3 }, (_, index) => ({
    id: 1000 + index,
    category: "CONSTRAINTS",
  }));
  return [...architecture, ...constraints];
}

function pageOf(rows: readonly Row[], offset: number): Row[] {
  return rows.slice(offset, offset + MEMORY_PAGE_SIZE);
}

describe("memory category pages", () => {
  test("a project with more than 200 memories shows full per-category counts and can reach a memory past the first page", () => {
    const rows = projectWithMoreThanOnePage();
    const counts = [
      { category: "ARCHITECTURE", count: 250 },
      { category: "CONSTRAINTS", count: 3 },
    ];

    const headers = visibleCategoryCounts(counts, "");
    expect(headers).toEqual([
      { category: "ARCHITECTURE", count: 250 },
      { category: "CONSTRAINTS", count: 3 },
    ]);
    expect(categoryCountText(headers[0].count)).toBe("(250)");
    expect(headers[0].count).not.toBe(MEMORY_PAGE_SIZE);

    const architecture = rows.filter((row) => row.category === "ARCHITECTURE");
    const firstQuery = memoryListQuery({
      project: "git:prefrontal",
      statusSelection: DEFAULT_STATUS_SELECTION,
      category: "ARCHITECTURE",
      offset: 0,
    });
    expect(firstQuery.limit).toBe(MEMORY_PAGE_SIZE);
    expect(firstQuery.offset).toBe(0);
    const firstPage = pageOf(architecture, firstQuery.offset);
    expect(firstPage).toHaveLength(MEMORY_PAGE_SIZE);
    expect(firstPage.some((row) => row.id === 250)).toBe(false);
    expect(showingLabel(firstPage.length, 250)).toBe("showing 200 of 250");

    const loadedFirst = appendMemoryPage([], firstPage);
    expect(loadedFirst.complete).toBe(false);
    const nextQuery = memoryListQuery({
      project: "git:prefrontal",
      statusSelection: DEFAULT_STATUS_SELECTION,
      category: "ARCHITECTURE",
      search: "wal",
      offset: loadedFirst.rows.length,
    });
    expect(nextQuery.offset).toBe(MEMORY_PAGE_SIZE);
    expect(nextQuery.search).toBe("wal");
    expect(nextQuery.category).toBe("ARCHITECTURE");
    const secondPage = pageOf(architecture, nextQuery.offset);
    const loaded = appendMemoryPage(loadedFirst.rows, secondPage);
    expect(loaded.rows.some((row) => row.id === 250)).toBe(true);
    expect(loaded.complete).toBe(true);
    expect(showingLabel(loaded.rows.length, 250)).toBe(null);
  });

  test("search and status stay on the stats query and the paged list", () => {
    expect(
      memoryStatsQuery({
        project: "git:prefrontal",
        statusSelection: "active",
        search: "wal",
      }),
    ).toEqual({
      project: "git:prefrontal",
      workspaceId: undefined,
      status: "active",
      search: "wal",
      includeArchived: false,
    });

    const page = memoryListQuery({
      project: "git:prefrontal",
      statusSelection: "archived",
      category: "NAMING",
      search: "token",
      offset: 400,
    });
    expect(page).toMatchObject({
      status: "archived",
      category: "NAMING",
      search: "token",
      excludeArchived: false,
      limit: MEMORY_PAGE_SIZE,
      offset: 400,
    });
  });

  test("the default view omits archived rows, and All status includes them", () => {
    const live = memoryListQuery({
      statusSelection: DEFAULT_STATUS_SELECTION,
      category: "ARCHITECTURE",
      offset: 0,
    });
    expect(live.excludeArchived).toBe(true);
    expect(live.status).toBeUndefined();
    expect(memoryStatsQuery({ statusSelection: DEFAULT_STATUS_SELECTION }).includeArchived).toBe(
      false,
    );

    const all = memoryListQuery({
      statusSelection: "any",
      category: "ARCHITECTURE",
      offset: 0,
    });
    expect(all.excludeArchived).toBe(false);
    expect(all.status).toBeUndefined();
    expect(memoryStatsQuery({ statusSelection: "any" }).includeArchived).toBe(true);
  });

  test("a category chip hides the other headers without changing their totals", () => {
    const counts = [
      { category: "NAMING", count: 146 },
      { category: "ARCHITECTURE", count: 1818 },
    ];
    expect(visibleCategoryCounts(counts, "ARCHITECTURE")).toEqual([
      { category: "ARCHITECTURE", count: 1818 },
    ]);
    expect(visibleCategoryCounts(counts, "MISSING")).toEqual([]);
  });
});
