import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiRescoreCarrier } from "../../../../pi-plugin/src/rescore-carrier";
import { createV1HiddenCompletionExecutor } from "../../hooks/magic-context/compartment-runner-historian";
import {
    HiddenCompletionRefusal,
    type HiddenRunIdentity,
} from "../../hooks/magic-context/compartment-runner-types";
import {
    createOpenCodeRescoreCarrier,
    driveRescore,
    recoverRescore,
    resumeRescore,
} from "../../hooks/magic-context/rescore-driver";
import { validateRescoreScores } from "../../hooks/magic-context/rescore-prompt";
import { projectCompartmentScores } from "../../hooks/magic-context/score-projection";
import { setKeepSubagents } from "../../shared/keep-subagents";
import { Database } from "../../shared/sqlite";
import { configureContextDatabasePragmas } from "../../shared/sqlite-context-pragmas";
import type { SubagentRunner } from "../../shared/subagent-runner";
import { childCreateInput } from "../../v2/hidden-child-record";
import { createV2HiddenCompletionExecutor, type HiddenChildHost } from "../../v2/hidden-completion";
import { HiddenChildHook, hiddenToolCallRefusal } from "../../v2/hooks/hidden-child";
import type { SessionContext } from "../../v2/hooks/types";
import type { StoreRow } from "../../v2/store-reader";
import { getCompartments } from "./compartment-storage";
import { runMigrations } from "./migrations";
import { RESCORE_HEARTBEAT_MS, type RescoreAdmission, RescoreService } from "./rescore-service";
import { initializeDatabase } from "./storage-db";

