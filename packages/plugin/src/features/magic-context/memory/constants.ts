import type { MemoryCategory } from "./types";

export const PROMOTABLE_CATEGORIES: MemoryCategory[] = [
    "ARCHITECTURE_DECISIONS",
    "CONSTRAINTS",
    "CONFIG_DEFAULTS",
    "NAMING",
    "USER_PREFERENCES",
    "USER_DIRECTIVES",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

export const CATEGORY_PRIORITY: MemoryCategory[] = [
    "USER_DIRECTIVES",
    "USER_PREFERENCES",
    "NAMING",
    "CONFIG_DEFAULTS",
    "CONSTRAINTS",
    "ARCHITECTURE_DECISIONS",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

// TTL in milliseconds, null = permanent
export const CATEGORY_DEFAULT_TTL: Partial<Record<MemoryCategory, number>> = {
    WORKFLOW_RULES: 90 * 24 * 60 * 60 * 1000, // 90 days
    KNOWN_ISSUES: 30 * 24 * 60 * 60 * 1000, // 30 days
};
