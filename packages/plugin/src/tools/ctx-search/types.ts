import type { Database } from "bun:sqlite";

export interface CtxSearchArgs {
    query: string;
    limit?: number;
}

export interface CtxSearchToolDeps {
    db: Database;
    projectPath: string;
    memoryEnabled: boolean;
    embeddingEnabled: boolean;
    /** Override message reader for testing (avoids opening OpenCode DB in CI). */
    readMessages?: (sessionId: string) => Array<{
        ordinal: number;
        id: string;
        role: string;
        parts: unknown[];
    }>;
}