// These review assertions intentionally expose unfixed defects. Opt in explicitly
// so the ordinary package suite can still run independently of the review.
const review = process.env.MC_RESCORE_S4_REVIEW === "1" ? test : test.skip;
const dbs: Database[] = [];
const roots: string[] = [];
afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    setKeepSubagents(false);
});
const profile = { model: "mock/score", temperature: 0, maxOutputTokens: 1000 };
function fixture(fileBacked = false, harness = "opencode") {
    let path = ":memory:";
    if (fileBacked) {
        const parent = join(tmpdir(), "magic-context");
        // Fixtures never open the user's context.db.
        mkdirSync(parent, { recursive: true });
        const root = mkdtempSync(join(parent, "rescore-s4-review-"));
        roots.push(root);
        path = join(root, "context.db");
    }
    const db = new Database(path);
    dbs.push(db);
    db.exec("PRAGMA busy_timeout=5000");
    configureContextDatabasePragmas(db);
    initializeDatabase(db);
    runMigrations(db);
    let now = Date.now();
    const make = (connection = db, sessionId = "session", driver = harness) =>
        new RescoreService({
            db: connection,
            projectPath: "git:rescore-review",
            sessionId,
            harness: driver,
            profile,
            now: () => now,
            admissionFailure: () => null,
        });
    db.prepare(
        "INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES (?,?,?,?)",
    ).run("session", harness, "git:rescore-review", now);
    db.prepare(`INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,title,content,p1,p2,p3,p4,importance,episode_type,created_at,legacy)
        VALUES ('session',?,0,0,1,'title','','P1','P2','P3','P4',73,'feature',1,0)`).run(harness);
    const service = make();
    return {
        db,
        path,
        make,
        service,
        start: () => service.confirm(service.preview().snapshotId),
        advance: () => {
            now += 2 * RESCORE_HEARTBEAT_MS + 1;
        },
    };
}
function scores(admission: RescoreAdmission, importance = 42) {
    return JSON.stringify(
        Object.keys(JSON.parse(admission.attempt.handle_map)).map((handle) => ({
            handle,
            importance,
            reason: "brief private reason",
        })),
    );
}
function scalar(db: Database, table: string) {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function v1Carrier(
    f: ReturnType<typeof fixture>,
    text: string,
    finish = "stop",
    modelID = "score",
) {
    let retained = true;
    let prompts = 0;
    const client = {
        session: {
            create: async () => ({ data: { id: "durable-child" } }),
            prompt: async () => {
                prompts++;
                return {};
            },
            messages: async () => ({
                data: retained
                    ? [
                          {
                              info: {
                                  role: "assistant",
                                  id: "answer",
                                  finish,
                                  providerID: "mock",
                                  modelID,
                                  time: { created: 2, completed: 3 },
                              },
                              parts: [{ type: "text", text }],
                          },
                      ]
                    : [],
            }),
            delete: async () => {
                retained = false;
                return {};
            },
            abort: async () => ({}),
        },
    };
    const executor = createV1HiddenCompletionExecutor(client as never, f.db, "/project");
    return {
        carrier: createOpenCodeRescoreCarrier({
            executor,
            db: f.db,
            sessionId: "session",
            harness: "opencode",
            directory: "/project",
            timeoutMs: 1000,
        }),
        prompts: () => prompts,
        retained: () => retained,
    };
}

describe("rescore-s4-review findings", () => {
    review("F1 OpenCode completion survives a crash before payload staging", async () => {
        setKeepSubagents(false);
        const f = fixture();
        const old = f.start();
        const admission = f.service.admit(old)!;
        const transport = v1Carrier(f, scores(admission));
        const text = await transport.carrier.complete(
            admission,
            new AbortController().signal,
            (id) => f.service.recordCarrier(old, admission.attempt.id, id),
        );
        expect(JSON.parse(text)[0].importance).toBe(42);
        // The process stops here: the provider answered, but the driver has not
        // called persistPayload. Recovery must still be able to read that answer.
        f.advance();
        const current = f.service.takeover(old.jobId, old.generation)!;
        await recoverRescore(f.service, current, transport.carrier);
        expect(transport.prompts()).toBe(1);
        expect({
            revisions: scalar(f.db, "compartment_score_revisions"),
            attempt: f.service.status(old.jobId).attempts[0].state,
        }).toEqual({
            revisions: 1,
            attempt: "settled",
        });
    });

    review("F2 takeover and resume do not overlap a still-running Pi paid call", async () => {
        const f = fixture(true, "pi");
        const db2 = new Database(f.path);
        dbs.push(db2);
        const nextService = f.make(db2);
        const old = f.start();
        let release!: () => void;
        let started!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const inFlight = new Promise<void>((resolve) => {
            started = resolve;
        });
        let active = 0;
        let peak = 0;
        let calls = 0;
        const transport = createPiRescoreCarrier({
            sessionId: "session",
            directory: "/project",
            timeoutMs: 1000,
            runner: {
                run: async (options: Parameters<SubagentRunner["run"]>[0]) => {
                    calls++;
                    active++;
                    peak = Math.max(peak, active);
                    const candidates = JSON.parse(
                        options.userMessage.split("<candidates>\n")[1].split("\n</candidates>")[0],
                    );
                    const text = JSON.stringify(
                        candidates.map((candidate: { handle: string }) => ({
                            handle: candidate.handle,
                            importance: 42,
                            reason: "brief",
                        })),
                    );
                    try {
                        if (calls === 1) {
                            started();
                            let onAbort!: () => void;
                            const aborted = new Promise<never>((_, reject) => {
                                onAbort = () => reject(new Error("mock provider aborted"));
                                options.signal?.addEventListener("abort", onAbort, { once: true });
                                if (options.signal?.aborted) onAbort();
                            });
                            try {
                                await Promise.race([pending, aborted]);
                            } finally {
                                options.signal?.removeEventListener("abort", onAbort);
                            }
                        }
                        return { ok: true, assistantText: text };
                    } finally {
                        active--;
                    }
                },
            } as unknown as SubagentRunner,
        });
        const originalDrive = driveRescore(f.service, old, transport);
        await inFlight;
        try {
            f.advance();
            const current = nextService.takeover(old.jobId, old.generation)!;
            expect(current.generation).toBe(2);
            await resumeRescore(nextService, current, transport);
        } finally {
            release();
            await originalDrive;
        }
        expect(peak, `paid calls=${calls}; concurrent calls=${peak}`).toBe(1);
    });

    for (const [name, finish, modelID] of [
        ["F3 recovery rejects a length-capped score completion", "length", "score"],
        ["F3 recovery rejects a completion from outside the frozen model", "stop", "other-model"],
    ]) {
        review(name, async () => {
            const f = fixture();
            const old = f.start();
            const admission = f.service.admit(old)!;
            expect(f.service.recordCarrier(old, admission.attempt.id, "durable-child")).toBe(true);
            const transport = v1Carrier(f, scores(admission), finish, modelID);
            f.advance();
            const current = f.service.takeover(old.jobId, old.generation)!;
            await recoverRescore(f.service, current, transport.carrier);
            expect(transport.prompts()).toBe(0);
            expect(scalar(f.db, "compartment_score_revisions")).toBe(0);
        });
    }
});

describe("rescore-s4-review controls", () => {
    review("CONTROL OpenCode2 rescore refuses foreign and unstarted turns and all tools", () => {
        const hook = new HiddenChildHook(() => {});
        const draft = (id: string): SessionContext =>
            ({
                sessionID: id,
                agent: "rescore",
                model: { providerID: "mock", id: "score" },
                system: [],
                options: {},
                tools: { edit: { description: "", input: {} } },
                messages: [
                    { role: "user", content: [{ type: "text", text: "mc:hidden:unstarted" }] },
                ],
            }) as SessionContext;
        let modelCalls = 0;
        const dispatch = (id: string) => {
            hook.apply(draft(id));
            modelCalls++;
        };
        expect(() => dispatch("foreign-child")).toThrow("did not register");
        hook.registerChild("owned-child", "rescore");
        expect(() => dispatch("owned-child")).toThrow("unregistered prompt");
        expect(modelCalls).toBe(0);
        for (const id of ["foreign-child", "owned-child"]) {
            for (const tool of [
                "read",
                "grep",
                "glob",
                "edit",
                "write",
                "shell",
                "ctx_memory",
                "arbitrary-extension",
            ]) {
                expect(
                    hiddenToolCallRefusal({ sessionID: id, agent: "rescore", tool }, hook),
                ).toContain(`${tool} refused`);
            }
        }
        const identity: HiddenRunIdentity = {
            agent: "rescore",
            kind: "rescore",
            system: "score only",
            title: "rescore",
            directory: "/project",
            timeoutMs: 1000,
            model: "mock/score",
        };
        expect(
            childCreateInput(identity, "rescore", { providerID: "mock", modelID: "score" })
                .permissions,
        ).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
        const shaped = draft("owned-child");
        shaped.messages = [
            { role: "user", content: [{ type: "text", text: "registered-marker" }] },
        ];
        hook.registerAttempt("registered-marker", {
            childSessionId: "owned-child",
            identity,
            shaped: false,
            request: {
                path: { id: "owned-child" },
                body: {
                    parts: [{ type: "text", text: "calibrated scores" }],
                    tools: {},
                },
            },
        });
        expect(hook.apply(shaped)).toBe(true);
        expect(shaped.tools).toEqual({});
        expect(shaped.messages[0].content).toEqual([{ type: "text", text: "calibrated scores" }]);
        hook.releaseAttempt("registered-marker");
    });

    review(
        "CONTROL publish and undo leave seeded cache bytes epochs and materialization unchanged",
        () => {
            const f = fixture();
            f.db
                .prepare(`INSERT INTO session_meta(session_id,cached_m0_bytes,cached_m1_bytes,
            cached_m0_materialized_at,cached_m0_project_memory_epoch,cached_m0_score_selection_watermark,
            served_prefix,held_release,cached_m0_max_mutation_id,cached_m0_max_compartment_seq)
            VALUES ('session',X'6d302d66726f7a656e',X'6d312d66726f7a656e',123456,17,0,
            'frozen boundary sections','held',19,0)`)
                .run();
            f.db
                .prepare(
                    "INSERT INTO project_state(project_path,project_memory_epoch,updated_at) VALUES ('git:rescore-review',17,123)",
                )
                .run();
            f.db
                .prepare(
                    "INSERT INTO m0_mutation_log(id,session_id,mutation_type,target_id,queued_at) VALUES (19,'session','compartment_upgrade',1,123)",
                )
                .run();
            f.db
                .prepare(
                    "UPDATE compartment_history_versions SET version = 23, rewrite_version = 7, seeded = 1 WHERE session_id = 'session'",
                )
                .run();
            const tables = [
                "compartments",
                "session_meta",
                "project_state",
                "compartment_history_versions",
                "m0_mutation_log",
            ];
            const snapshot = () =>
                tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
            const before = snapshot();
            const authority = f.start();
            const admission = f.service.admit(authority)!;
            f.service.persistPayload(authority, admission.attempt.id, scores(admission));
            const receipt = f.service.publish(authority, admission.attempt.id);
            expect(
                projectCompartmentScores(
                    f.db,
                    "session",
                    getCompartments(f.db, "session"),
                    "latest",
                ).compartments[0].importance,
            ).toBe(42);
            expect(snapshot()).toEqual(before);
            expect(f.service.undoJob(authority.jobId)).toEqual({ undone: 1, unchanged: 0 });
            expect(
                projectCompartmentScores(
                    f.db,
                    "session",
                    getCompartments(f.db, "session"),
                    "latest",
                ).compartments[0].importance,
            ).toBe(73);
            expect(
                f.service.publish({ ...authority, generation: 999 }, admission.attempt.id),
            ).toEqual(receipt);
            expect(snapshot()).toEqual(before);
        },
    );

    review(
        "CONTROL malformed scores are rejected and mid-publication failure rolls back all writes",
        () => {
            for (const value of [0, 101, 1.5, "42", null]) {
                expect(() =>
                    validateRescoreScores(
                        JSON.stringify([{ handle: "h", importance: value, reason: "brief" }]),
                        ["h"],
                    ),
                ).toThrow();
            }
            for (const text of [
                "not-json",
                "[]",
                '[{"handle":"h","importance":42,"reason":"brief","extra":1}]',
                '[{"handle":"h","importance":42,"reason":"brief"},{"handle":"h","importance":43,"reason":"brief"}]',
            ]) {
                expect(() => validateRescoreScores(text, ["h"])).toThrow();
            }
            const f = fixture();
            f.db
                .prepare(`INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,title,content,p1,p2,p3,p4,importance,episode_type,created_at,legacy)
            VALUES ('session','opencode',2,2,3,'second','','P1','P2','P3','P4',73,'feature',1,0)`)
                .run();
            const authority = f.start();
            const admission = f.service.admit(authority)!;
            expect(Object.keys(JSON.parse(admission.attempt.handle_map))).toHaveLength(2);
            f.service.persistPayload(authority, admission.attempt.id, scores(admission));
            f.db.exec(`CREATE TRIGGER reject_second_revision BEFORE INSERT ON compartment_score_revisions
            WHEN (SELECT COUNT(*) FROM compartment_score_revisions) = 1
            BEGIN SELECT RAISE(ABORT, 'review publication fault'); END`);
            expect(() => f.service.publish(authority, admission.attempt.id)).toThrow(
                "review publication fault",
            );
            expect(scalar(f.db, "compartment_score_revisions")).toBe(0);
            expect(scalar(f.db, "compartment_score_selections")).toBe(0);
            expect(f.service.status(authority.jobId).attempts[0].state).toBe("admitted");
            f.db.exec("DROP TRIGGER reject_second_revision");
            expect(f.service.publish(authority, admission.attempt.id)?.state).toBe("published");
            expect(scalar(f.db, "compartment_score_revisions")).toBe(2);
        },
    );
});

review(
    "CONTROL independent OpenCode and Pi processes share reservations and takeover uses CAS",
    async () => {
        const f = fixture(true);
        const a = f.start();
        const pi = f.make(f.db, "session", "pi");
        const b = pi.confirm(pi.preview().snapshotId);
        const sqliteModule = new URL("../../shared/sqlite.ts", import.meta.url).pathname;
        const serviceModule = new URL("./rescore-service.ts", import.meta.url).pathname;
        const script = `
        const { Database } = await import(${JSON.stringify(sqliteModule)});
        const { RescoreService } = await import(${JSON.stringify(serviceModule)});
        const input = JSON.parse(process.env.MC_REVIEW_CHILD);
        const db = new Database(input.path);
        db.exec('PRAGMA busy_timeout=5000');
        const service = new RescoreService({ db, projectPath: 'git:rescore-review',
            sessionId: 'session', harness: input.harness, profile: input.profile,
            now: () => input.now, admissionFailure: () => null });
        try {
            const value = input.operation === 'admit' ? !!service.admit(input.authority)
                : service.takeover(input.authority.jobId, input.authority.generation);
            console.log(JSON.stringify({ value }));
        } catch (error) { console.log(JSON.stringify({ error: error.message })); }
        finally { db.close(); }
    `;
        const concurrently = async (
            operation: string,
            inputs: Array<{ harness: string; authority: typeof a }>,
            now = Date.now(),
        ) => {
            const children = inputs.map((input) =>
                Bun.spawn({
                    cmd: [process.execPath, "-e", script],
                    stdout: "pipe",
                    stderr: "pipe",
                    env: {
                        ...process.env,
                        MC_REVIEW_CHILD: JSON.stringify({
                            ...input,
                            operation,
                            path: f.path,
                            profile,
                            now,
                        }),
                    },
                }),
            );
            return Promise.all(
                children.map(async (child) => {
                    const [out, error, code] = await Promise.all([
                        new Response(child.stdout).text(),
                        new Response(child.stderr).text(),
                        child.exited,
                    ]);
                    expect(code, error).toBe(0);
                    return JSON.parse(out.trim()) as {
                        value?: boolean | { jobId: string; generation: number } | null;
                        error?: string;
                    };
                }),
            );
        };
        const admissions = await concurrently("admit", [
            { harness: "opencode", authority: a },
            { harness: "pi", authority: b },
        ]);
        expect(admissions.map((result) => result.error)).toEqual([undefined, undefined]);
        expect(admissions.map((result) => result.value).sort()).toEqual([false, true]);
        expect(scalar(f.db, "rescore_attempts")).toBe(1);
        const staleTime = Date.now() + 2 * RESCORE_HEARTBEAT_MS + 1000;
        const takeovers = await concurrently(
            "takeover",
            [
                { harness: "opencode", authority: a },
                { harness: "opencode", authority: a },
            ],
            staleTime,
        );
        expect(takeovers.filter((result) => result.value !== null)).toHaveLength(1);
        expect(f.service.status(a.jobId).job.owner_generation).toBe(2);
        const wrongHarness = await concurrently(
            "takeover",
            [{ harness: "pi", authority: { ...a, generation: 2 } }],
            staleTime + 2 * RESCORE_HEARTBEAT_MS + 1,
        );
        expect(wrongHarness[0].error).toContain("originating harness");
        expect(f.service.status(a.jobId).job.owner_generation).toBe(2);
    },
);

const hostReview = process.env.MC_RESCORE_S4_HOST === "1" ? test : test.skip;
hostReview(
    "CONTROL real OpenCode2 user edit allow loses to rescore session deny and unstarted turn makes no model call",
    async () => {
        const { OpenCode } = await import("@opencode/client");
        const { assertOpenPaths, CLI, ROOT_KEYS, spawnOpencode2, waitForPluginActive } =
            await import("../../../../e2e-tests/src/opencode2-runner/spawn");
        const parent = join(tmpdir(), "magic-context", "rescore-s4-review");
        mkdirSync(parent, { recursive: true });
        const root = realpathSync(mkdtempSync(join(parent, "host-")));
        roots.push(root);
        const env: NodeJS.ProcessEnv = {
            PATH: process.env.PATH,
            OPENCODE_DB: "opencode2.db",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
            TMPDIR: join(root, "tmp"),
        };
        mkdirSync(env.TMPDIR!);
        for (const key of ROOT_KEYS) {
            env[key] = join(root, key);
            mkdirSync(env[key]!);
        }
        env.CFFIXED_USER_HOME = env.HOME;
        env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "storage");
        env.MAGIC_CONTEXT_LOG_PATH = join(root, "magic-context.log");
        const cwd = join(root, "work");
        mkdirSync(cwd);
        const userConfig = join(env.XDG_CONFIG_HOME!, "opencode");
        mkdirSync(userConfig);
        writeFileSync(
            join(userConfig, "opencode.json"),
            JSON.stringify({
                permissions: [{ action: "edit", resource: "*", effect: "allow" }],
            }),
        );
        const host = await spawnOpencode2({
            existingIsolation: { root, env, cwd },
            magicContextConfig: { dreamer: { disable: true }, historian: { disable: true } },
        });
        try {
            const client = OpenCode.make({
                baseUrl: host.url,
                headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
            });
            await waitForPluginActive(client, cwd);
            const opened = execFileSync("lsof", ["-p", String(host.pid), "-Fn"], {
                encoding: "utf8",
            });
            const paths = opened
                .split("\n")
                .filter((line) => /^n.*\.db(?:-wal|-shm)?$/.test(line))
                .map((line) => line.slice(1));
            expect(paths.length).toBeGreaterThan(0);
            assertOpenPaths(paths, root);
            console.log(
                `rescore-s4-review host ${execFileSync(CLI, ["--version"], { env, encoding: "utf8" }).trim()} pid=${host.pid} lsof db=${JSON.stringify(paths)}`,
            );
            const info = await client.agent.get({
                agentID: "rescore",
                location: { directory: cwd },
            });
            const rules = info.data.permissions;
            const deny = rules.findIndex((rule) => rule.action === "*" && rule.effect === "deny");
            const allow = rules.findLastIndex(
                (rule) => rule.action === "edit" && rule.effect === "allow",
            );
            expect(deny).toBeGreaterThanOrEqual(0);
            expect(allow).toBeGreaterThan(deny);
            const unguarded = await client.session.create({
                title: "foreign rescore",
                agent: "rescore",
                location: { directory: cwd },
                model: { providerID: "openai", id: "mock-model" },
            });
            const allowed = await client.permission.create({
                sessionID: unguarded.id,
                agent: "rescore",
                action: "edit",
                resources: [join(cwd, "file.txt")],
            });
            expect(allowed.effect).toBe("allow");
            const input = childCreateInput(
                {
                    kind: "rescore",
                    agent: "rescore",
                    title: "rescore",
                    system: "score only",
                    directory: cwd,
                    timeoutMs: 1000,
                },
                "rescore",
                { providerID: "openai", modelID: "mock-model" },
            );
            const child = await client.session.create(input);
            const denied = await client.permission.create({
                sessionID: child.id,
                agent: "rescore",
                action: "edit",
                resources: [join(cwd, "file.txt")],
            });
            expect(denied.effect).toBe("deny");
            let modelCalls = 0;
            host.mock.addMatcher((body) => {
                if (JSON.stringify(body).includes("mc:hidden:review-unstarted")) modelCalls++;
                return null;
            });
            await client.session
                .prompt({ sessionID: child.id, text: "mc:hidden:review-unstarted" })
                .catch(() => {});
            await client.session.wait({ sessionID: child.id });
            expect(modelCalls).toBe(0);
        } finally {
            await host.stop();
        }
    },
    60_000,
);

