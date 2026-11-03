export type MemoryCategory =
    // v2 world taxonomy (the 5 categories the historian emits). CONSTRAINTS and
    // NAMING are shared with the legacy set; PROJECT_RULES/ARCHITECTURE/
    // CONFIG_VALUES are new in v2.
    | "PROJECT_RULES"
    | "ARCHITECTURE"
    | "CONFIG_VALUES"
    // Legacy 9-cat taxonomy — retained as an accept-both bridge so the existing
    // memory store (pre-v2 rows) keeps full ordering/TTL/rendering. The dreamer's
    // curate task maps such a row into the 5-cat set when it next touches it; the
    // historian no longer emits these.
    | "ARCHITECTURE_DECISIONS"
    | "CONSTRAINTS"
    | "CONFIG_DEFAULTS"
    | "NAMING"
    | "USER_PREFERENCES"
    | "USER_DIRECTIVES"
    | "ENVIRONMENT"
    | "WORKFLOW_RULES"
    | "KNOWN_ISSUES";

export type MemoryStatus = "active" | "permanent" | "archived";
export type MemoryScope = "project" | "ecosystem" | "universe";
export type VerificationStatus = "unverified" | "verified" | "stale" | "flagged";
/**
 * Provenance of a memory row.
 *
 * `"user"` is intentionally RESERVED, not dead: it exists for FUTURE manual
 * memory entries authored through the dashboard (user-typed rows), which were
 * designed but never implemented. It must NEVER be written by the agent
 * (historian/dreamer/tool) write paths — origin provenance matters to the
 * agent, historian dedup, and dreamer curation, so agent-originated memories
 * must never carry `"user"`. `insertMemory` enforces this at the write
 * boundary.
 *
 * Note: "was this addition user-ignited" is a SEPARATE future concern from
 * `sourceType`. A prompt-driven agent write made at the user's request is
 * still `sourceType: "agent"` (or `"tool"`); user-ignition would be carried
 * by a distinct field if it is ever needed.
 */
export type MemorySourceType = "historian" | "agent" | "dreamer" | "user";

export interface Memory {
    id: number;
    projectPath: string;
    category: MemoryCategory;
    content: string;
    normalizedHash: string;
    importance: number;
    scope: MemoryScope;
    /** SQLite INTEGER boolean: 1 = shareable, 0 = private. */
    shareable: number;
    /** SQLite INTEGER boolean; NULL means the classifier has not assessed safety. */
    safetyCritical: number | null;
    sourceSessionId: string | null;
    sourceType: MemorySourceType;
    seenCount: number;
    retrievalCount: number;
    firstSeenAt: number;
    createdAt: number;
    updatedAt: number;
    lastSeenAt: number;
    lastRetrievedAt: number | null;
    status: MemoryStatus;
    expiresAt: number | null;
    verificationStatus: VerificationStatus;
    verifiedAt: number | null;
    supersededByMemoryId: number | null;
    mergedFrom: string | null; // JSON array
    metadataJson: string | null;
}

export interface MemoryInput {
    projectPath: string;
    category: MemoryCategory;
    content: string;
    importance?: number | null;
    sourceSessionId?: string;
    sourceType?: MemorySourceType;
    expiresAt?: number | null;
    metadataJson?: string | null;
}
