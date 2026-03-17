import type { Database } from "bun:sqlite";

export interface CtxRecallArgs {
    query: string;
    category?: string;
    limit?: number;
}

export interface CtxRecallToolDeps {
    db: Database;
    projectPath: string;
    memoryEnabled: boolean;
    embeddingEnabled: boolean;
}

export interface CtxRecallResult {
    id: number;
    category: string;
    content: string;
    score: number;
    source: string;
}
