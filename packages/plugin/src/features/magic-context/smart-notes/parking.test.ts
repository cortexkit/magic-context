import { afterEach, beforeEach, expect, test } from "bun:test";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import { Database } from "../../../shared/sqlite";
import { createCtxNoteTools } from "../../../tools/ctx-note/tools";
import { evaluateSmartNotes } from "../dreamer/evaluate-smart-notes";
import { acquireLease } from "../dreamer/lease";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { addNote, dismissNote, getNotes } from "../storage-notes";
import { localSmartNoteHttpTransport } from "./__tests__/http-timeout-fixture.test";
import { createSmartNoteCapabilities } from "./capabilities";
import { compileSmartNoteCheck } from "./compiler";
import { runDueCompiledSmartNoteChecks } from "./runner";
import {
    getDueCompiledSmartNoteChecks,
    getSmartNotesNeedingCompilation,
    getStaleCompiledSmartNotes,
} from "./storage";
import { __wakePlaneTest } from "./wake-plane";

const PROJECT = "git:parking-test";
const OWNER = "parking-owner";
const URL = "https://api.github.com/repos/cortexkit/wernicke/contents/schema.sql";
const PRIVATE_CHECK = `function check(cap) { cap.httpGet("${URL}"); return {met:false}; }`;
const FAR_FUTURE = Date.now() + 365 * 24 * 3600 * 1000;
const context = { sessionID: OWNER, directory: process.cwd() } as never;
let db: Database;
let restoreTransport: (() => Promise<void>) | undefined;

beforeEach(() => {
    __wakePlaneTest.reset();
    __wakePlaneTest.setCatalogProbe(async () => []);
    db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(OWNER);
    expect(acquireLease(db, "holder", "parking-lease")).toBe(true);
});
afterEach(async () => {
    await restoreTransport?.();
    restoreTransport = undefined;
    db.close();
    __wakePlaneTest.reset();
});

async function transport(status: number, headers: Record<string, string> = {}) {
    const fixture = await localSmartNoteHttpTransport("api.github.com", (_request, response) => {
        response.writeHead(status, headers);
        response.end();
    });
    restoreTransport = fixture.dispose;
    return fixture.paths;
}

function carrier(check = PRIVATE_CHECK) {
    let calls = 0;
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode2" },
        open: async () => ({ id: "parking-compiler" }),
        attempt: async () => {
            calls++;
        },
        collect: async () => ({
            text: JSON.stringify({
                compiled_check: check,
                manifest: { capabilities: [] },
                check_cron: "*/15 * * * *",
            }),
            reasoning: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            lengthCapped: false,
        }),
        close: async () => {},
    };
    return { executor, calls: () => calls };
}

function note() {
    return addNote(db, "smart", {
        projectPath: PROJECT,
        sessionId: OWNER,
        content: "watch schema",
        surfaceCondition: "schema appears in cortexkit/wernicke",
    });
}
function state() {
    return getNotes(db, { type: "smart", projectPath: PROJECT })[0];
}
function notices() {
    return getNotes(db, { type: "session", sessionId: OWNER, status: ["active", "dismissed"] });
}
function tools() {
    return createCtxNoteTools({ db, resolveProjectPath: () => PROJECT }).ctx_note;
}
function sweep(executor: HiddenCompletionExecutor) {
    return evaluateSmartNotes({
        db,
        hiddenCompletionExecutor: executor,
        projectIdentity: PROJECT,
        parentSessionId: OWNER,
        sessionDirectory: process.cwd(),
        holderId: "holder",
        leaseKey: "parking-lease",
        deadline: Date.now() + 30_000,
    });
}
function seedCompiled(id: number, liveness = false, check = PRIVATE_CHECK) {
    db.prepare(`UPDATE notes SET compiled_check=?, check_status='compiled', policy_version=1,
        check_quarantined_until=NULL, check_next_due_at=?, check_false_since_at=? WHERE id=?`).run(
        check,
        liveness ? FAR_FUTURE : 0,
        Date.now() - 8 * 24 * 3600 * 1000,
        id,
    );
}

