import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import {
    embedSessionCompartmentChunks,
    getEmbeddingCoverageStatus,
} from "../../features/magic-context/project-embedding-registry";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import type { Database } from "../../shared/sqlite";
import type { RecompProgress } from "./compartment-runner-types";
import { embedPauseBySession, embedRunStateBySession } from "./embed-session-state";
import { formatEmbedFailureSummary } from "./format-embed-failure";
import type { LiveSessionState } from "./live-session-state";
import { setRecompStarting, setRecompTerminal } from "./recomp-orchestrator";

/**
 * The `/ctx-embed start` / `/ctx-embed pause` drain, independent of the harness
 * lane that asks for it. The OpenCode 1 hook reaches it through its command
 * handler; the RPC surface reaches it for hosts whose only command seam is the
 * TUI (OpenCode 2), where nothing else in the process runs this backfill.
 *
 * Both callers share the process-level pause/abort maps in embed-session-state,
 * so a pause issued on one surface stops a run started on the other.
 */
export interface EmbedHistoryDeps {
    db: Database;
    /** Resolve the session's own directory (falls back to the plugin directory). */
    resolveDirectory: (sessionId: string) => string;
    allowHomeProject?: boolean;
    /** Progress entries the sidebar and /ctx-status read. */
    recompProgressBySession: Map<string, RecompProgress>;
    /** Side channel for the "dubious project ownership" notice, when the caller has one. */
    onDirectoryResolved?: (sessionId: string, directory: string) => void;
}

/** Backfill this session's missing compartment embeddings. Returns the text to show. */
export async function runEmbedHistoryDrain(
    deps: EmbedHistoryDeps,
    sessionId: string,
    options?: { signal?: AbortSignal; silent?: boolean },
): Promise<string> {
    // History embedding does not depend on `memory.enabled`; with no provider
    // the drain itself reports that there is nothing to embed.
    const directory = deps.resolveDirectory(sessionId);
    // Idempotent start: if a drain is already running for this session, don't
    // abort it and re-acquire — that races the just-released lease and returns
    // "busy", killing the active run for nothing. Just report it's running.
    const active = embedRunStateBySession.get(sessionId);
    if (active && !active.signal.aborted && !options?.signal) {
        return "Embedding is already running for this session.";
    }
    await ensureProjectRegisteredFromOpenCodeDirectory(directory, deps.db);
    const sessionProjectIdentity = resolveProjectIdentityForSession(
        directory,
        deps.allowHomeProject,
    );
    if (!sessionProjectIdentity) return "No project identity is bound for the home directory.";
    deps.onDirectoryResolved?.(sessionId, directory);
    embedPauseBySession.delete(sessionId);
    const prior = embedRunStateBySession.get(sessionId);
    if (prior) prior.abort();
    const controller = new AbortController();
    embedRunStateBySession.set(sessionId, controller);
    const signal = options?.signal ?? controller.signal;
    const progressState = {
        recompProgressBySession: deps.recompProgressBySession,
    } as LiveSessionState;
    if (!options?.silent) {
        setRecompStarting(progressState, sessionId, "Embedding history…", "embed");
    }
    let runFailed = 0;
    let outcome: Awaited<ReturnType<typeof embedSessionCompartmentChunks>>;
    try {
        outcome = await embedSessionCompartmentChunks(deps.db, sessionProjectIdentity, sessionId, {
            signal,
            onProgress: ({ embedded, total }) => {
                const cur = deps.recompProgressBySession.get(sessionId);
                if (cur?.phase !== "recomp") return;
                deps.recompProgressBySession.set(sessionId, {
                    ...cur,
                    processedMessages: embedded,
                    totalMessages: total,
                    updatedAt: Date.now(),
                });
            },
        });
    } finally {
        // Always release the per-session controller, even if the drain threw
        // (a release-time SQLite error, etc.) — otherwise a stale controller
        // would make every later start return "already running".
        if (embedRunStateBySession.get(sessionId) === controller) {
            embedRunStateBySession.delete(sessionId);
        }
    }
    if ("failed" in outcome) runFailed = outcome.failed;
    const terminal = (phase: "done" | "skipped", message: string): string => {
        if (!options?.silent) {
            setRecompTerminal(progressState, sessionId, phase, message);
        }
        return message;
    };
    switch (outcome.status) {
        case "nothing":
            return terminal("done", "All of this session's history is already embedded.");
        case "disabled":
            return terminal(
                "skipped",
                "No embedding provider is configured, so there is nothing to embed.",
            );
        case "busy":
            return terminal(
                "skipped",
                "Embedding is already running for this project. Try again shortly.",
            );
        case "aborted": {
            // A drain only aborts via user pause (or session teardown). Render
            // it as the neutral "skipped" terminal — NOT "done", which the
            // sidebar shows as a green "✓ Embed complete" that wrongly reads as
            // finished.
            const cov = getEmbeddingCoverageStatus(deps.db, sessionProjectIdentity, sessionId);
            const msg = `Paused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`;
            return terminal("skipped", msg);
        }
        case "stalled":
            return terminal(
                "skipped",
                formatEmbedFailureSummary(outcome.embedded, outcome.remaining, outcome.failure),
            );
        default:
            return terminal(
                "done",
                `Embedded ${outcome.embedded} compartment${outcome.embedded === 1 ? "" : "s"} of history for semantic search${runFailed > 0 ? ` (${runFailed} failed)` : ""}.`,
            );
    }
}

/** Stop an active drain and keep it stopped until the next explicit start. */
export function pauseEmbedHistoryDrain(deps: EmbedHistoryDeps, sessionId: string): string {
    embedPauseBySession.add(sessionId);
    const ctrl = embedRunStateBySession.get(sessionId);
    if (ctrl) ctrl.abort();
    const directory = deps.resolveDirectory(sessionId);
    const sessionProjectIdentity = resolveProjectIdentityForSession(
        directory,
        deps.allowHomeProject,
    );
    if (!sessionProjectIdentity) return "No project identity is bound for the home directory.";
    deps.onDirectoryResolved?.(sessionId, directory);
    const cov = getEmbeddingCoverageStatus(deps.db, sessionProjectIdentity, sessionId);
    return `Paused at ${cov.session.embedded}/${cov.session.total} compartments embedded.`;
}
