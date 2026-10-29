import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { getHarness } from "../../../shared/harness";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { getDefaultSubcConnectionFile } from "../../../shared/subc-connection-file";
import {
    getRecordedSessionProjectIdentity,
    getServedSessionProjectIdentity,
    reconcileServedSessionProjectIdentity,
    recordSessionProjectIdentity,
} from "../session-project-storage";
import { readSessionMeta } from "../storage-meta-session";
import type { SessionMeta } from "../types";
import { type EntorhinalResolveOptions, resolveEntorhinalProject } from "./entorhinal-resolve";
import { readGitCheckoutMetadata } from "./git-common-dir";
import {
    isUserHomeDirectory,
    rememberResolvedProjectIdentity,
    resolveProjectIdentityForSession,
    shouldSkipHomeProjectMemory,
} from "./project-identity";
import {
    findPinnedIdentityByGitCommonDir,
    isPinnedProjectIdentity,
    readRememberedProjectIdentity,
} from "./project-identity-cache";

/** A directory decision may be pending while another project's prefix is served. */
export interface SessionIdentityDecision {
    directory: string;
    identity: string | undefined;
}

export interface SessionIdentityDecisionOptions extends EntorhinalResolveOptions {
    allowHomeProject?: boolean;
    db?: Database | null;
    /** A launch-directory fallback cannot establish that the host session moved. */
    directoryIsFallback?: boolean;
    /** The transform already loaded this snapshot; cached owners are not pending decisions. */
    sessionMeta?: SessionMeta;
}

interface Entry {
    directory: string;
    decision?: SessionIdentityDecision;
    recordedIdentity?: string;
    observedDirectoryMove?: boolean;
    promise: Promise<SessionIdentityDecision>;
}

const decisions = new Map<string, Entry>();
const loggedMoves = new Map<string, Set<string>>();

