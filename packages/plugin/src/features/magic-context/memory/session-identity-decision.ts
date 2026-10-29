import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";
import { getHarness } from "../../../shared/harness";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { getDefaultSubcConnectionFile } from "../../../shared/subc-connection-file";
import { type EntorhinalResolveOptions, resolveEntorhinalProject } from "./entorhinal-resolve";
import { readGitCheckoutMetadata } from "./git-common-dir";
import {
    borrowedProjectIdentity,
    isUserHomeDirectory,
    rememberResolvedProjectIdentity,
    resolveProjectIdentityForSession,
    shouldSkipHomeProjectMemory,
} from "./project-identity";
import { isPinnedProjectIdentity, readRememberedProjectIdentity } from "./project-identity-cache";

export interface SessionIdentityDecision {
    directory: string;
    identity: string | undefined;
}

export interface SessionIdentityDecisionOptions extends EntorhinalResolveOptions {
    allowHomeProject?: boolean;
    db?: Database | null;
}

interface Entry {
    directory: string;
    decision?: SessionIdentityDecision;
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
    return borrowedProjectIdentity(directory);
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
    if (existing) {
        if (existing.directory !== directory) {
            readSessionIdentityDecision(sessionId, directory, options);
            return decisions.get(sessionId)?.promise ?? existing.promise;
        }
        return existing.promise;
    }
    const entry: Entry = {
        directory,
        promise: Promise.resolve().then(async () => {
            const decision = await decide(sessionId, directory, options);
            // A completed attempt may pin its own directory, but cannot replace
            // the session's decision for a newer directory.
            if (decisions.get(sessionId) === entry) entry.decision = decision;
            return decisions.get(sessionId)?.decision ?? decision;
        }),
    };
    decisions.set(sessionId, entry);
    return entry.promise;
}

/** Read the session value synchronously; a directory move reads sidecars without a registry call. */
export function readSessionIdentityDecision(
    sessionId: string,
    directory: string,
    options: SessionIdentityDecisionOptions = {},
): SessionIdentityDecision | undefined {
    directory = path.resolve(directory);
    const entry = decisions.get(sessionId);
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
        decisions.set(sessionId, { directory, decision, promise: Promise.resolve(decision) });
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

export function forgetSessionIdentityDecision(sessionId: string): void {
    decisions.delete(sessionId);
    loggedMoves.delete(sessionId);
}

export function __resetSessionIdentityDecisionsForTests(): void {
    decisions.clear();
    loggedMoves.clear();
}
