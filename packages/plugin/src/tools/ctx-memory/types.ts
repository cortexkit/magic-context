import type { MemorySourceType } from "../../features/magic-context/memory";
import type { Database } from "../../shared/sqlite";
import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

// Actions a PRIMARY (non-dreamer) agent may run. Primary agents see active
// memories — with their ids — in the injected <project-memory> block, so they
// can target a specific memory to archive/update/merge in-session without
// waiting for the dreamer. `archive` is the single soft-remove action (sets
// status='archived'); the former `delete` action was an exact alias of it and
// was removed. `list` (bulk enumeration) stays dreamer-only. `get` is the
// id-shaped read that the user-facing <project-memory> ids imply but no
// dreamer-only-free action covered — the agent is given a memory id
// (dashboard, guidance, this very block) and there is no other way to look
// it up. Memory verification (file mapping) and classification
// (importance/scope/shareable) are no longer tool actions — the verify and
// classify dreamer tasks apply them host-side from a manifest, so the agent
// never calls a tool for them.
export const CTX_MEMORY_ACTIONS = ["write", "update", "archive", "merge", "get"] as const;

export const CTX_MEMORY_DREAMER_ACTIONS = [...CTX_MEMORY_ACTIONS, "list"] as const;

export type CtxMemoryAction = (typeof CTX_MEMORY_DREAMER_ACTIONS)[number];

export interface CtxMemoryArgs extends ImitatedReducedArgs {
    action?: CtxMemoryAction;
    content?: string;
    category?: string;
    /**
     * Target memory id(s). One unified parameter for all id-taking actions:
     * update requires exactly one, archive one or more (batch), merge two or
     * more, get one or more (≤20, batch read). The former scalar `id` param
     * was folded in here.
     */
    ids?: number[];
    limit?: number;
    reason?: string;
    /** ID of the memory that replaces this one after duplicate memories are consolidated. */
    superseded_by?: number;
}

export interface CtxMemoryToolDeps {
    db: Database;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void>;
    /**
     * Read the session's recorded identity, awaiting its first decision if necessary.
     *
     * Why a function instead of a baked string: OpenCode's top-level
     * `ctx.directory` is the directory the OpenCode process was started
     * in (often `$HOME` when launched via `opencode -s <id>` from outside
     * the project). The session's actual working directory is exposed
     * per-call via `toolContext.directory`. Resolving here ensures
     * `ctx_memory` operates on the session's project, not the launch
     * directory's project.
     */
    resolveProjectPath: (
        directory: string,
        sessionId: string,
    ) => string | undefined | Promise<string | undefined>;
    memoryEnabled?: boolean;
    embeddingEnabled?: boolean;
    allowedActions?: CtxMemoryAction[];
    sourceType?: MemorySourceType;
    /**
     * Where an agent's save happened, for the historian's agent-memory scoring; null
     * (or absent) when this lane does not score agent saves, so no classification
     * item is enqueued.
     */
    agentSaveClassificationAnchor?: (location: {
        sessionId: string;
        messageId?: string;
        callId?: string;
    }) => { toolCallPartId: string; saveOrdinal: number } | null;
}
