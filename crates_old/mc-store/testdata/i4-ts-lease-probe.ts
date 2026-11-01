// Run the existing TypeScript lock decisions against a live Rust-held fixture lease.
// The functions are frozen so the oracle cannot change along with the Rust code;
// hashes below identify the exact original function text, including its comments.
// Frozen functions from 282d9c08bce490346583a3b8c145c402499f980f.
// Sources: packages/plugin/src/features/magic-context/compartment-lease.ts,
// packages/plugin/src/hooks/magic-context/compartment-runner.ts and wrapup-orchestrator.ts.
// SHA-256 of the exact extracted function text (also checked against the frozen copies):
// getCompartmentLeaseBlocker ecc8262c0468a693d062b37fcb230efb9425a290b1a58118bac2dd8e06d79ab8
// acquireCompartmentLease c410fb62425796c518a083d8effb2620bd426febc328b7a6d5dcced2d7af3fb9
// releaseCompartmentLease 3b9614427a5a2f0c453be40bccd7a5f8e454218e8ba72cc3adbb8b7bd48170ec
// executeContextRecompWithResult e2dcbaae29ea2e0dbcef584da5b47da1ac30fcfaadd7ecba094569a3ca58d4ca
// acquireCompartmentLeaseForWrapup fbe1e53033b8f8267fb4700753984f0d8fcc7e4e038bd530819d24aa3b1e6fe3
// Only surrounding dependencies are stubbed; the clock bounds wrapup's unchanged wait.
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";

interface CompartmentLeaseBlocker { holderId: string; ownerPid: number | null; acquiredAt: number; expiresAt: number; }
interface LeaseAcquired extends CompartmentLeaseBlocker { sessionId: string; ownerPid: number; }
interface CompartmentRunnerDeps { db: Database; sessionId: string; compartmentLeaseHolderId?: string; }
interface ExecuteContextRecompOptions { range?: boolean; onLeaseAcquired?: () => void; }
interface ExecuteContextRecompResult { message: string; published: boolean; }
interface ManagedWrapupContext { db: Database; }
type WrapupProgressUpdate = Record<string, unknown>;
type WrapupLeaseAcquireResult = { ok: true; holderId: string } | { ok: false; reason: string };
interface ActiveRun { promise: Promise<void>; published: boolean; kind: string; }

