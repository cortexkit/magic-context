export type MemoryCategory =
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
export type VerificationStatus = "unverified" | "verified" | "stale" | "flagged";
export type MemorySourceType = "historian" | "agent" | "dreamer" | "user";

export interface Memory {
    id: number;
    projectPath: string;
    category: MemoryCategory;
    content: string;
    normalizedHash: string;
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
    sourceSessionId?: string;
    sourceType?: MemorySourceType;
    expiresAt?: number | null;
    metadataJson?: string | null;
}