test.each([
    "compile",
    "due",
    "liveness",
])("private-repo %s failure parks with one owner notice and no later sweep", async (phase) => {
    const paths = await transport(404);
    const source = note();
    if (phase !== "compile") seedCompiled(source.id, phase === "liveness");
    const compiler = carrier();
    expect(await sweep(compiler.executor)).toMatchObject({ surfaced: 0, pending: 1, ran: true });
    expect(paths).toEqual([
        "/repos/cortexkit/wernicke/contents/schema.sql",
        "/repos/cortexkit/wernicke",
    ]);
    expect(state()).toMatchObject({
        status: "pending",
        checkStatus: "parked",
        checkNextDueAt: null,
    });
    expect(state().readyReason).toContain("source container is not publicly readable");
    expect(notices()).toHaveLength(1);
    expect(notices()[0].content).toContain(`Smart note #${source.id} cannot be checked.`);
    expect(notices()[0].content).toContain("not publicly readable");
    expect(getNotes(db, { type: "session", sessionId: "other-owner" })).toEqual([]);
    const read = await tools().execute({ action: "read" }, context);
    expect(read).toContain("parked");
    expect(read).toContain("not publicly readable");
    expect(await tools().execute({ action: "read", note_ids: [source.id] }, context)).toContain(
        "not publicly readable",
    );
    // A content-only edit and notice dismissal do not opt back into network checks.
    await tools().execute(
        { action: "update", note_ids: [source.id], content: "watch the schema later" },
        context,
    );
    dismissNote(db, notices()[0].id, { sessionId: OWNER, projectPath: PROJECT });
    expect(getSmartNotesNeedingCompilation(db, PROJECT, FAR_FUTURE, 10)).toEqual([]);
    expect(getDueCompiledSmartNoteChecks(db, PROJECT, FAR_FUTURE, 10)).toEqual([]);
    expect(getStaleCompiledSmartNotes(db, PROJECT, FAR_FUTURE, 10)).toEqual([]);
    // A compiler-policy bump or missing old code must not bypass the parked fence.
    db.prepare("UPDATE notes SET policy_version=0, compiled_check=NULL WHERE id=?").run(source.id);
    expect(getSmartNotesNeedingCompilation(db, PROJECT, FAR_FUTURE, 10)).toEqual([]);
    expect(await sweep(compiler.executor)).toEqual({ surfaced: 0, pending: 1, ran: false });
    expect(
        await runDueCompiledSmartNoteChecks({
            db,
            projectIdentity: PROJECT,
            projectRoot: process.cwd(),
            now: FAR_FUTURE,
            leaseHeld: () => true,
        }),
    ).toEqual({ ran: 0, surfaced: 0, failed: 0, networkFailed: 0 });
    expect(paths).toHaveLength(2);
    expect(compiler.calls()).toBe(phase === "compile" ? 1 : 0);
    expect(notices()).toHaveLength(1);
});

test("ctx_note condition update un-parks and recompiles without the old reason", async () => {
    // A stored parked note must round-trip through the existing text columns.
    const source = note();
    db.prepare(
        "UPDATE notes SET check_status='parked', ready_reason=?, compiled_check=? WHERE id=?",
    ).run(
        "Condition can't be checked: source is not publicly readable; rewrite it",
        PRIVATE_CHECK,
        source.id,
    );
    expect(state().checkStatus).toBe("parked");
    expect(
        await tools().execute(
            {
                action: "update",
                note_ids: [source.id],
                surface_condition: "ready.txt exists locally",
            },
            context,
        ),
    ).toContain("Updated");
    expect(state()).toMatchObject({
        status: "pending",
        checkStatus: "uncompiled",
        compiledCheck: null,
        readyReason: null,
        checkNextDueAt: null,
    });
    expect(getSmartNotesNeedingCompilation(db, PROJECT, Date.now(), 10).map((n) => n.id)).toEqual([
        source.id,
    ]);
    const compiler = carrier("function check() { return {met:false}; }");
    expect(await sweep(compiler.executor)).toEqual({ surfaced: 0, pending: 1, ran: true });
    expect(state()).toMatchObject({ checkStatus: "compiled", readyReason: null });
    expect(compiler.calls()).toBe(1);
    expect(notices()).toEqual([]);
});