// Check local access before looking for registered-project sidecars or calling the
// registry. Ineligible paths retain the legacy resolver's home/fallback behavior.
function eligible(directory: string, options: SessionIdentityDecisionOptions): boolean {
    try {
        if (options.allowHomeProject === undefined) {
            if (shouldSkipHomeProjectMemory(directory)) return false;
        } else if (!options.allowHomeProject) {
            if (isUserHomeDirectory(directory)) return false;
            const root = readGitCheckoutMetadata(directory)?.checkoutRoot;
            if (root && isUserHomeDirectory(root)) return false;
        }
        if (!statSync(directory).isDirectory()) return false;
        accessSync(directory, constants.R_OK | constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function pin(directory: string): string | undefined {
    const identity = readRememberedProjectIdentity(directory)?.identity;
    return isPinnedProjectIdentity(identity) ? identity : undefined;
}

function commonDirPin(directory: string): string | undefined {
    const commonDir = readGitCheckoutMetadata(directory)?.gitCommonDir;
    return commonDir ? findPinnedIdentityByGitCommonDir(commonDir) : undefined;
}

function rustManaged(db: Database | null | undefined, identity: string | undefined): boolean {
    if (!db || !identity) return false;
    const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'authority_managed'")
        .get();
    return Boolean(
        table && db.prepare("SELECT 1 FROM authority_managed WHERE project_path = ?").get(identity),
    );
}

async function decide(
    sessionId: string,
    directory: string,
    options: SessionIdentityDecisionOptions,
): Promise<SessionIdentityDecision> {
    if (!eligible(directory, options)) {
        return {
            directory,
            identity: resolveProjectIdentityForSession(directory, options.allowHomeProject),
        };
    }
    const pinned = pin(directory);
    if (pinned) return { directory, identity: pinned };
    const connectionFile = options.connectionFile ?? getDefaultSubcConnectionFile();
    // Standalone hosts with no connection file need neither transport setup nor a deadline timer.
    const answer = existsSync(connectionFile)
        ? await resolveEntorhinalProject(directory, {
              connectionFile,
              identity: options.identity ?? {
                  project_root: directory,
                  harness: getHarness(),
                  session: sessionId,
              },
              log: options.log,
          })
        : { status: "absent" as const };
    if (answer.status === "resolved") {
        const fallback = resolveProjectIdentityForSession(directory, options.allowHomeProject);
        try {
            if (rustManaged(options.db, fallback)) {
                (options.log ?? log)(
                    `[magic-context] keeping Rust-managed project identity ${fallback}; single-store migration required`,
                );
                return { directory, identity: fallback };
            }
        } catch (error) {
            // A failed authority read cannot authorize moving a project's data key.
            (options.log ?? log)(
                `[magic-context] keeping project identity ${fallback}; authority check failed: ${error}`,
            );
            return { directory, identity: fallback };
        }
        rememberResolvedProjectIdentity(directory, answer, options.allowHomeProject);
        return { directory, identity: pin(directory) ?? answer.projectId };
    }
    return {
        directory,
        identity:
            commonDirPin(directory) ??
            resolveProjectIdentityForSession(directory, options.allowHomeProject),
    };
}

/** The first async observer owns the bounded attempt; all concurrent observers share it. */
export function awaitSessionIdentityDecision(
    sessionId: string,
    directory: string,
    options: SessionIdentityDecisionOptions = {},
): Promise<SessionIdentityDecision> {
    directory = path.resolve(directory);
    const existing = decisions.get(sessionId);
    const served = getServedSessionProjectIdentity(options.sessionMeta);
    if (existing) {
        const recorded =
            options.directoryIsFallback && served !== undefined
                ? served
                : options.directoryIsFallback &&
                    options.db &&
                    options.sessionMeta?.cachedM0Bytes == null
                  ? getRecordedSessionProjectIdentity(options.db, sessionId)
                  : undefined;
        if (recorded) {
            existing.recordedIdentity = recorded;
            return Promise.resolve({ directory: existing.directory, identity: recorded });
        }
        if (options.directoryIsFallback) return existing.promise;
        if (existing.directory !== directory) {
            readSessionIdentityDecision(sessionId, directory, options);
            return decisions.get(sessionId)?.promise ?? existing.promise;
        }
        readSessionIdentityDecision(sessionId, directory, options);
        return existing.promise;
    }
    const entry: Entry = {
        directory,
        promise: Promise.resolve().then(async () => {
            const recorded =
                options.db && served === undefined
                    ? getRecordedSessionProjectIdentity(options.db, sessionId)
                    : undefined;
            entry.recordedIdentity = recorded;
            const decision =
                options.directoryIsFallback && served !== undefined
                    ? { directory, identity: served }
                    : recorded
                      ? { directory, identity: recorded }
                      : await decide(sessionId, directory, options);
            // A completed attempt may pin its own directory, but cannot replace
            // the session's decision for a newer directory.
            if (decisions.get(sessionId) === entry) entry.decision = decision;
            return decisions.get(sessionId)?.decision ?? decision;
        }),
    };
    decisions.set(sessionId, entry);
    return entry.promise;
}

/** Prefer the served block's owner; an unowned prefix falls back to the shared decision. */
export async function resolveSessionProjectIdentity(
    sessionId: string,
    directory: string,
    options: SessionIdentityDecisionOptions = {},
): Promise<string | undefined> {
    const sessionMeta =
        options.sessionMeta ?? (options.db ? readSessionMeta(options.db, sessionId) : undefined);
    const served =
        options.db && sessionMeta
            ? reconcileServedSessionProjectIdentity(options.db, sessionId, sessionMeta, true)
            : getServedSessionProjectIdentity(sessionMeta);
    if (served !== undefined) return served;
    if (sessionMeta?.cachedM0Bytes != null) {
        // Legacy prefixes have no proven owner. Use their shared decision, not
        // an attribution row that may describe a different pending directory.
        const decision = await awaitSessionIdentityDecision(sessionId, directory, {
            ...options,
            sessionMeta,
        });
        if (options.db) recordSessionProjectIdentity(options.db, sessionId, decision.identity);
        return decision.identity;
    }
    const recorded = options.db
        ? getRecordedSessionProjectIdentity(options.db, sessionId)
        : undefined;
    if (recorded !== undefined) return recorded;
    const decision = await awaitSessionIdentityDecision(sessionId, directory, {
        ...options,
        sessionMeta,
    });
    // A transform may have recorded the owner while the first attempt was in flight.
    const identity =
        (options.db ? getRecordedSessionProjectIdentity(options.db, sessionId) : undefined) ??
        decision.identity;
    if (options.db) recordSessionProjectIdentity(options.db, sessionId, identity);
    return identity;
}

/**
 * Read the pending decision; an undefined directory peeks without observing a move.
 * Host-directory moves read pinned IDs from local project-identity JSON records,
 * then use the Git/path fallback without contacting the project registry.
 */
export function readSessionIdentityDecision(
    sessionId: string,
    directory: string | undefined,
    options: SessionIdentityDecisionOptions = {},
): SessionIdentityDecision | undefined {
    const entry = decisions.get(sessionId);
    if (directory === undefined) return entry?.decision;
    directory = path.resolve(directory);
    if (!entry) return undefined;
    if (entry.directory !== directory) {
        const decision = {
            directory,
            identity: eligible(directory, options)
                ? (pin(directory) ??
                  commonDirPin(directory) ??
                  resolveProjectIdentityForSession(directory, options.allowHomeProject))
                : resolveProjectIdentityForSession(directory, options.allowHomeProject),
        };
        decisions.set(sessionId, {
            directory,
            decision,
            recordedIdentity: options.db
                ? getRecordedSessionProjectIdentity(options.db, sessionId)
                : undefined,
            observedDirectoryMove: true,
            promise: Promise.resolve(decision),
        });
        const move = `${entry.directory}\0${directory}`;
        const seen = loggedMoves.get(sessionId) ?? new Set<string>();
        loggedMoves.set(sessionId, seen);
        if (!seen.has(move)) {
            seen.add(move);
            (options.log ?? log)(
                `[magic-context] session ${sessionId} directory moved from ${entry.directory} to ${directory}; identity=${decision.identity ?? "none"}`,
            );
        }
        return decision;
    }
    const decision = entry.decision;
    const served = getServedSessionProjectIdentity(options.sessionMeta);
    if (decision && served !== undefined && served === decision.identity)
        entry.observedDirectoryMove = false;
    const recorded =
        options.db && options.sessionMeta?.cachedM0Bytes == null
            ? getRecordedSessionProjectIdentity(options.db, sessionId)
            : undefined;
    if (
        decision &&
        !entry.observedDirectoryMove &&
        recorded !== undefined &&
        recorded !== entry.recordedIdentity
    ) {
        // A durable decision can outlive this process's earlier fallback.
        // An unchanged row must not undo a directory move awaiting persistence.
        entry.recordedIdentity = recorded;
        decision.identity = recorded;
        return decision;
    }
    if (
        decision &&
        !decision.identity?.startsWith("git:") &&
        !isPinnedProjectIdentity(decision.identity)
    ) {
        // A newly detected repository or a successful later git probe may upgrade
        // the fallback identity. Another session's registered-project sidecar cannot change it.
        const revalidated = resolveProjectIdentityForSession(directory, options.allowHomeProject);
        if (revalidated && !isPinnedProjectIdentity(revalidated)) decision.identity = revalidated;
    }
    return decision;
}

/**
 * Whether this decision already has recorded project attribution.
 * During an unresolved-directory pass, the transform uses this cached fact to
 * replay the existing M0/M1 prefix messages instead of rebuilding for the launch folder.
 * The predicate does not query session_projects or choose a memory owner.
 */
export function hasSessionProjectAttribution(sessionId: string): boolean {
    return decisions.get(sessionId)?.recordedIdentity !== undefined;
}

export function forgetSessionIdentityDecision(sessionId: string): void {
    decisions.delete(sessionId);
    loggedMoves.delete(sessionId);
}

export function __resetSessionIdentityDecisionsForTests(): void {
    decisions.clear();
    loggedMoves.clear();
}
