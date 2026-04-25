import type { Database } from "../../shared/sqlite";

/** Sources the agent can narrow ctx_search to. Facts are intentionally NOT a
 *  source — they're always rendered in <session-history> in message[0], so
 *  searching them returns content already visible in context. */
export type CtxSearchSource = "memory" | "message" | "git_commit";

export interface CtxSearchArgs {
    query: string;
    limit?: number;
    /** Restrict search to specific sources. Omit to search all. */
    sources?: CtxSearchSource[];
}

export interface CtxSearchToolDeps {
    db: Database;
    projectPath: string;
    memoryEnabled: boolean;
    embeddingEnabled: boolean;
    /** When true, ctx_search surfaces indexed git commits as a 3rd source. */
    gitCommitsEnabled?: boolean;
    /** Override message reader for testing (avoids opening OpenCode DB in CI). */
    readMessages?: (sessionId: string) => Array<{
        ordinal: number;
        id: string;
        role: string;
        parts: unknown[];
    }>;
}