test.each([
    401, 403,
])("rate-limited HTTP %i remains transient through compilation and evaluation", async (status) => {
    const reset = Math.floor(Date.now() / 1000) + 7200;
    await transport(status, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
    const source = note();
    const compiler = carrier();
    const result = await compileSmartNoteCheck({
        hiddenCompletionExecutor: compiler.executor,
        parentSessionId: undefined,
        sessionDirectory: process.cwd(),
        projectIdentity: PROJECT,
        note: source,
        capabilityFactory: (signal) =>
            createSmartNoteCapabilities({ projectRoot: process.cwd(), signal }),
        signal: new AbortController().signal,
        deadline: Date.now() + 30_000,
    });
    expect(result).toMatchObject({
        ok: false,
        persistent: false,
        uncheckable: false,
        retryAt: reset * 1000,
    });
    await sweep(compiler.executor);
    expect(state()).toMatchObject({
        checkStatus: "uncompiled",
        readyReason: null,
        checkNextDueAt: reset * 1000,
    });
    // Even repeated quota failures must not fall back to compilation or owner repair.
    seedCompiled(source.id);
    for (let i = 0; i < 4; i++) {
        db.prepare(
            "UPDATE notes SET check_next_due_at=0, check_quarantined_until=NULL WHERE id=?",
        ).run(source.id);
        await runDueCompiledSmartNoteChecks({
            db,
            projectIdentity: PROJECT,
            projectRoot: process.cwd(),
            leaseHeld: () => true,
        });
    }
    expect(state()).toMatchObject({
        checkStatus: "compiled",
        readyReason: null,
        checkNextDueAt: reset * 1000,
        checkQuarantinedUntil: reset * 1000,
    });
    expect(getDueCompiledSmartNoteChecks(db, PROJECT, reset * 1000 - 1, 10)).toEqual([]);
    expect(getDueCompiledSmartNoteChecks(db, PROJECT, reset * 1000, 10)).toHaveLength(1);
    seedCompiled(source.id, true);
    await sweep(compiler.executor);
    expect(state()).toMatchObject({
        checkStatus: "compiled",
        readyReason: null,
    });
    // Compilation quota failures now join the network backoff counter rather
    // than spending logic strikes. That accumulated backoff may exceed the reset hint.
    expect(state().checkNextDueAt).toBeGreaterThanOrEqual(reset * 1000);
    expect(state().checkFailureCount).toBe(0);
    expect(getStaleCompiledSmartNotes(db, PROJECT, Date.now(), 10)).toEqual([]);
    expect(notices()).toEqual([]);
});

test.each([
    401, 403,
])("HTTP %i without quota signals parks instead of reauthoring", async (status) => {
    await transport(status);
    note();
    await sweep(carrier().executor);
    expect(state()).toMatchObject({ checkStatus: "parked", checkNextDueAt: null });
    expect(state().readyReason).toContain(`HTTP ${status}`);
    expect(notices()).toHaveLength(1);
});

test("older compiled code-search checks park without attempting a request", async () => {
    const paths = await transport(200);
    const source = note();
    seedCompiled(
        source.id,
        false,
        'function check(cap) { var url = "https://api.github.com/search/" + "code?q=schema"; cap.httpGet(url); return {met:true}; }',
    );
    await sweep(carrier().executor);
    expect(paths).toEqual([]);
    expect(state()).toMatchObject({ status: "pending", checkStatus: "parked" });
    expect(state().readyReason).toContain("GitHub code search requires authentication");
    expect(notices()).toHaveLength(1);
});

test("compiler refuses GitHub code search before fetching even in an unexecuted branch", async () => {
    const paths = await transport(200);
    const source = note();
    const compiler = carrier(
        'function check(cap) { if (false) cap.httpGet("https://api.github.com/search/code?q=repo:cortexkit/wernicke+schema"); return {met:false}; }',
    );
    const result = await compileSmartNoteCheck({
        hiddenCompletionExecutor: compiler.executor,
        parentSessionId: undefined,
        sessionDirectory: process.cwd(),
        projectIdentity: PROJECT,
        note: source,
        capabilityFactory: (signal) =>
            createSmartNoteCapabilities({ projectRoot: process.cwd(), signal }),
        signal: new AbortController().signal,
        deadline: Date.now() + 30_000,
    });
    expect(result).toMatchObject({ ok: false, persistent: true, uncheckable: true });
    if (!result.ok) expect(result.error).toContain("GitHub code search requires authentication");
    expect(paths).toEqual([]);
    await sweep(compiler.executor);
    expect(state().checkStatus).toBe("parked");
    expect(state().readyReason).toContain("GitHub code search requires authentication");
    expect(notices()).toHaveLength(1);
});