const db = new Database(process.argv[2]);
const sessionId = "ses";
const sessionLog = (..._args: unknown[]) => {};
const isPidAlive = (pid: number) => {
    try { process.kill(pid, 0); return "alive"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
};
const COMPARTMENT_LEASE_TTL_MS = 5 * 60 * 1000;
const activeRuns = new Map<string, ActiveRun>();
const getActiveCompartmentRun = (_sessionId: string): ActiveRun | undefined => undefined;
const isWrapupInProgress = (_db: Database, _sessionId: string) => false;
const resolveWrapupLeaseWaitTimeout = (_ctx: ManagedWrapupContext) => 2;
const WAIT_FOR_LEASE_MS = 1;
const emitWrapupProgress = (..._args: unknown[]) => {};
const waitForActiveRunWithin = async (_promise: Promise<void>, _max: number): Promise<"timeout" | "ok"> => { throw new Error("unexpected active run"); };
let published = 0;
const startLeaseRenewal = (..._args: unknown[]) => undefined;
const withPublishedCallback = (deps: CompartmentRunnerDeps) => deps;
const executePartialRecompInternal = async (..._args: unknown[]): Promise<string> => { throw new Error("unexpected partial recomp"); };
const executeContextRecompInternal = async (_deps: CompartmentRunnerDeps) => {
    published++;
    return "fixture recomp completed";
};
let now = Date.now();
Date.now = () => now;
const sleep = async (ms: number) => { now += ms; };

export function getCompartmentLeaseBlocker(
    db: Database,
    sessionId: string,
): CompartmentLeaseBlocker | null {
    const row = db
        .prepare(
            `SELECT holder_id AS holderId, owner_pid AS ownerPid,
                    acquired_at AS acquiredAt, expires_at AS expiresAt
               FROM compartment_state_lease
              WHERE session_id = ? AND expires_at > ?`,
        )
        .get(sessionId, Date.now()) as CompartmentLeaseBlocker | undefined;
    return row ?? null;
}

export function acquireCompartmentLease(
    db: Database,
    sessionId: string,
    holderId: string,
): LeaseAcquired | null {
    const acquiredAt = Date.now();
    const expiresAt = acquiredAt + COMPARTMENT_LEASE_TTL_MS;
    const ownerPid = process.pid;
    const blocker = getCompartmentLeaseBlocker(db, sessionId);
    if (blocker?.ownerPid && isPidAlive(blocker.ownerPid) === "dead") {
        const reclaimed = db
            .prepare(
                `DELETE FROM compartment_state_lease
                  WHERE session_id = ? AND holder_id = ? AND owner_pid = ?
                    AND acquired_at = ? AND expires_at = ?`,
            )
            .run(
                sessionId,
                blocker.holderId,
                blocker.ownerPid,
                blocker.acquiredAt,
                blocker.expiresAt,
            );
        if (reclaimed.changes === 1) {
            sessionLog(
                sessionId,
                `reclaimed compartment lease from dead owner holder=${blocker.holderId} pid=${blocker.ownerPid}`,
            );
        }
    }
    const result = db
        .prepare(
            `INSERT INTO compartment_state_lease
                (session_id, holder_id, owner_pid, acquired_at, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
                holder_id = excluded.holder_id,
                owner_pid = excluded.owner_pid,
                acquired_at = excluded.acquired_at,
                expires_at = excluded.expires_at
             WHERE compartment_state_lease.holder_id = excluded.holder_id
                OR compartment_state_lease.expires_at <= ?`,
        )
        .run(sessionId, holderId, ownerPid, acquiredAt, expiresAt, acquiredAt);

    if (result.changes !== 1) {
        return null;
    }

    return { sessionId, holderId, acquiredAt, expiresAt, ownerPid };
}

export function releaseCompartmentLease(db: Database, sessionId: string, holderId: string): void {
    db.prepare("DELETE FROM compartment_state_lease WHERE session_id = ? AND holder_id = ?").run(
        sessionId,
        holderId,
    );
}

export async function executeContextRecompWithResult(
    deps: CompartmentRunnerDeps,
    options: ExecuteContextRecompOptions = {},
): Promise<ExecuteContextRecompResult> {
    const { sessionId } = deps;
    if (isWrapupInProgress(deps.db, sessionId)) {
        return {
            message:
                "## Magic Recomp — Skipped\n\n/ctx-wrapup is already compacting this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }
    if (activeRuns.has(sessionId)) {
        return {
            // "— Skipped" suffix so isRecompFailure() (string-based callers) treats
            // this as a non-success and never proceeds to migration / "complete"
            // on it (dogfood 2026-05-30). The `published:false` flag is the robust
            // primary signal; this heading is defense-in-depth.
            message:
                "## Magic Recomp — Skipped\n\nHistorian is already running for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }

    const holderId = crypto.randomUUID();
    const lease = acquireCompartmentLease(deps.db, sessionId, holderId);
    if (!lease) {
        sessionLog(sessionId, "recomp skipped: compartment lease held by another process");
        return {
            message:
                "## Magic Recomp — Skipped\n\nAnother process is already mutating compartment state for this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }
    options.onLeaseAcquired?.();
    if (isWrapupInProgress(deps.db, sessionId)) {
        // Close the marker/lease race: wrapup publishes its durable ownership
        // marker before it waits for the compartment lease, so a recomp that
        // checked early can still win the lease after wrapup has started.
        sessionLog(sessionId, "recomp skipped: /ctx-wrapup became active");
        releaseCompartmentLease(deps.db, sessionId, holderId);
        return {
            message:
                "## Magic Recomp — Skipped\n\n/ctx-wrapup is already compacting this session. Wait for it to finish, then try `/ctx-recomp` again.",
            published: false,
        };
    }
    const renewal = startLeaseRenewal(deps, holderId);
    const runnerDeps = withPublishedCallback({ ...deps, compartmentLeaseHolderId: holderId });
    const promise = options.range
        ? executePartialRecompInternal(runnerDeps, options.range)
        : executeContextRecompInternal(runnerDeps);
    const wrappedPromise = promise
        .then(() => undefined)
        .catch((err) => {
            sessionLog(sessionId, "compartment agent: recomp unhandled rejection:", err);
        });
    activeRuns.set(sessionId, { promise: wrappedPromise, published: false, kind: "recomp" });
    try {
        const message = await promise;
        // B1 (dogfood 2026-05-30): log EVERY recomp outcome here — this wraps all
        // ~12 return paths in the runner, so a silently-non-publishing recomp is
        // now always diagnosable from the log. The returned message carries the
        // reason inline (e.g. "## Magic Recomp — Failed\n\n<reason>").
        const published = activeRuns.get(sessionId)?.published === true;
        const outcomeSummary = message.replace(/\s+/g, " ").trim().slice(0, 240);
        sessionLog(sessionId, `recomp finished (published=${published}): ${outcomeSummary}`);
        return {
            message,
            published,
        };
    } finally {
        clearInterval(renewal);
        releaseCompartmentLease(deps.db, sessionId, holderId);
        if (activeRuns.get(sessionId)?.promise === wrappedPromise) {
            activeRuns.delete(sessionId);
        }
    }
}

async function acquireCompartmentLeaseForWrapup(
    ctx: ManagedWrapupContext,
    sessionId: string,
    renewWrapupMarker: (updates: WrapupProgressUpdate) => boolean,
): Promise<WrapupLeaseAcquireResult> {
    const holderId = crypto.randomUUID();
    const waitStartedAt = Date.now();
    const maxWaitMs = resolveWrapupLeaseWaitTimeout(ctx);
    const remainingMs = (): number => Math.max(0, waitStartedAt + maxWaitMs - Date.now());
    for (;;) {
        if (remainingMs() <= 0) {
            sessionLog(sessionId, "wrapup: timed out waiting for the compartment-state lease");
            return { ok: false, reason: "timeout" };
        }
        const active = getActiveCompartmentRun(sessionId);
        if (active?.kind === "recomp" || active?.kind === "wrapup") {
            return { ok: false, reason: "busy" };
        }
        if (active) {
            emitWrapupProgress(ctx, sessionId, { note: "Waiting for the active historian run…" });
            const outcome = await waitForActiveRunWithin(active.promise, remainingMs());
            if (outcome === "timeout") {
                sessionLog(sessionId, "wrapup: timed out waiting for the active historian run");
                return { ok: false, reason: "timeout" };
            }
            continue;
        }
        const lease = acquireCompartmentLease(ctx.db, sessionId, holderId);
        if (lease) return { ok: true, holderId };
        emitWrapupProgress(ctx, sessionId, { note: "Waiting for the compartment-state lease…" });
        if (!renewWrapupMarker({})) return { ok: false, reason: "ownership_lost" };
        await sleep(Math.min(WAIT_FOR_LEASE_MS, remainingMs()));
    }
}

const blocked = process.argv[3] === "blocked";
const recomp = await executeContextRecompWithResult({db, sessionId});
assert.equal(recomp.published, false);
assert.equal(recomp.message.includes("— Skipped"), blocked);
assert.equal(published, blocked ? 0 : 1);
const wrapup = await acquireCompartmentLeaseForWrapup({db}, sessionId, () => true);
assert.equal(wrapup.ok, !blocked);
if (blocked) { assert(!wrapup.ok); assert.equal(wrapup.reason, "timeout"); }
else { assert(wrapup.ok); releaseCompartmentLease(db, sessionId, wrapup.holderId); }
db.close();
console.log(`frozen TS recomp/wrapup: ${blocked ? "refused" : "acquired after release"}`);
