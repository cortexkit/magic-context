import type { Database } from "bun:sqlite";

export interface CtxMemoryArgs {
    action: "write" | "delete" | "search";
    content?: string;
    category?: string;
    id?: number;
    query?: string;
    limit?: number;
}

export interface CtxMemoryToolDeps {
    db: Database;
    projectPath: string;
    memoryEnabled: boolean;
    embeddingEnabled: boolean;
}

export interface CtxMemorySearchResult {
    id: number;
    category: string;
    content: string;
    score: number;
    source: string;
}
