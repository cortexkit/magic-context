import type { Database } from "../../shared/sqlite";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

/** Sources the agent can narrow ctx_search to. Facts are intentionally NOT a
 *  source — they're always rendered in <session-history> in message[0], so
 *  searching them returns content already visible in context. */
export type CtxSearchSource = "memory" | "message" | "git_commit" | "primer" | "note";

export interface CtxSearchArgs extends ImitatedReducedArgs {
    query?: string;
    limit?: number;
    from?: string;
    to?: string;
    /** Restrict search to specific sources. Omit or pass [] to search all. */
    sources?: CtxSearchSource[];
}

export interface CtxSearchToolDeps {
    db: Database;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    /**
     * Resolve the project identity for the session's directory at call time.
     * See CtxMemoryToolDeps.resolveProjectPath for why this is a function:
     * OpenCode's top-level `ctx.directory` reflects the launch dir, not the
     * session's working directory.
     */
    resolveProjectPath: (
        directory: string,
        sessionId: string,
    ) => string | undefined | Promise<string | undefined>;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    /** When true, ctx_search surfaces indexed git commits as a 3rd source. */
    gitCommitsEnabled?: boolean;
    rerankConnectionFile?: string;
    rerankConfig?: import("../../config/schema/magic-context").RerankConfig;
    /** Override message reader for testing (avoids opening OpenCode DB in CI). */
    readMessages?: (sessionId: string) => Array<{
        ordinal: number;
        id: string;
        role: string;
        parts: unknown[];
    }>;
}
