import { existsSync, mkdtempSync, readFileSync, realpathSync, statfsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import type { Database } from "@magic-context/core/shared/sqlite";
import { writeStorageFileAtomicSync } from "@magic-context/core/shared/storage-permissions";
import { setPersistedCompactionMarkerState } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import { setRecompPartialRange } from "@magic-context/core/features/magic-context/compartment-storage";
import { setHistoryHealQueue } from "@magic-context/core/features/magic-context/history-heal-queue";
import { queueM0Mutation } from "@magic-context/core/features/magic-context/storage-m0-mutation-log";
import {
    CLI_SCHEMA_FLOOR_VERSION,
    getPersistedSchemaVersion,
    openExistingContextDatabase,
    openExistingDatabase,
} from "../lib/database-access";
import { probeHostProcessesUsing } from "./doctor-opencode2-cache";
import { copyDatabaseBundle, defaultInspectHolders } from "./doctor-repair-db";
import {
    canonical,
    digest,
    inventory,
    hasMode3MoveRecord,
    planHealSession,
    quote,
    readHealMeta,
    type HealSession,
    type HistoryHealPlan,
    type Rewrite,
    type Row,
} from "./doctor-history-heal-plan";

export interface HistoryHealDeps {
    inspectHolders: typeof defaultInspectHolders;
    probe: typeof probeHostProcessesUsing;
    freeBytes: (path: string) => number;
}
function open(path: string, context: boolean, readonly: boolean): Database {
    const db = context
        ? openExistingContextDatabase(path, {
              readonly,
              minimumSupportedVersion: CLI_SCHEMA_FLOOR_VERSION,
          })
        : openExistingDatabase(path, { readonly });
    if (!db) throw new Error(`Database does not exist: ${path}`);
    return db;
}
export function buildHistoryHealPlan(
    db: Database,
    host: Database,
    dbPath: string,
    hostDbPath: string,
    ids?: string[],
): HistoryHealPlan {
    const sessions = ids?.length
        ? [...new Set(ids)].sort()
        : (
              db
                  .prepare(
                      "SELECT DISTINCT session_id FROM compartments WHERE harness='opencode' ORDER BY session_id",
                  )
                  .all() as { session_id: string }[]
          ).map((r) => r.session_id);
    return {
        version: 1,
        counting: "opencode1-created-id-finished-summary-v1",
        dbPath,
        hostDbPath,
        schemaVersion: getPersistedSchemaVersion(db),
        sessions: sessions.map((id) => planHealSession(db, host, id)),
    };
}
function held(plan: HistoryHealPlan, deps: Partial<HistoryHealDeps>): void {
    const result = (deps.inspectHolders ?? defaultInspectHolders)(dirname(plan.dbPath));
    const probe = (deps.probe ?? probeHostProcessesUsing)({
        files: [plan.dbPath, plan.hostDbPath].flatMap((p) => [p, `${p}-wal`, `${p}-shm`]),
        directories: [],
    });
    if (!result.safe || probe.status !== "free")
        throw new Error(
            `holders: Close every host, ck-mc and dashboard before history heal. ${result.blockers.join(", ")} ${result.uncertainty ?? ""} ${probe.status === "in_use" ? probe.pids.join(", ") : probe.status === "unknown" ? probe.reason : ""}`,
        );
}
function metadata(db: Database, session: HealSession): void {
    const a = session.metaAfter,
        b = session.metaBefore;
    if (
        canonical(a.marker) !== canonical(b.marker) ||
        canonical(a.markerTargets) !== canonical(b.markerTargets)
    )
        setPersistedCompactionMarkerState(db, session.id, a.marker);
    if (canonical(a.partial) !== canonical(b.partial))
        setRecompPartialRange(db, session.id, a.partial);
    if (a.floor !== b.floor) updateSessionMeta(db, session.id, { priorBoundaryOrdinal: a.floor });
    if (canonical(a.queue) !== canonical(b.queue)) setHistoryHealQueue(db, session.id, a.queue);
    if (a.mutations.length > b.mutations.length)
        queueM0Mutation(db, { sessionId: session.id, mutationType: "recomp_boundary_change" });
}
export function applyHealRewrites(db: Database, rewrites: Rewrite[]): void {
    const where = (key: Row) =>
        Object.keys(key)
            .map((k) => `${quote(k)} IS ?`)
            .join(" AND ");
    // Map ordinals are unique keys, so shift their whole changed set without transient collisions.
    for (const r of rewrites.filter((r) => r.table === "message_fts_rowid_map" || r.after === null))
        db.prepare(`DELETE FROM ${quote(r.table)} WHERE ${where(r.key)}`).run(
            ...Object.values(r.key),
        );
    for (const r of rewrites) {
        if (r.after === null) continue;
        if (r.before === null || r.table === "message_fts_rowid_map") {
            const keys = Object.keys(r.after);
            db.prepare(
                `INSERT INTO ${quote(r.table)} (${keys.map(quote).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
            ).run(...Object.values(r.after));
        } else {
            db.prepare(
                `UPDATE ${quote(r.table)} SET ${Object.keys(r.after)
                    .map((k) => `${quote(k)}=?`)
                    .join(",")} WHERE ${where(r.key)}`,
            ).run(...Object.values(r.after), ...Object.values(r.key));
        }
    }
}
function fingerprint(db: Database, s: HealSession, host = false): string {
    return digest(inventory(db, s.id, host), host ? undefined : readHealMeta(db, s.id));
}
function validate(plan: HistoryHealPlan): void {
    if (
        plan.version !== 1 ||
        plan.counting !== "opencode1-created-id-finished-summary-v1" ||
        !Array.isArray(plan.sessions) ||
        typeof plan.dbPath !== "string" ||
        typeof plan.hostDbPath !== "string" ||
        !Number.isSafeInteger(plan.schemaVersion)
    )
        throw new Error("Invalid history heal plan");
    if (
        realpathSync.native(plan.dbPath) !== plan.dbPath ||
        realpathSync.native(plan.hostDbPath) !== plan.hostDbPath ||
        plan.dbPath === plan.hostDbPath
    )
        throw new Error("Plan must name two distinct canonical stores");
    if (new Set(plan.sessions.map((s) => s.id)).size !== plan.sessions.length)
        throw new Error("Duplicate planned session");
}
export function applyHistoryHealPlan(
    plan: HistoryHealPlan,
    check = false,
    deps: Partial<HistoryHealDeps> = {},
): number {
    validate(plan);
    held(plan, deps);
    const db = open(plan.dbPath, true, true),
        host = open(plan.hostDbPath, false, true);
    const states: { session: HealSession; contextDone: boolean; hostDone: boolean }[] = [];
    try {
        if (getPersistedSchemaVersion(db) !== plan.schemaVersion)
            throw new Error("Schema changed; re-plan history heal");
        for (const s of plan.sessions) {
            if (hasMode3MoveRecord(db, s.id) && !s.refusals.some((r) => r.code === "already_moved"))
                throw new Error(
                    `already_moved: ${s.title}; standalone history heal must not change a mode-3 session`,
                );
            const c = fingerprint(db, s),
                h = fingerprint(host, s, true);
            const contextDone = c === s.after.context,
                hostDone = h === s.after.host;
            if ((!contextDone && c !== s.before.context) || (!hostDone && h !== s.before.host))
                throw new Error(`stale_plan: ${s.title} changed; re-plan before applying`);
            if (!contextDone || !hostDone) {
                // On a fresh pair, independently derive every proposed write rather than trusting JSON edits.
                if (c === s.before.context && h === s.before.host) {
                    const fresh = planHealSession(db, host, s.id);
                    if (canonical(fresh) !== canonical(s))
                        throw new Error(`plan_mismatch: ${s.title}; re-plan`);
                } else if (contextDone && !hostDone)
                    throw new Error(
                        `inconsistent_commit_order: ${s.title}; restore both stores from backup`,
                    );
            }
            states.push({ session: s, contextDone, hostDone });
        }
    } finally {
        host.close();
        db.close();
    }
    if (check) {
        console.log("History heal apply check passed. Nothing was changed.");
        return 0;
    }
    const work = states.filter((s) => !s.contextDone || !s.hostDone);
    if (!work.length) {
        console.log("History heal: no changes (already applied).");
        return 0;
    }
    held(plan, deps);
    const bytes = [plan.dbPath, plan.hostDbPath]
        .flatMap((p) => [p, `${p}-wal`, `${p}-shm`])
        .reduce((n, p) => n + (existsSync(p) ? statSync(p).size : 0), 0);
    const free = (
        deps.freeBytes ??
        ((p) => {
            const s = statfsSync(p);
            return s.bavail * s.bsize;
        })
    )(dirname(plan.dbPath));
    if (!Number.isFinite(free) || free < bytes * 1.1)
        throw new Error(`insufficient_space: paired backup needs ${Math.ceil(bytes * 1.1)} bytes`);
    const writable = open(plan.dbPath, true, false),
        writableHost = open(plan.hostDbPath, false, false);
    try {
        // Freeze both bundles while copying; these backup lock transactions do not change rows.
        // Each session below still gets its own write transaction in each store.
        writable.exec("BEGIN IMMEDIATE");
        try {
            writableHost.exec("BEGIN IMMEDIATE");
            held(plan, deps);
            const backup = mkdtempSync(join(dirname(plan.dbPath), "history-heal-backup-"));
            copyDatabaseBundle(plan.dbPath, join(backup, "context.db"));
            copyDatabaseBundle(plan.hostDbPath, join(backup, "opencode.db"));
            writeStorageFileAtomicSync(
                join(backup, "manifest.json"),
                JSON.stringify(
                    {
                        dbPath: plan.dbPath,
                        hostDbPath: plan.hostDbPath,
                        restore:
                            "Close all hosts and restore BOTH database bundles, including WAL/SHM, or neither.",
                        plan,
                    },
                    null,
                    2,
                ),
            );
            console.log(
                `Paired backup: ${backup}. Restore both stores or neither; store.db is not changed.`,
            );
        } finally {
            if (writableHost.inTransaction) writableHost.exec("ROLLBACK");
            if (writable.inTransaction) writable.exec("ROLLBACK");
        }
        for (const state of work) {
            const s = state.session;
            writable.exec("BEGIN IMMEDIATE");
            try {
                writableHost.exec("BEGIN IMMEDIATE");
                try {
                    held(plan, deps);
                    if (hasMode3MoveRecord(writable, s.id))
                        throw new Error(`already_moved: ${s.title}`);
                    if (
                        fingerprint(writable, s) !==
                            (state.contextDone ? s.after.context : s.before.context) ||
                        fingerprint(writableHost, s, true) !==
                            (state.hostDone ? s.after.host : s.before.host)
                    )
                        throw new Error(`stale_plan: ${s.title} changed before writer locks`);
                    if (!state.hostDone)
                        applyHealRewrites(
                            writableHost,
                            s.rewrites.filter((r) => r.store === "host"),
                        );
                    if (!state.contextDone) {
                        applyHealRewrites(
                            writable,
                            s.rewrites.filter((r) => r.store === "context"),
                        );
                        metadata(writable, s);
                    }
                    if (
                        fingerprint(writable, s) !== s.after.context ||
                        fingerprint(writableHost, s, true) !== s.after.host
                    )
                        throw new Error(`after_image_mismatch: ${s.title}`);
                    // Fingerprints detect a host-only commit so the remaining context writes can resume.
                    writableHost.exec("COMMIT");
                    writable.exec("COMMIT");
                } catch (e) {
                    if (writableHost.inTransaction) writableHost.exec("ROLLBACK");
                    throw e;
                }
            } catch (e) {
                if (writable.inTransaction) writable.exec("ROLLBACK");
                throw e;
            }
            console.log(
                `${s.title}: healed; ${s.metaAfter.queue.length} queued partial recomp(s).`,
            );
        }
    } finally {
        writableHost.close();
        writable.close();
    }
    return 0;
}

export function runHistoryHealCli(args: string[], deps: Partial<HistoryHealDeps> = {}): number {
    const usage =
        "doctor history heal plan [--session id]... [--db context.db] --host-db opencode.db | apply [--check] plan.json";
    if (args[0] === "apply") {
        const check = args.includes("--check");
        const paths = args.slice(1).filter((a) => a !== "--check");
        if (paths.length !== 1 || paths[0].startsWith("--")) throw new Error(usage);
        return applyHistoryHealPlan(JSON.parse(readFileSync(paths[0], "utf8")), check, deps);
    }
    if (args[0] !== "plan") throw new Error(usage);
    let dbPath = join(getMagicContextStorageDir(), "context.db"),
        hostDbPath: string | undefined;
    const ids: string[] = [];
    for (let i = 1; i < args.length; i++) {
        const flag = args[i],
            value = args[++i];
        if (!value || value.startsWith("--")) throw new Error(usage);
        if (flag === "--db") dbPath = value;
        else if (flag === "--host-db") hostDbPath = value;
        else if (flag === "--session") ids.push(value);
        else throw new Error(`Unknown history heal option: ${flag}`);
    }
    if (!hostDbPath) throw new Error(usage);
    dbPath = realpathSync.native(dbPath);
    hostDbPath = realpathSync.native(hostDbPath);
    const db = open(dbPath, true, true),
        host = open(hostDbPath, false, true);
    try {
        const plan = buildHistoryHealPlan(db, host, dbPath, hostDbPath, ids);
        const path = join(
            dirname(dbPath),
            `history-heal-plan-${new Date().toISOString().replaceAll(":", "-")}.json`,
        );
        writeStorageFileAtomicSync(path, `${JSON.stringify(plan, null, 2)}\n`);
        console.log(`History heal plan: ${path}`);
        for (const s of plan.sessions) {
            console.log(
                `${s.title} (${s.id}): ${s.rewrites.length} row rewrite(s), ${canonical(s.metaBefore) === canonical(s.metaAfter) ? "unchanged metadata" : "metadata repair"}`,
            );
            for (const r of s.refusals) console.log(`  Refused [${r.code}]: ${r.message}`);
            for (const q of s.metaAfter.queue)
                console.log(
                    `  Queued partial recomp ${q.start}-${q.end}, summary ${q.sequence}, gap ${q.gapStart}-${q.gapEnd}`,
                );
            console.log(
                `  Historical unrecoverable ordinal rows preserved: ${s.historicalNumbers.historianRuns} runs, ${s.historicalNumbers.userMemoryCandidates} memory candidates.`,
            );
            console.log(
                `  Unrecoverable missing-host archive entries preserved: ${s.unrecoverableArchiveEntries}.`,
            );
        }
        console.log("Read-only plan; no database rows changed.");
        return 0;
    } finally {
        host.close();
        db.close();
    }
}
