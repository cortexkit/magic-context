import type { MemorySourceType } from "../../features/magic-context/memory";
import type { Database } from "../../shared/sqlite";

export const CTX_MEMORY_ACTIONS = ["write", "delete"] as const;

export const CTX_MEMORY_DREAMER_ACTIONS = [
    ...CTX_MEMORY_ACTIONS,
    "list",
    "update",
    "merge",
    "archive",
] as const;

export type CtxMemoryAction = (typeof CTX_MEMORY_DREAMER_ACTIONS)[number];

export interface CtxMemoryArgs {
    action: CtxMemoryAction;
    content?: string;
    category?: string;
    id?: number;
    ids?: number[];
    limit?: number;
    reason?: string;
}

export interface CtxMemoryToolDeps {
    db: Database;
    projectPath: string;
    memoryEnabled: boolean;
    embeddingEnabled: boolean;
    allowedActions?: CtxMemoryAction[];
    sourceType?: MemorySourceType;
}
