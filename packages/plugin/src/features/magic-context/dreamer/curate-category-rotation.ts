import type { Database } from "../../../shared/sqlite";
import { V2_MEMORY_CATEGORIES } from "../memory/constants";
import { getTaskScheduleState, writeTaskStateJson } from "./storage-task-schedule";

export const CURATE_MEMORY_CATEGORIES = V2_MEMORY_CATEGORIES;

export type CurateMemoryCategory = (typeof CURATE_MEMORY_CATEGORIES)[number];

const LEGACY_CURATE_CATEGORY_BUCKETS: Readonly<Record<string, CurateMemoryCategory>> = {
    ARCHITECTURE_DECISIONS: "ARCHITECTURE",
    CONFIG_DEFAULTS: "CONFIG_VALUES",
    ENVIRONMENT: "CONFIG_VALUES",
    KNOWN_ISSUES: "CONSTRAINTS",
    USER_DIRECTIVES: "PROJECT_RULES",
    USER_PREFERENCES: "PROJECT_RULES",
    WORKFLOW_RULES: "PROJECT_RULES",
};

export function curateCategoryForMemoryCategory(category: string): CurateMemoryCategory | null {
    return isCurateMemoryCategory(category)
        ? category
        : (LEGACY_CURATE_CATEGORY_BUCKETS[category] ?? null);
}

interface CurateRotationState {
    cursor: number;
    activeCategory?: CurateMemoryCategory;
}

interface DreamTaskJsonState {
    curate?: CurateRotationState;
    [key: string]: unknown;
}

export interface CurateCategoryScope<T extends { category: string }> {
    category: CurateMemoryCategory;
    memories: T[];
}

function isCurateMemoryCategory(value: unknown): value is CurateMemoryCategory {
    return CURATE_MEMORY_CATEGORIES.includes(value as CurateMemoryCategory);
}

function parseTaskState(raw: string | null | undefined): DreamTaskJsonState {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as DreamTaskJsonState)
            : {};
    } catch {
        return {};
    }
}

function normalizedCursor(value: unknown): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value % CURATE_MEMORY_CATEGORIES.length
        : 0;
}

function readState(db: Database, projectIdentity: string): DreamTaskJsonState {
    return parseTaskState(getTaskScheduleState(db, projectIdentity, "curate")?.taskStateJson);
}

function categoryStartIndex(state: DreamTaskJsonState, populated: Set<string>): number {
    const active = state.curate?.activeCategory;
    if (isCurateMemoryCategory(active)) {
        const activeIndex = CURATE_MEMORY_CATEGORIES.indexOf(active);
        return populated.has(active)
            ? activeIndex
            : (activeIndex + 1) % CURATE_MEMORY_CATEGORIES.length;
    }
    return normalizedCursor(state.curate?.cursor);
}

export function peekCurateCategoryScope<T extends { category: string }>(
    db: Database,
    projectIdentity: string,
    memories: readonly T[],
): CurateCategoryScope<T> | null {
    const populated = new Set(
        memories
            .map((memory) => curateCategoryForMemoryCategory(memory.category))
            .filter((category): category is CurateMemoryCategory => category !== null),
    );
    const start = categoryStartIndex(readState(db, projectIdentity), populated);
    for (let offset = 0; offset < CURATE_MEMORY_CATEGORIES.length; offset += 1) {
        const category =
            CURATE_MEMORY_CATEGORIES[(start + offset) % CURATE_MEMORY_CATEGORIES.length];
        const scoped = memories.filter(
            (memory) => curateCategoryForMemoryCategory(memory.category) === category,
        );
        if (scoped.length > 0) return { category, memories: scoped };
    }
    return null;
}

export function beginCurateCategoryRun<T extends { category: string }>(
    db: Database,
    projectIdentity: string,
    memories: readonly T[],
): CurateCategoryScope<T> | null {
    const scope = peekCurateCategoryScope(db, projectIdentity, memories);
    if (!scope) return null;
    const state = readState(db, projectIdentity);
    writeTaskStateJson(
        db,
        projectIdentity,
        "curate",
        JSON.stringify({
            ...state,
            curate: {
                cursor: normalizedCursor(state.curate?.cursor),
                activeCategory: scope.category,
            },
        }),
    );
    return scope;
}

export function curateTaskStateAfterSuccess(
    db: Database,
    projectIdentity: string,
    category: CurateMemoryCategory,
): string {
    const state = readState(db, projectIdentity);
    return JSON.stringify({
        ...state,
        curate: {
            cursor:
                (CURATE_MEMORY_CATEGORIES.indexOf(category) + 1) % CURATE_MEMORY_CATEGORIES.length,
        },
    });
}

export function getActiveCurateCategory(
    db: Database,
    projectIdentity: string,
): CurateMemoryCategory | null {
    const active = readState(db, projectIdentity).curate?.activeCategory;
    return isCurateMemoryCategory(active) ? active : null;
}

export function getCurateCategoryScopeRefusal(args: {
    scope: CurateMemoryCategory;
    action: string;
    requestedCategory?: string;
    ids?: readonly number[];
    categoryForId: (id: number) => string | null;
}): string | null {
    if (args.requestedCategory && args.requestedCategory !== args.scope) {
        return `Error: Curate scope is ${args.scope}; ${args.action} cannot target category ${args.requestedCategory}.`;
    }
    for (const id of args.ids ?? []) {
        const category = args.categoryForId(id);
        if (category && category !== args.scope) {
            return `Error: Curate scope is ${args.scope}; memory ID ${id} is outside the scoped category.`;
        }
    }
    return null;
}
