import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetHarnessForTesting, setHarness } from "../../shared/harness";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { sweepOrphanedOpenCodeMessageIndexes } from "./message-index";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    commitHostRunnerAnswer,
    commitHostRunnerExit,
    commitHostRunnerFence,
    commitHostRunnerPass,
    createHostRunnerState,
    HostRunnerDurabilityError,
    type HostRunnerEntry,
    type HostRunnerKey,
    type HostRunnerState,
    type HostRunnerView,
    hydrateHostRunnerRecord,
    installHostRunnerSchema,
    loadHostRunnerRecord,
} from "./storage-host-runner";
import { clearSession } from "./storage-meta-session";

const key = { session_id: "runner", harness: "opencode" };
const directories: string[] = [];
afterEach(() => {
    _resetHarnessForTesting();
    for (const directory of directories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(): string {
    const directory = createTestTempDirFromPath(join(tmpdir(), "host-runner-"));
    directories.push(directory);
    return join(directory, "context.db");
}

function entry(ordinal: number, overrides: Partial<HostRunnerEntry> = {}): HostRunnerEntry {
    return {
        ordinal,
        message_id: `m${ordinal}`,
        // Retain whitespace, escapes and non-ASCII admission bytes verbatim.
        ingest_json: `{ "info": {"id":"m${ordinal}"}, "parts": [{"text":"é\\nquoted \\"x\\""}] }`,
        hook_json: '{"prepend":"§7§ "}',
        op_version: 1,
        ingested: 1,
        race: 0,
        created_at: 1700000000000,
        ...overrides,
    };
}

function state(next = 4): HostRunnerState {
    return {
        ...createHostRunnerState("L1"),
        next_ordinal: next,
        served_through_ordinal: next - 1,
        cursor: next - 1,
        plan_json: '{"subscriptions":[]}',
        setup_json: '{"call_when":0.8}',
        unserved_json: '[{"subject_mid":"unavailable","hook":"pre_user"}]',
        bootstrap_refused_json: '{"code":"misconfigured","config":{"model":"test"}}',
        ordinal_divergence: 1,
    };
}

function view(version: number, to: number, lineage = "L1"): HostRunnerView {
    return {
        lineage_id: lineage,
        compaction_id: `c${version}`,
        version,
        range_from: 1,
        range_to: to,
        replacement_json: '[{"parts":[{"text":"frozen view"}]}]',
        coverage_json: '{"end_mid":"m2","ordinal":2}',
        state: "applied",
        applied_at: 1700000000001,
    };
}

function applyView(db: Database, version: number, to: number, k = key): void {
    const held = loadHostRunnerRecord(db, k)!.state;
    commitHostRunnerFence(db, k, `request-${version}`, held.next_ordinal - 1);
    const fenced = loadHostRunnerRecord(db, k)!.state;
    commitHostRunnerAnswer(db, k, {
        request_id: `request-${version}`,
        issued_newest: fenced.issued_newest!,
        state: fenced,
        view: view(version, to, fenced.lineage_id),
    });
}

function render(e: HostRunnerEntry): string {
    const message = JSON.parse(e.ingest_json);
    const ops = JSON.parse(e.hook_json);
    // Version 2 deliberately has different bytes, making accidental current-version hydration visible.
    message.parts[0].text = (e.op_version === 1 ? ops.prepend : "CURRENT ") + message.parts[0].text;
    return JSON.stringify(message);
}

function fixture(): Database {
    const db = new Database(":memory:");
    installHostRunnerSchema(db);
    return db;
}

describe("durable host runner", () => {
    test("append and hydrate preserve first-serve bytes with the recorded op version and null marker ordinals", () => {
        const db = fixture();
        try {
            const firstServe = '{"info":{"id":"m1"},"parts":[{"text":"§7§ é\\nquoted \\"x\\""}]}';
            const e = entry(1);
            commitHostRunnerPass(db, key, {
                state: state(2),
                entries: [e],
                elided: ["marker-user", "marker-assistant"],
            });
            const loaded = hydrateHostRunnerRecord(db, key, render)!;
            expect(loaded.entries[0]!.served).toBe(firstServe);
            expect(loaded.entries[0]!.ingest_json).toBe(e.ingest_json);
            expect(loaded.entries[0]!.hook_json).toBe(e.hook_json);
            expect(loaded.state).toEqual(state(2));
            expect([...loaded.ids]).toEqual([["m1", 1]]);
            expect([...loaded.elided].sort()).toEqual(["marker-assistant", "marker-user"]);
            expect(
                db
                    .prepare("SELECT ordinal FROM host_runner_ids WHERE message_id LIKE 'marker-%'")
                    .all(),
            ).toEqual([{ ordinal: null }, { ordinal: null }]);
        } finally {
            db.close();
        }
    });

    test("ordinary pass is one transaction and inserts only newly appended message payload", () => {
        const db = fixture();
        try {
            commitHostRunnerPass(db, key, {
                state: state(),
                entries: [entry(1), entry(2), entry(3, { race: 1 })],
            });
            // An UPDATE of a known payload would loudly refuse, even if bytes were unchanged.
            db.exec(
                "CREATE TRIGGER known_payload BEFORE UPDATE ON host_runner_entries BEGIN SELECT RAISE(ABORT, 'known payload rewritten'); END",
            );
            const exec = spyOn(db, "exec");
            const prepare = spyOn(db, "prepare");
            commitHostRunnerPass(db, key, { state: state(5), entries: [entry(4)] });
            expect(exec.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
            const sql = prepare.mock.calls.map(([sql]) => sql).join("\n");
            expect(sql).not.toMatch(/SELECT.*(ingest_json|hook_json)/);
            expect(sql.match(/INSERT INTO host_runner_entries/g)).toHaveLength(1);
            exec.mockRestore();
            prepare.mockRestore();
            expect(loadHostRunnerRecord(db, key)!.entries.map((e) => e.ordinal)).toEqual([
                1, 2, 3, 4,
            ]);
        } finally {
            db.close();
        }
    });

    test("prune retains covered ids and only two views; truncate descends and clamps the frontier", () => {
        const db = fixture();
        try {
            commitHostRunnerPass(db, key, {
                state: state(),
                entries: [entry(1), entry(2), entry(3, { race: 1 })],
                elided: ["marker"],
            });
            applyView(db, 1, 2);
            applyView(db, 2, 3);
            applyView(db, 3, 4);
            let record = loadHostRunnerRecord(db, key)!;
            expect(record.entries).toEqual([]);
            expect([...record.ids]).toEqual([
                ["m1", 1],
                ["m2", 2],
                ["m3", 3],
            ]);
            expect(record.views.map((v) => v.version)).toEqual([3, 2]);
            commitHostRunnerPass(db, key, {
                truncate_after: 2,
                state: {
                    ...record.state,
                    lineage_id: "L2",
                    ancestry_json: '[{"lineage_id":"L1","through_ordinal":2}]',
                    next_ordinal: 3,
                    served_through_ordinal: 2,
                    cursor: 2,
                },
            });
            record = loadHostRunnerRecord(db, key)!;
            expect(record.views[0]!.state).toBe("invalidated");
            expect(record.ids.has("m3")).toBe(false);
            expect(record.ids.get("m2")).toBe(2);
            expect(record.elided.has("marker")).toBe(true);
            // Reuse the truncated ordinal on a descended lineage, but not its removed id.
            commitHostRunnerPass(db, key, {
                state: { ...record.state, next_ordinal: 4, served_through_ordinal: 3 },
                entries: [entry(3, { message_id: "new" })],
            });
            expect(loadHostRunnerRecord(db, key)!.entries[0]!.message_id).toBe("new");
        } finally {
            db.close();
        }
    });

    test("raw-tail revert preserves surviving bytes and history-gap flags persist atomically", () => {
        const db = fixture();
        try {
            commitHostRunnerPass(db, key, {
                state: state(),
                entries: [entry(1), entry(2), entry(3)],
            });
            applyView(db, 1, 2);
            const before = loadHostRunnerRecord(db, key)!;
            commitHostRunnerPass(db, key, {
                truncate_after: 2,
                uningested_from: 2,
                state: {
                    ...before.state,
                    lineage_id: "L2",
                    next_ordinal: 3,
                    served_through_ordinal: 2,
                    cursor: 1,
                },
            });
            const after = loadHostRunnerRecord(db, key)!;
            expect(after.views[0]).toEqual(before.views[0]!);
            expect(after.entries).toEqual([{ ...before.entries[0]!, ingested: 0 }]);
            expect(after.ids.has("m3")).toBe(false);
            expect(render(after.entries[0]!)).toBe(render(before.entries[0]!));
        } finally {
            db.close();
        }
    });

    test("failed append rolls back the entire pass and throws a turn refusal, never raw passthrough", () => {
        const db = fixture();
        try {
            commitHostRunnerPass(db, key, { state: state(2), entries: [entry(1)] });
            const before = loadHostRunnerRecord(db, key);
            db.exec(
                "CREATE TRIGGER reject_append BEFORE INSERT ON host_runner_entries WHEN NEW.ordinal = 3 BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
            );
            let served = false;
            expect(() => {
                commitHostRunnerPass(db, key, {
                    state: state(4),
                    entries: [entry(2), entry(3)],
                    elided: ["marker"],
                });
                served = true;
            }).toThrow(HostRunnerDurabilityError);
            expect(served).toBe(false);
            expect(loadHostRunnerRecord(db, key)).toEqual(before);
        } finally {
            db.close();
        }
    });

    test("exit is durable before an exit pass and cannot silently resume the provider record", () => {
        const path = temporaryPath();
        let db = new Database(path);
        installHostRunnerSchema(db);
        commitHostRunnerPass(db, key, { state: state(2), entries: [entry(1)] });
        const exit = '{"reason":"provider_revert_ambiguous"}';
        db.exec(
            "CREATE TRIGGER reject_exit BEFORE UPDATE OF pipeline_exit_json ON host_runner_state BEGIN SELECT RAISE(ABORT, 'exit failure'); END",
        );
        let exitPassServed = false;
        expect(() => {
            commitHostRunnerExit(db, key, exit);
            exitPassServed = true;
        }).toThrow(HostRunnerDurabilityError);
        expect(exitPassServed).toBe(false);
        db.exec("DROP TRIGGER reject_exit");
        commitHostRunnerExit(db, key, exit);
        db.close();
        db = new Database(path);
        try {
            const held = loadHostRunnerRecord(db, key)!;
            expect(held.state.pipeline_exit_json).toBe(exit);
            expect(() => commitHostRunnerPass(db, key, { state: held.state })).toThrow(
                HostRunnerDurabilityError,
            );
            expect(() => commitHostRunnerFence(db, key, "fresh", 1)).toThrow(
                HostRunnerDurabilityError,
            );
            commitHostRunnerExit(db, key, exit); // idempotent same reason
        } finally {
            db.close();
        }
    });

    test("answer cannot precede its fence or use a superseded request", () => {
        const db = fixture();
        try {
            commitHostRunnerPass(db, key, {
                state: state(2),
                entries: [entry(1, { ingested: 0 })],
            });
            const unfenced = loadHostRunnerRecord(db, key)!.state;
            const forged = { ...unfenced, issued_request_id: "r1", issued_newest: 1 };
            expect(() =>
                commitHostRunnerAnswer(db, key, {
                    request_id: "r1",
                    issued_newest: 1,
                    state: forged,
                    view: view(1, 2),
                }),
            ).toThrow(HostRunnerDurabilityError);
            expect(() => commitHostRunnerPass(db, key, { state: forged })).toThrow(
                HostRunnerDurabilityError,
            );
            commitHostRunnerFence(db, key, "r1", 1);
            commitHostRunnerFence(db, key, "r2", 1);
            expect(() =>
                commitHostRunnerAnswer(db, key, {
                    request_id: "r1",
                    issued_newest: 1,
                    state: forged,
                    view: view(1, 2),
                }),
            ).toThrow(HostRunnerDurabilityError);
            expect(loadHostRunnerRecord(db, key)!.views).toEqual([]);
            const held = loadHostRunnerRecord(db, key)!.state;
            commitHostRunnerAnswer(db, key, {
                request_id: "r2",
                issued_newest: 1,
                state: { ...held, bootstrap_cursor: 1 },
                ingested_through: 1,
            });
            expect(loadHostRunnerRecord(db, key)!.state.bootstrap_cursor).toBe(1);
            expect(loadHostRunnerRecord(db, key)!.entries[0]!.ingested).toBe(1);
        } finally {
            db.close();
        }
    });

    test("session deletion and the real orphan sweep remove runner-only rows, scoped by harness", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        setHarness("opencode");
        const seed = (k: HostRunnerKey) => {
            commitHostRunnerPass(db, k, { state: state(2), entries: [entry(1)] });
            applyView(db, 1, 1, k);
        };
        try {
            seed(key);
            const other = { ...key, harness: "opencode2" };
            seed(other);
            clearSession(db, key.session_id);
            expect(loadHostRunnerRecord(db, key)).toBeNull();
            // clearSession is session-wide, while the sweep is harness-scoped.
            expect(loadHostRunnerRecord(db, other)).toBeNull();
            seed(key);
            seed(other);
            const result = sweepOrphanedOpenCodeMessageIndexes(
                db,
                () => {
                    const host = new Database(":memory:");
                    host.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
                    return host;
                },
                { now: 1700000000000, safetyAgeMs: 0, cooldownMs: 0 },
            );
            expect(result.deleted).toBe(1);
            expect(loadHostRunnerRecord(db, key)).toBeNull();
            expect(loadHostRunnerRecord(db, other)).not.toBeNull();
            for (const table of [
                "host_runner_entries",
                "host_runner_ids",
                "host_runner_views",
                "host_runner_state",
            ]) {
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE harness = 'opencode'`)
                        .get(),
                ).toEqual({ n: 0 });
            }
        } finally {
            db.close();
        }
    });

    for (const stage of ["entries", "fence", "receipt", "view"] as const) {
        test(`SIGKILL after ${stage} preserves only committed rebuild boundaries on restart without a provider`, () => {
            const path = temporaryPath();
            const storage = new URL("./storage-host-runner.ts", import.meta.url).pathname;
            const sqlite = new URL("../../shared/sqlite.ts", import.meta.url).pathname;
            const script = `
                import { Database } from ${JSON.stringify(sqlite)};
                import * as runner from ${JSON.stringify(storage)};
                const db = new Database(${JSON.stringify(path)});
                db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
                runner.installHostRunnerSchema(db);
                const key = ${JSON.stringify(key)};
                let state = runner.createHostRunnerState('L1');
                runner.commitHostRunnerPass(db, key, {state});
                runner.commitHostRunnerFence(db, key, 'initial', 0);
                state = runner.loadHostRunnerRecord(db, key).state;
                runner.commitHostRunnerAnswer(db, key, {request_id:'initial', issued_newest:0, state,
                    view:${JSON.stringify(view(1, 1))}});
                state = {...state, next_ordinal:2, served_through_ordinal:1};
                runner.commitHostRunnerPass(db, key, {state, entries:[${JSON.stringify(entry(1))}]});
                const kill = () => process.kill(process.pid, 'SIGKILL');
                if (${JSON.stringify(stage)} === 'entries') kill();
                runner.commitHostRunnerFence(db, key, 'rebuild', 1);
                if (${JSON.stringify(stage)} === 'fence') kill();
                state = runner.loadHostRunnerRecord(db, key).state;
                const answer = {request_id:'rebuild', issued_newest:1, state, view:${JSON.stringify(view(2, 2))}};
                if (${JSON.stringify(stage)} === 'receipt') kill();
                runner.commitHostRunnerAnswer(db, key, answer);
                kill();
            `;
            const child = Bun.spawnSync([process.execPath, "-e", script], {
                cwd: import.meta.dir,
                windowsHide: true,
            });
            expect(child.signalCode).toBe("SIGKILL");
            expect(child.stderr.toString()).toBe("");
            const db = new Database(path);
            try {
                const record = hydrateHostRunnerRecord(db, key, render)!;
                expect(record.state.served_through_ordinal).toBe(1);
                expect(record.state.issued_request_id).toBe(
                    stage === "entries" ? "initial" : "rebuild",
                );
                expect(record.views[0]!.version).toBe(stage === "view" ? 2 : 1);
                expect(record.entries.length).toBe(stage === "view" ? 0 : 1);
                if (stage !== "view") expect(record.entries[0]!.served).toBe(render(entry(1)));
                expect(record.ids.get("m1")).toBe(1);
            } finally {
                db.close();
            }
        });
    }
});
