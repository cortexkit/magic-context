import type { Database } from "../../../shared/sqlite";
import { logSlowWriteTransaction } from "../../../shared/write-transaction-timing";
import { deleteDreamState, getDreamState, setDreamState } from "./storage-dream-state";

const LEASE_DURATION_MS = 2 * 60 * 1000; // Expires after 2 minutes unless the heartbeat renews it.

/**
 * Each lease key identifies an independent conflict domain (memory:<project>,
 * key-files:<project>, user-memories, …). Different keys can be used at the same
 * time, while work using the same key is serialized. Each lease is represented by
 * four `dream_state` rows under its key namespace.
 *
 * `DREAMING_LEASE_KEY` is the legacy default key. Keeping it as the default
 * preserves callers that still use `acquireLease(db, holderId)` without a key.
 */
export const DREAMING_LEASE_KEY = "dreaming";

interface LeaseRowKeys {
    holder: string;
    heartbeat: string;
    expiry: string;
    generation: string;
}

function rowKeys(leaseKey: string): LeaseRowKeys {
    // Preserve the legacy row names so leases created by an older plugin version
    // remain readable during an upgrade.
    if (leaseKey === DREAMING_LEASE_KEY) {
        return {
            holder: "dreaming_lease_holder",
            heartbeat: "dreaming_lease_heartbeat",
            expiry: "dreaming_lease_expiry",
            generation: "dreaming_lease_generation",
        };
    }
    return {
        holder: `lease:${leaseKey}:holder`,
        heartbeat: `lease:${leaseKey}:heartbeat`,
        expiry: `lease:${leaseKey}:expiry`,
        generation: `lease:${leaseKey}:generation`,
    };
}

function getLeaseExpiry(db: Database, keys: LeaseRowKeys): number | null {
    const value = getDreamState(db, keys.expiry);
    if (!value) {
        return null;
    }

    const expiry = Number(value);
    return Number.isFinite(expiry) ? expiry : null;
}

export function isLeaseActive(db: Database, leaseKey: string = DREAMING_LEASE_KEY): boolean {
    const expiry = getLeaseExpiry(db, rowKeys(leaseKey));
    return expiry !== null && expiry > Date.now();
}

export function getLeaseHolder(db: Database, leaseKey: string = DREAMING_LEASE_KEY): string | null {
    return getDreamState(db, rowKeys(leaseKey).holder);
}

export function getLeaseGeneration(
    db: Database,
    leaseKey: string = DREAMING_LEASE_KEY,
): number | null {
    const value = getDreamState(db, rowKeys(leaseKey).generation);
    if (!value) return null;
    const generation = Number(value);
    return Number.isSafeInteger(generation) && generation > 0 ? generation : null;
}

export function peekLeaseHolderAndExpiry(
    db: Database,
    expectedHolder: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    const keys = rowKeys(leaseKey);
    const holder = getDreamState(db, keys.holder);
    if (holder !== expectedHolder) return false;
    const expiryStr = getDreamState(db, keys.expiry);
    if (!expiryStr) return false;
    const expiry = Number(expiryStr);
    return Number.isFinite(expiry) && expiry >= Date.now();
}

export function leaseOwnershipMatches(
    db: Database,
    expectedHolder: string,
    expectedGeneration: number,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    return (
        getLeaseGeneration(db, leaseKey) === expectedGeneration &&
        peekLeaseHolderAndExpiry(db, expectedHolder, leaseKey)
    );
}

// Mutations that update a lease use BEGIN IMMEDIATE. SQLite takes the write lock
// before code reads and updates the four lease rows, making each decision atomic
// across handles sharing the database and preventing duplicate acquisition.
// busy_timeout (set in initializeDatabase) makes a contending process wait rather
// than fail immediately with SQLITE_BUSY.
function runImmediate<T>(
    db: Database,
    body: () => T,
    site?: string,
    slowWriteThresholdMs?: number,
): T {
    const transactionStartedAt = site === undefined ? undefined : performance.now();
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        const result = body();
        db.exec("COMMIT");
        committed = true;
        if (site !== undefined && transactionStartedAt !== undefined) {
            logSlowWriteTransaction(site, transactionStartedAt, slowWriteThresholdMs);
        }
        return result;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // already rolled back / no active transaction
            }
        }
    }
}

export interface LeaseAcquisition {
    acquiredAt: number;
    generation: number;
}

export function acquireLeaseWithAcquisition(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): LeaseAcquisition | null {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        const existingHolder = getLeaseHolder(db, leaseKey);
        if (isLeaseActive(db, leaseKey) && existingHolder && existingHolder !== holderId) {
            return null;
        }

        const now = Date.now();
        const priorGeneration = getLeaseGeneration(db, leaseKey) ?? 0;
        const generation =
            existingHolder === holderId ? Math.max(1, priorGeneration) : priorGeneration + 1;
        setDreamState(db, keys.holder, holderId);
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        setDreamState(db, keys.generation, String(generation));
        return { acquiredAt: now, generation };
    });
}

export function acquireLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): boolean {
    return acquireLeaseWithAcquisition(db, holderId, leaseKey) !== null;
}

