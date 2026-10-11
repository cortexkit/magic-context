import { afterEach, describe, expect, test } from "bun:test";
import {
    driveRescore,
    type RescoreCarrier,
    recoverRescore,
    resumeRescore,
} from "../../hooks/magic-context/rescore-driver";
import {
    RESCORE_PROMPT_HASH,
    RESCORE_SYSTEM_PROMPT,
    validateRescoreScores,
} from "../../hooks/magic-context/rescore-prompt";
import { Database } from "../../shared/sqlite";
import { getCompartments } from "./compartment-storage";
import { HISTORIAN_REFERENCE_FIX_SHIPPED_AT } from "./rescore-identity";
import {
    parseRescoreCommand,
    RESCORE_FAILED_BATCH_PAUSE,
    RESCORE_HEARTBEAT_MS,
    type RescoreAdmission,
    type RescoreAuthority,
    type RescoreModelProfile,
    RescoreService,
} from "./rescore-service";
import { initializeDatabase } from "./storage-db";

const dbs: Database[] = [];
afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
});
const profile: RescoreModelProfile = {
    model: "mock/score",
    variant: "low",
    temperature: 0,
    maxOutputTokens: 1000,
};
function fixture(n = 1, admissionFailure: (prompt: string) => string | null = () => null) {
    const db = new Database(":memory:");
    dbs.push(db);
    initializeDatabase(db);
    let now = Date.now();
    const projectPath = "git:rescore";
    const make = (harness = "opencode", frozenProfile = profile) =>
        new RescoreService({
            db,
            projectPath,
            sessionId: "session",
            harness,
            profile: frozenProfile,
            now: () => now,
            admissionFailure,
        });
    const addSession = (session = "session", harness = "opencode", project = projectPath) =>
        db
            .prepare(
                "INSERT OR IGNORE INTO session_projects(session_id,harness,project_path,updated_at) VALUES (?,?,?,?)",
            )
            .run(session, harness, project, now);
    const add = (
        sequence: number,
        session = "session",
        createdAt = 1,
        p1 = `P1-${sequence}`,
        legacy = 0,
    ) => {
        addSession(session);
        db.prepare(`INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,p2,p3,p4,importance,episode_type,created_at,legacy)
            VALUES (?,'opencode',?,?,?,? ,? ,?, '', ?, 'P2','P3','P4',73,'feature',?,?)`).run(
            session,
            sequence,
            sequence * 2,
            sequence * 2 + 1,
            `start-${sequence}`,
            `end-${sequence}`,
            `title-${sequence}`,
            p1,
            createdAt,
            legacy,
        );
    };
    for (let i = 0; i < n; i++) add(i * 2);
    const service = make();
    const start = () => service.confirm(service.preview().snapshotId);
    return {
        db,
        service,
        make,
        add,
        addSession,
        start,
        advance: () => {
            now += 2 * RESCORE_HEARTBEAT_MS + 1;
        },
    };
}
function scores(admission: RescoreAdmission, importance = 73) {
    return JSON.stringify(
        Object.keys(JSON.parse(admission.attempt.handle_map)).map((handle) => ({
            handle,
            importance,
            reason: "private recall duration",
        })),
    );
}
function publish(
    service: RescoreService,
    authority: RescoreAuthority,
    admission: RescoreAdmission,
    importance = 73,
) {
    expect(
        service.persistPayload(authority, admission.attempt.id, scores(admission, importance)),
    ).toBe(true);
    return service.publish(authority, admission.attempt.id);
}
function count(db: Database, table: string) {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function carrier(complete: RescoreCarrier["complete"]): RescoreCarrier {
    return {
        complete,
        async recover() {
            return null;
        },
        async interrupt() {},
    };
}

describe("rescore preview and packing", () => {
    test("grammar refuses bare confirm and invalid controls before any work", () => {
        expect(parseRescoreCommand("")).toEqual({ kind: "preview", project: false });
        expect(parseRescoreCommand("--project")).toEqual({ kind: "preview", project: true });
        expect(parseRescoreCommand("confirm frozen-id")).toEqual({
            kind: "confirm",
            snapshotId: "frozen-id",
        });
        for (const text of [
            "confirm",
            "confirm id extra",
            "--force",
            "resume model",
            "undo 1",
            "undo 1 0",
        ])
            expect(() => parseRescoreCommand(text)).toThrow("ctx-rescore");
    });
    test("eligibility ignores the fix date, reports harness cutoff counts, excludes empty legacy and markers", () => {
        const f = fixture(0);
        f.db
            .prepare("UPDATE rescore_activation SET activated_at = ? WHERE id = 1")
            .run(HISTORIAN_REFERENCE_FIX_SHIPPED_AT + 1000);
        f.add(0, "session", HISTORIAN_REFERENCE_FIX_SHIPPED_AT - 1);
        f.add(2, "session", HISTORIAN_REFERENCE_FIX_SHIPPED_AT + 1);
        f.add(4, "session", HISTORIAN_REFERENCE_FIX_SHIPPED_AT + 1000);
        f.add(6, "session", 1, "", 0);
        f.add(8, "session", 1, "legacy", 1);
        f.add(10, "dormant");
        f.addSession("dormant", "pi");
        f.add(12, "foreign");
        f.db
            .prepare(
                "UPDATE session_projects SET project_path = 'git:foreign' WHERE session_id = 'foreign'",
            )
            .run();
        const preview = f.service.preview(true);
        expect(preview.eligible).toBe(3);
        expect(preview.postFix).toBe(1);
        expect(preview.sessions).toEqual(["dormant", "session"]);
        expect(preview.postActivationByHarness).toEqual({ opencode: 1 });
        expect(preview.disclosure).toContain("no version provenance");
    });
    test("snapshot supersession, profile changes and added dormant sessions refuse confirmation", () => {
        const f = fixture();
        const old = f.service.preview(true);
        const current = f.service.preview(true);
        expect(() => f.service.confirm(old.snapshotId)).toThrow("superseded");
        expect(() =>
            f.make("opencode", { ...profile, temperature: 0.2 }).confirm(current.snapshotId),
        ).toThrow("profile");
        f.add(2, "new-dormant");
        expect(() => f.service.confirm(current.snapshotId)).toThrow("outside snapshot");
        expect(count(f.db, "rescore_jobs")).toBe(0);
    });
    test("changed snapshot sources become stale without replacement on confirmation", () => {
        const f = fixture();
        const preview = f.service.preview();
        f.db.prepare("UPDATE compartments SET p1 = 'changed'").run();
        const authority = f.service.confirm(preview.snapshotId);
        expect(f.service.admit(authority)).toBeNull();
        expect(f.service.status(authority.jobId).counts.stale).toBe(1);
    });
    test("opaque candidates withhold score, ids, sequence and timestamps; neighbours get underfilled calls", () => {
        const f = fixture(0);
        f.add(99112233, "session", 88112233, "Candidate-only-sentinel");
        f.add(99112234, "session", 88112234, "Other candidate");
        f.db.prepare("UPDATE compartments SET title = 'neutral title', id = id + 77112232").run();
        const authority = f.start();
        const first = f.service.admit(authority)!;
        const json = first.prompt.split("<candidates>\n")[1].split("\n</candidates>")[0];
        expect(json).not.toContain("99112233");
        expect(json).not.toContain("88112233");
        expect(json).not.toContain("77112233");
        expect(json).not.toContain("importance");
        expect(json).not.toContain('"id"');
        expect(Object.keys(JSON.parse(first.attempt.handle_map))).toHaveLength(1);
        expect(first.attempt.prompt_hash).toBe(RESCORE_PROMPT_HASH);
        publish(f.service, authority, first);
        const second = f.service.admit(authority)!;
        expect(Object.keys(JSON.parse(second.attempt.handle_map))).toHaveLength(1);
        expect(second.attempt.prompt_hash).toBe(first.attempt.prompt_hash);
        expect(second.attempt.seed_ids).not.toBe(first.attempt.seed_ids);
        publish(f.service, authority, second);
        expect(f.service.status(authority.jobId).job.state).toBe("complete");
        expect(RESCORE_SYSTEM_PROMPT).not.toContain("never updated");
    });
    test("packs at most 20 and singleton complete admission reserves seeds and output", () => {
        const f = fixture(41);
        const authority = f.start();
        const admission = f.service.admit(authority)!;
        expect(Object.keys(JSON.parse(admission.attempt.handle_map))).toHaveLength(20);
        const g = fixture(1, (prompt) =>
            prompt.includes("<compartment_examples_from_other_projects>")
                ? "complete request too large"
                : null,
        );
        const other = g.start();
        expect(g.service.status(other.jobId).counts.oversize).toBe(1);
        expect(g.service.admit(other)).toBeNull();
        expect(count(g.db, "rescore_attempts")).toBe(0);
        expect(g.service.resume(other)).toBe(false);
    });
    test("rejects all malformed score payloads without exposing reasons", () => {
        for (const value of [
            "not-json",
            "[]",
            '[{"handle":"h","importance":101,"reason":"secret"}]',
            '[{"handle":"x","importance":50,"reason":"secret"}]',
            '[{"handle":"h","importance":50,"reason":"line\\nline"}]',
            '[{"handle":"h","importance":50,"reason":"secret","extra":1}]',
        ])
            expect(() => validateRescoreScores(value, ["h"])).toThrow();
        expect(
            validateRescoreScores('[{"handle":"h","importance":1,"reason":"brief"}]', ["h"])[0]
                .importance,
        ).toBe(1);
    });
});

describe("rescore durable lifecycle", () => {
    test("receipt-first 20-item publication preserves base/cache tables and undo survives redelivery", () => {
        const f = fixture(20);
        const authority = f.start();
        const admission = f.service.admit(authority)!;
        const tables = [
            "compartments",
            "compartment_history_versions",
            "session_meta",
            "m0_mutation_log",
            "session_facts",
            "compartment_state_lease",
        ];
        const before = tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
        const receipt = publish(f.service, authority, admission);
        expect(count(f.db, "compartment_score_revisions")).toBe(20);
        expect(count(f.db, "compartment_score_selections")).toBe(20);
        expect(tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
        expect(f.service.undoJob(authority.jobId)).toEqual({ undone: 20, unchanged: 0 });
        const log = f.db.prepare("SELECT * FROM compartment_score_selections").all();
        expect(f.service.publish({ ...authority, generation: 999 }, admission.attempt.id)).toEqual(
            receipt,
        );
        expect(f.db.prepare("SELECT * FROM compartment_score_selections").all()).toEqual(log);
        expect(f.service.preview().eligible).toBe(0);
        expect(getCompartments(f.db, "session").every((row) => row.importance === 73)).toBe(true);
        expect(f.db.prepare("SELECT payload FROM rescore_attempts").get()).toEqual({
            payload: null,
        });
    });
    test("one raced source publishes 19 items; all-stale publication returns the original receipt", () => {
        const f = fixture(20);
        const authority = f.start();
        const a = f.service.admit(authority)!;
        f.db.prepare("UPDATE compartments SET p1 = 'recompacted' WHERE id = 1").run();
        const receipt = publish(f.service, authority, a, 42);
        expect(f.service.publish(authority, a.attempt.id)).toEqual(receipt);
        expect(count(f.db, "compartment_score_revisions")).toBe(19);
        expect(f.service.status(authority.jobId).counts.stale).toBe(1);
        expect(f.service.undoJob(authority.jobId).undone).toBe(19);
        const g = fixture();
        const b = g.start();
        const call = g.service.admit(b)!;
        g.db.prepare("DELETE FROM compartments").run();
        const stale = publish(g.service, b, call);
        expect(g.service.publish({ ...b, generation: 0 }, call.attempt.id)).toEqual(stale);
        expect(count(g.db, "compartment_score_selections")).toBe(0);
    });
    test("failed leftovers pause instead of completing and explicit resume retries only failed items", () => {
        const f = fixture(21);
        const authority = f.start();
        publish(f.service, authority, f.service.admit(authority)!);
        const last = f.service.admit(authority)!;
        f.service.fail(authority, last.attempt.id, {
            class: "credentials",
            message: "Missing key",
        });
        let status = f.service.status(authority.jobId);
        expect(status.job.state).toBe("paused");
        expect(status.job.consecutive_failed_batches).toBe(1);
        expect(status.counts.failed).toBe(1);
        expect(f.make("pi").status(authority.jobId).job.last_error).toContain("Missing key");
        expect(f.service.admit(authority)).toBeNull();
        expect(f.service.resume(authority)).toBe(true);
        const retry = f.service.admit(authority)!;
        expect(Object.keys(JSON.parse(retry.attempt.handle_map))).toHaveLength(1);
        expect(retry.attempt.id).not.toBe(last.attempt.id);
        publish(f.service, authority, retry);
        status = f.service.status(authority.jobId);
        expect(status.job.state).toBe("complete");
    });
    test("invalid payload settles failed without retry or leaking reasons", async () => {
        const f = fixture();
        const authority = f.start();
        let calls = 0;
        await driveRescore(
            f.service,
            authority,
            carrier(async () => {
                calls++;
                return "secret model output";
            }),
        );
        const status = f.service.status(authority.jobId);
        expect(calls).toBe(1);
        expect(status.attempts[0].state).toBe("settled");
        expect(status.attempts[0].outcome).toBe("failed");
        expect(status.job.last_error).toContain("invalid-payload");
        expect(status.job.last_error).not.toContain("secret");
        expect(status.job.state).toBe("paused");
    });
    test("failure threshold auto-pauses, persists error and resumes a new attempt", async () => {
        const f = fixture(81);
        const authority = f.start();
        let calls = 0;
        await driveRescore(
            f.service,
            authority,
            carrier(async () => {
                calls++;
                throw new Error("Missing provider credential");
            }),
        );
        expect(calls).toBe(RESCORE_FAILED_BATCH_PAUSE);
        const status = f.make("pi").status(authority.jobId);
        expect(status.job.state).toBe("auto-paused");
        expect(status.job.last_error).toContain("credential");
        expect(f.service.admit(authority)).toBeNull();
        expect(f.service.resume(authority)).toBe(true);
        expect(f.service.status(authority.jobId).job.consecutive_failed_batches).toBe(0);
        expect(f.service.admit(authority)).not.toBeNull();
    });
    test("published batches reset consecutive failures", () => {
        const f = fixture(141);
        const authority = f.start();
        const fail = () =>
            f.service.fail(authority, f.service.admit(authority)!.attempt.id, {
                class: "provider",
                message: "no",
            });
        fail();
        fail();
        publish(f.service, authority, f.service.admit(authority)!);
        fail();
        fail();
        expect(f.service.status(authority.jobId).job.consecutive_failed_batches).toBe(2);
        expect(f.service.status(authority.jobId).job.state).toBe("running");
    });
    test("overlapping jobs defer, name blocker, skip accepted scores and stay paused until resume", () => {
        const f = fixture();
        const a = f.start();
        const b = f.service.confirm(f.service.preview(true).snapshotId);
        const call = f.service.admit(a)!;
        expect(f.service.admit(b)).toBeNull();
        expect(f.service.status(b.jobId).job.blocking_job_id).toBe(a.jobId);
        expect(f.service.status(b.jobId).job.state).toBe("paused");
        publish(f.service, a, call);
        expect(f.service.admit(b)).toBeNull();
        f.service.resume(b);
        expect(f.service.admit(b)).toBeNull();
        expect(f.service.status(b.jobId).job.state).toBe("complete");
        expect(f.service.status(b.jobId).counts.skipped).toBe(1);
    });
    test("cancel cuts off persisted payload and releases overlap reservation", () => {
        const f = fixture();
        const a = f.start();
        const call = f.service.admit(a)!;
        f.service.persistPayload(a, call.attempt.id, scores(call));
        f.service.cancel(a.jobId);
        expect(f.service.publish(a, call.attempt.id)?.state).toBe("cancelled");
        expect(count(f.db, "compartment_score_selections")).toBe(0);
        const b = f.start();
        expect(f.service.admit(b)).not.toBeNull();
        expect(
            f.db.prepare("SELECT payload FROM rescore_attempts WHERE id = ?").get(call.attempt.id),
        ).toEqual({ payload: null });
    });
    test("single-compartment undo validates foreign and unknown revisions before writing", () => {
        const f = fixture(2);
        const authority = f.start();
        publish(f.service, authority, f.service.admit(authority)!);
        const before = count(f.db, "compartment_score_selections");
        expect(() => f.service.undoCompartment(1, 999999)).toThrow("revision");
        const foreign = (
            f.db
                .prepare("SELECT id FROM compartment_score_revisions WHERE compartment_id = 2")
                .get() as { id: number }
        ).id;
        expect(() => f.service.undoCompartment(1, foreign)).toThrow("foreign");
        expect(count(f.db, "compartment_score_selections")).toBe(before);
        f.service.undoCompartment(1, null);
        expect(f.service.undoJob(authority.jobId)).toEqual({ undone: 1, unchanged: 1 });
    });
});

describe("rescore owner authority and crash recovery", () => {
    test("atomic takeover rebinds admitted attempt; stale failure, heartbeat and payload change nothing", () => {
        const f = fixture();
        const old = f.start();
        const call = f.service.admit(old)!;
        f.service.recordCarrier(old, call.attempt.id, "durable-child");
        expect(f.service.takeover(old.jobId, old.generation)).toBeNull();
        f.advance();
        expect(f.make("pi").status(old.jobId).job.state).toBe("interrupted");
        const current = f.service.takeover(old.jobId, old.generation)!;
        expect(current.generation).toBe(2);
        expect(f.service.status(old.jobId).attempts[0].owner_generation).toBe(2);
        const before = ["rescore_jobs", "rescore_items", "rescore_attempts"].map((table) =>
            f.db.prepare(`SELECT * FROM ${table}`).all(),
        );
        expect(f.service.heartbeat(old)).toBe(false);
        expect(
            f.service.fail(old, call.attempt.id, { class: "old-driver", message: "late error" }),
        ).toBeNull();
        expect(f.service.persistPayload(old, call.attempt.id, scores(call))).toBe(false);
        expect(f.service.admit(old)).toBeNull();
        expect(
            ["rescore_jobs", "rescore_items", "rescore_attempts"].map((table) =>
                f.db.prepare(`SELECT * FROM ${table}`).all(),
            ),
        ).toEqual(before);
        expect(f.service.persistPayload(current, call.attempt.id, scores(call))).toBe(true);
        expect(f.service.publish(current, call.attempt.id)?.state).toBe("published");
    });
    test("stale-generation admission places no call and creates no attempt", async () => {
        const f = fixture();
        const old = f.start();
        f.advance();
        const current = f.service.takeover(old.jobId, old.generation)!;
        f.service.resume(current);
        let calls = 0;
        await driveRescore(
            f.service,
            old,
            carrier(async (request) => {
                calls++;
                return scores(request);
            }),
        );
        expect(calls).toBe(0);
        expect(count(f.db, "rescore_attempts")).toBe(0);
        expect(f.service.status(current.jobId).job.owner_generation).toBe(2);
    });
    test("persisted payload recovery publishes once without a second call", async () => {
        const f = fixture();
        const old = f.start();
        const call = f.service.admit(old)!;
        f.service.persistPayload(old, call.attempt.id, scores(call));
        f.advance();
        const current = f.service.takeover(old.jobId, old.generation)!;
        let recovered = 0;
        let calls = 0;
        const transport = {
            ...carrier(async () => {
                calls++;
                return "";
            }),
            async recover() {
                recovered++;
                return null;
            },
        };
        await recoverRescore(f.service, current, transport);
        await recoverRescore(f.service, current, transport);
        expect(recovered).toBe(0);
        expect(calls).toBe(0);
        expect(count(f.db, "compartment_score_selections")).toBe(1);
        expect(f.service.status(old.jobId).attempts[0].state).toBe("settled");
    });
    test("OpenCode child recovery persists private reasons; Pi abandonment refuses late subprocess result", async () => {
        const f = fixture();
        const old = f.start();
        const call = f.service.admit(old)!;
        f.service.recordCarrier(old, call.attempt.id, "finished-child");
        f.advance();
        const current = f.service.takeover(old.jobId, old.generation)!;
        let recoveries = 0;
        await recoverRescore(f.service, current, {
            ...carrier(async () => {
                throw new Error("must not call");
            }),
            async recover(id) {
                expect(id).toBe("finished-child");
                recoveries++;
                return scores(call);
            },
        });
        expect(recoveries).toBe(1);
        expect(count(f.db, "compartment_score_revisions")).toBe(1);
        const g = fixture();
        const previous = g.start();
        const admitted = g.service.admit(previous)!;
        g.advance();
        const owner = g.service.takeover(previous.jobId, previous.generation)!;
        await recoverRescore(
            g.service,
            owner,
            carrier(async () => "never"),
        );
        expect(g.service.status(owner.jobId).attempts[0].state).toBe("abandoned");
        expect(g.service.persistPayload(previous, admitted.attempt.id, scores(admitted))).toBe(
            false,
        );
        expect(g.service.publish(previous, admitted.attempt.id)?.state).toBe("abandoned");
        expect(count(g.db, "compartment_score_selections")).toBe(0);
        expect(count(g.db, "rescore_attempts")).toBe(1);
        expect(g.service.resume(owner)).toBe(true);
        expect(g.service.admit(owner)!.attempt.id).not.toBe(admitted.attempt.id);
    });
    test("publication lease wait stages payload durably and cancel clears it", async () => {
        const f = fixture();
        const authority = f.start();
        const call = f.service.admit(authority)!;
        f.db
            .prepare(
                "INSERT INTO compartment_state_lease(session_id,holder_id,owner_pid,acquired_at,expires_at) VALUES ('session','recomp',1,0,?)",
            )
            .run(Date.now() + 100_000);
        f.service.persistPayload(authority, call.attempt.id, scores(call));
        expect(f.service.publish(authority, call.attempt.id)?.state).toBe("waiting");
        expect(f.make("pi").status(authority.jobId).waitingForLease).toBe(true);
        expect(f.db.prepare("SELECT payload FROM rescore_attempts").get()).not.toEqual({
            payload: null,
        });
        f.db.prepare("DELETE FROM compartment_state_lease").run();
        await recoverRescore(
            f.service,
            authority,
            carrier(async () => {
                throw new Error("no call");
            }),
        );
        expect(count(f.db, "compartment_score_selections")).toBe(1);
    });
    test("resume preserves frozen targets and refuses a changed harness or model", () => {
        const f = fixture();
        const authority = f.start();
        f.service.pause(authority);
        f.add(4, "dormant-after-preview");
        expect(f.make("pi").resume(authority)).toBe(false);
        expect(f.make("opencode", { ...profile, model: "mock/other" }).resume(authority)).toBe(
            false,
        );
        expect(f.service.resume(authority)).toBe(true);
        const call = f.service.admit(authority)!;
        expect(Object.keys(JSON.parse(call.attempt.handle_map))).toHaveLength(1);
        expect(call.profile.model).toBe(profile.model);
    });
});

test("project snapshot covers dormant mixed harnesses without crossing canonical ownership", async () => {
    const f = fixture(0);
    for (let index = 0; index < 45; index++) {
        const session = `dormant-${index}`;
        f.add(0, session);
        if (index % 2) {
            f.addSession(session, "pi");
            f.db
                .prepare("UPDATE compartments SET harness = 'pi' WHERE session_id = ?")
                .run(session);
        }
    }
    f.add(9, "dormant-0");
    f.db.prepare("UPDATE compartments SET harness = 'omp' WHERE sequence = 9").run();
    f.addSession("dormant-0", "omp", "git:other");
    const preview = f.service.preview(true);
    expect(preview.eligible).toBe(45);
    expect(preview.sessions).toHaveLength(45);
    expect(preview.estimatedCalls).toBe(3);
    const authority = f.service.confirm(preview.snapshotId);
    let calls = 0;
    await driveRescore(
        f.service,
        authority,
        carrier(async (admission) => {
            calls++;
            return scores(admission);
        }),
    );
    expect(calls).toBe(3);
    expect(f.service.status(authority.jobId).job.state).toBe("complete");
    expect(count(f.db, "compartment_score_revisions")).toBe(45);
    expect(f.db.prepare("SELECT importance FROM compartments WHERE sequence = 9").get()).toEqual({
        importance: 73,
    });
});

test("failed source changes become stale on resume, while oversize stays unsent", () => {
    const f = fixture(2, (prompt) => (prompt.includes("OVERSIZE") ? "too large" : null));
    f.db.prepare("UPDATE compartments SET p1 = 'OVERSIZE' WHERE id = 2").run();
    const authority = f.start();
    const call = f.service.admit(authority)!;
    f.service.fail(authority, call.attempt.id, { class: "model", message: "failed" });
    f.db.prepare("UPDATE compartments SET p1 = 'changed' WHERE id = 1").run();
    f.service.resume(authority);
    expect(f.service.admit(authority)).toBeNull();
    const status = f.service.status(authority.jobId);
    expect(status.counts.oversize).toBe(1);
    expect(status.counts.stale).toBe(1);
    expect(status.job.state).toBe("complete");
    expect(count(f.db, "rescore_attempts")).toBe(1);
});

test("explicit resume recovers admitted spend before retrying an abandoned Pi item once", async () => {
    const f = fixture();
    const old = f.start();
    const call = f.service.admit(old)!;
    f.advance();
    const authority = f.service.takeover(old.jobId, old.generation)!;
    let calls = 0;
    expect(
        await resumeRescore(
            f.service,
            authority,
            carrier(async (admission) => {
                calls++;
                return scores(admission);
            }),
        ),
    ).toBe(true);
    expect(calls).toBe(1);
    expect(count(f.db, "rescore_attempts")).toBe(2);
    expect(count(f.db, "compartment_score_selections")).toBe(1);
    expect(
        f.service.status(authority.jobId).attempts.find((attempt) => attempt.id === call.attempt.id)
            ?.state,
    ).toBe("abandoned");
    expect(f.service.status(authority.jobId).job.state).toBe("complete");
});
