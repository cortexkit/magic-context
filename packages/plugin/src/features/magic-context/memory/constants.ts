import type { MemoryCategory } from "./types";

/**
 * The v2 world taxonomy — the only categories agents may WRITE today. Exposed
 * as the ctx_memory schema enum so invalid categories fail at validation
 * instead of bouncing off a runtime check. Legacy 9-cat values remain readable
 * (CATEGORY_PRIORITY) for pre-v2 rows but are not accepted for new writes.
 */
export const V2_MEMORY_CATEGORIES = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
] as const satisfies readonly MemoryCategory[];

export const PROMOTABLE_CATEGORIES: MemoryCategory[] = [
    // v2 world taxonomy (what the historian emits today)
    ...V2_MEMORY_CATEGORIES,
    // legacy 9-cat — still promotable so pre-v2 behavior + any lingering
    // legacy-category writes keep working until the E3 recategorization
    "ARCHITECTURE_DECISIONS",
    "CONFIG_DEFAULTS",
    "USER_PREFERENCES",
    "USER_DIRECTIVES",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

export const CATEGORY_PRIORITY: MemoryCategory[] = [
    // v2 world taxonomy first (these dominate new sessions)
    ...V2_MEMORY_CATEGORIES,
    // legacy 9-cat ordering preserved below for pre-v2 rows
    "USER_DIRECTIVES",
    "USER_PREFERENCES",
    "CONFIG_DEFAULTS",
    "ARCHITECTURE_DECISIONS",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

export const MEMORY_CATEGORY_ORDER_UNKNOWN = 99;

export const MEMORY_CATEGORY_ORDER_PRIORITY: Record<MemoryCategory, number> =
    CATEGORY_PRIORITY.reduce(
        (acc, category, index) => {
            acc[category] = index;
            return acc;
        },
        {} as Record<MemoryCategory, number>,
    );

export const MEMORY_CATEGORY_ORDER_SQL = `CASE category ${CATEGORY_PRIORITY.map(
    (category, index) => `WHEN '${category}' THEN ${index}`,
).join(" ")} ELSE ${MEMORY_CATEGORY_ORDER_UNKNOWN} END`;

export function getMemoryCategoryOrder(category: string): number {
    return (
        (MEMORY_CATEGORY_ORDER_PRIORITY as Record<string, number>)[category] ??
        MEMORY_CATEGORY_ORDER_UNKNOWN
    );
}

// TTL in milliseconds, null = permanent
export const CATEGORY_DEFAULT_TTL: Partial<Record<MemoryCategory, number>> = {
    WORKFLOW_RULES: 90 * 24 * 60 * 60 * 1000, // 90 days
    KNOWN_ISSUES: 30 * 24 * 60 * 60 * 1000, // 30 days
};