export function renewLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
    expectedGeneration?: number,
): boolean {
    const keys = rowKeys(leaseKey);
    return runImmediate(db, () => {
        if (
            getLeaseHolder(db, leaseKey) !== holderId ||
            !isLeaseActive(db, leaseKey) ||
            (expectedGeneration !== undefined &&
                getLeaseGeneration(db, leaseKey) !== expectedGeneration)
        ) {
            return false;
        }

        const now = Date.now();
        setDreamState(db, keys.heartbeat, String(now));
        setDreamState(db, keys.expiry, String(now + LEASE_DURATION_MS));
        return true;
    });
}

export function runLeaseGuardedWrite<T>(
    db: Database,
    holderId: string,
    leaseKey: string,
    fn: () => T,
    slowWriteThresholdMs?: number,
): T {
    return runImmediate(
        db,
        () => {
            // Check ownership after BEGIN IMMEDIATE acquires the write lock. This
            // prevents another process from taking the lease before fn performs its
            // write.
            if (!peekLeaseHolderAndExpiry(db, holderId, leaseKey)) {
                throw new Error("Dream lease lost before guarded write");
            }
            return fn();
        },
        `lease-guarded-write:${leaseKey}`,
        slowWriteThresholdMs,
    );
}

/** Renew halfway through the 120-second lease, leaving about 60 seconds for a
 * delayed or contended renewal before the lease expires. */
const LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface LeaseHeartbeat {
    /** Stop the heartbeat timer. Safe to call more than once. */
    stop(): void;
    /** True after this process no longer owns the lease and onLost was called. */
    readonly lost: boolean;
}

/**
 * Keep a held lease alive on a background interval. Transient renewal errors are
 * retried, an expired lease is reacquired when no other holder claimed it, and
 * lease loss is reported once after another holder is confirmed or a full
 * two-minute lease period passes without a confirmed renewal.
 */
export function startLeaseHeartbeat(
    db: Database,
    holderId: string,
    leaseKey: string,
    onLost: (reason: string) => void,
    intervalOrAcquisition: number | LeaseAcquisition = LEASE_HEARTBEAT_INTERVAL_MS,
): LeaseHeartbeat {
    const intervalMs =
        typeof intervalOrAcquisition === "number"
            ? intervalOrAcquisition
            : LEASE_HEARTBEAT_INTERVAL_MS;
    const acquisition =
        typeof intervalOrAcquisition === "number" ? undefined : intervalOrAcquisition;
    let lost = false;
    let expectedGeneration = acquisition?.generation ?? getLeaseGeneration(db, leaseKey);
    let lastConfirmedAt = acquisition?.acquiredAt ?? Date.now();
    const declareLost = (reason: string): void => {
        if (lost) return;
        lost = true;
        onLost(reason);
    };
    const beat = () => {
        if (lost) return;
        try {
            // A successful renewal confirms that this process still owns the lease
            // and refreshes the confirmation time.
            if (
                renewLease(
                    db,
                    holderId,
                    leaseKey,
                    expectedGeneration === null ? undefined : expectedGeneration,
                )
            ) {
                lastConfirmedAt = Date.now();
                return;
            }
            if (
                expectedGeneration !== null &&
                getLeaseGeneration(db, leaseKey) !== expectedGeneration
            ) {
                declareLost("lease generation changed — another holder acquired it");
                return;
            }
            // If renewal fails and the gap since the last confirmation exceeds a
            // two-minute lease period, another process may have acquired and used
            // the lease while this worker was unable to confirm ownership. Do not
            // let this worker reclaim the lease without current ownership. If the
            // gap is shorter, the next beat can reacquire an unowned lease below.
            if (Date.now() - lastConfirmedAt > LEASE_DURATION_MS) {
                declareLost("lease lapsed past TTL — another holder may have run");
                return;
            }
            // On this beat, reacquire an expired lease if no other holder has
            // claimed it. This returns false when another holder owns it.
            const reacquired = acquireLeaseWithAcquisition(db, holderId, leaseKey);
            if (reacquired) {
                if (expectedGeneration !== null && reacquired.generation !== expectedGeneration) {
                    declareLost("lease generation changed during reacquisition");
                    return;
                }
                expectedGeneration = reacquired.generation;
                lastConfirmedAt = Date.now();
                return;
            }
            declareLost("lease acquired by another holder");
        } catch {
            if (Date.now() - lastConfirmedAt > LEASE_DURATION_MS) {
                declareLost("lease renewal unconfirmed past TTL");
            }
        }
    };

    // Confirm ownership synchronously before returning. Otherwise the caller could
    // pause until the lease expires and begin work after another task acquires the
    // same lease key.
    beat();

    const timer = lost ? undefined : setInterval(beat, intervalMs);
    return {
        stop: () => {
            if (timer) clearInterval(timer);
        },
        get lost() {
            return lost;
        },
    };
}

export function releaseLease(
    db: Database,
    holderId: string,
    leaseKey: string = DREAMING_LEASE_KEY,
): void {
    const keys = rowKeys(leaseKey);
    runImmediate(db, () => {
        if (getLeaseHolder(db, leaseKey) !== holderId) {
            return;
        }

        deleteDreamState(db, keys.holder);
        deleteDreamState(db, keys.heartbeat);
        deleteDreamState(db, keys.expiry);
    });
}