review(
    "CONTROL OpenCode2 unshaped rescore refuses without a second model or tool-enabled child",
    async () => {
        const f = fixture();
        const authority = f.start();
        const admission = f.service.admit(authority)!;
        let creates = 0;
        let prompts = 0;
        let row: StoreRow<"assistant"> | undefined;
        const host: HiddenChildHost = {
            create: async (input) => {
                creates++;
                expect(input.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
                return { id: "unshaped-child" };
            },
            get: async () => ({
                model: { providerID: "mock", id: "score" },
                location: { directory: "/project" },
            }),
            switchModel: async () => {},
            prompt: async () => {
                prompts++;
                // Simulate a host that skipped the registered context hook entirely.
                row = {
                    id: "answer",
                    session_id: "unshaped-child",
                    type: "assistant",
                    seq: 1,
                    data: {
                        finish: "stop",
                        content: [{ type: "text", text: scores(admission) }],
                        model: { providerID: "mock", id: "score" },
                        time: { created: 1, completed: 2 },
                    },
                };
            },
            wait: async () => {},
            interrupt: async () => ({ interrupted: true }),
            update: async () => {},
            removeSession: async () => {},
        };
        const executor = await createV2HiddenCompletionExecutor(host, {
            db: f.db,
            projectIdentity: "git:rescore-review",
            directory: "/project",
            hook: new HiddenChildHook(() => {}),
            openReader: () => ({
                latestSequence: () => row?.seq ?? -1,
                latestAssistant: () => row,
                latestIdle: () => undefined,
            }),
        });
        const carrier = createOpenCodeRescoreCarrier({
            executor,
            db: f.db,
            sessionId: "session",
            harness: "opencode",
            directory: "/project",
            timeoutMs: 1000,
        });
        let error: unknown;
        try {
            await carrier.complete(admission, new AbortController().signal, (id) =>
                f.service.recordCarrier(authority, admission.attempt.id, id),
            );
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(HiddenCompletionRefusal);
        expect((error as HiddenCompletionRefusal).code).toBe("hidden_prompt_unrecognized");
        expect({ creates, prompts }).toEqual({ creates: 1, prompts: 1 });
    },
);
