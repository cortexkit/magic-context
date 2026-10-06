import { afterEach, beforeEach, expect, test } from "bun:test";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import { evaluateSmartNotes } from "../dreamer/evaluate-smart-notes";
import { acquireLease } from "../dreamer/lease";
import { addNote, getNotes } from "../storage-notes";
import {
    COMPILER_OUTPUT,
    HTTP_CHECK,
    TIMEOUT_URL,
    timeoutTestDatabase,
    withLocalHttpServer,
} from "./__tests__/http-timeout-fixture.test";
import { createSmartNoteCapabilities } from "./capabilities";
import { compileSmartNoteCheck } from "./compiler";
import { runDueCompiledSmartNoteChecks } from "./runner";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import { __wakePlaneTest } from "./wake-plane";

const PROJECT = "git:http-timeout";
const OWNER = "http-timeout-owner";
const LEASE = "http-timeout-lease";
let fixture: ReturnType<typeof timeoutTestDatabase>;

beforeEach(() => {
    __wakePlaneTest.reset();
    __wakePlaneTest.setCatalogProbe(async () => []);
    fixture = timeoutTestDatabase();
    expect(acquireLease(fixture.db, "holder", LEASE)).toBe(true);
});
afterEach(() => {
    fixture.dispose();
    __wakePlaneTest.reset();
});

function source() {
    return addNote(fixture.db, "smart", {
        projectPath: PROJECT,
        sessionId: OWNER,
        content: "watch remote state",
        surfaceCondition: "remote resource becomes ready",
    });
}
function state() {
    return getNotes(fixture.db, { type: "smart", projectPath: PROJECT })[0];
}
function notices() {
    return getNotes(fixture.db, { type: "session", sessionId: OWNER });
}
function carrier(): HiddenCompletionExecutor {
    return {
        capabilities: { tools: false, harness: "opencode2" },
        open: async () => ({ id: "fake-compiler" }),
        attempt: async () => {},
        collect: async () => ({
            text: COMPILER_OUTPUT,
            reasoning: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            lengthCapped: false,
        }),
        close: async () => {},
    };
}
function evaluate() {
    return evaluateSmartNotes({
        db: fixture.db,
        hiddenCompletionExecutor: carrier(),
        projectIdentity: PROJECT,
        parentSessionId: OWNER,
        sessionDirectory: process.cwd(),
        holderId: "holder",
        leaseKey: LEASE,
        deadline: Date.now() + 60_000,
    });
}
function capabilities(signal: AbortSignal) {
    return createSmartNoteCapabilities({ projectRoot: process.cwd(), signal });
}
function seedCompiled(id: number) {
    fixture.db
        .prepare(`UPDATE notes SET compiled_check=?, check_status='compiled', policy_version=1,
        check_next_due_at=0, check_quarantined_until=NULL WHERE id=?`)
        .run(HTTP_CHECK, id);
}

test("3-second local HTTP response completes compilation and normal evaluation", async () => {
    await withLocalHttpServer(3_000, async (requests) => {
        const note = source();
        const compiled = await compileSmartNoteCheck({
            hiddenCompletionExecutor: carrier(),
            parentSessionId: undefined,
            sessionDirectory: process.cwd(),
            projectIdentity: PROJECT,
            note,
            capabilityFactory: capabilities,
            signal: new AbortController().signal,
            deadline: Date.now() + 30_000,
        });
        expect(compiled).toMatchObject({ ok: true, dryRun: { met: false } });
        seedCompiled(note.id);
        expect(await evaluate()).toEqual({ surfaced: 0, pending: 1, ran: true });
        expect(state()).toMatchObject({
            checkStatus: "compiled",
            checkFailureCount: 0,
            checkNetworkFailureCount: 0,
        });
        expect(requests()).toBe(2);
    });
}, 20_000);

test("HTTP deadline retries compilation without spending fallback strikes", async () => {
    await withLocalHttpServer(null, async (requests) => {
        const note = source();
        // Existing logic strikes must not grow or trigger fallback on transport failure.
        fixture.db.prepare("UPDATE notes SET check_failure_count=2 WHERE id=?").run(note.id);
        for (let i = 0; i < 4; i++) {
            fixture.db.prepare("UPDATE notes SET check_next_due_at=0 WHERE id=?").run(note.id);
            const startedAt = Date.now();
            expect(await evaluate()).toEqual({ surfaced: 0, pending: 1, ran: true });
            expect(state()).toMatchObject({
                status: "pending",
                checkStatus: "uncompiled",
                checkFailureCount: 2,
                checkNetworkFailureCount: i + 1,
                readyReason: null,
            });
            expect(state().checkNextDueAt).toBeGreaterThanOrEqual(startedAt + 5 * 60_000);
            expect(notices()).toEqual([]);
        }
        expect(requests()).toBe(4);
    });
}, 30_000);

test("HTTP deadline retries scheduled checks without reauthoring or fallback", async () => {
    await withLocalHttpServer(null, async (requests) => {
        const note = source();
        for (let i = 0; i < 4; i++) {
            seedCompiled(note.id);
            const startedAt = Date.now();
            expect(
                await runDueCompiledSmartNoteChecks({
                    db: fixture.db,
                    projectIdentity: PROJECT,
                    projectRoot: process.cwd(),
                    leaseHeld: () => true,
                    sweepBudgetMs: 10_000,
                }),
            ).toEqual({ ran: 1, surfaced: 0, failed: 0, networkFailed: 1 });
            expect(state()).toMatchObject({
                status: "pending",
                checkStatus: "compiled",
                checkFailureCount: 0,
                checkNetworkFailureCount: i + 1,
                readyReason: null,
            });
            expect(state().checkNextDueAt).toBeGreaterThanOrEqual(startedAt + 5 * 60_000);
            expect(state().checkQuarantinedUntil).toBe(state().checkNextDueAt);
            expect(notices()).toEqual([]);
        }
        expect(requests()).toBe(4);
    });
}, 30_000);

test("sandbox deadline during HTTP is transient, not a logic strike", async () => {
    await withLocalHttpServer(null, async (requests) => {
        const startedAt = Date.now();
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: HTTP_CHECK,
            capabilityFactory: capabilities,
            timeoutMs: 100,
        });
        expect(result).toMatchObject({
            ok: false,
            cancelled: false,
            network: true,
            persistent: false,
        });
        if (result.ok || result.cancelled) throw new Error("expected transient HTTP failure");
        expect(result.retryAt).toBeGreaterThanOrEqual(startedAt + 5 * 60_000);
        expect(requests()).toBe(1);
    });
});

test("liveness HTTP deadline retries without spending logic strikes", async () => {
    await withLocalHttpServer(null, async (requests) => {
        const note = source();
        seedCompiled(note.id);
        const startedAt = Date.now();
        fixture.db
            .prepare(`UPDATE notes SET check_next_due_at=?, check_false_since_at=? WHERE id=?`)
            .run(startedAt + 60_000, startedAt - 8 * 24 * 60 * 60_000, note.id);
        expect(await evaluate()).toEqual({ surfaced: 0, pending: 1, ran: true });
        expect(state()).toMatchObject({
            checkStatus: "compiled",
            checkFailureCount: 0,
            checkNetworkFailureCount: 1,
            readyReason: null,
        });
        expect(state().checkNextDueAt).toBeGreaterThanOrEqual(startedAt + 5 * 60_000);
        expect(state().checkLastLivenessAt).toBeGreaterThanOrEqual(startedAt);
        expect(notices()).toEqual([]);
        expect(requests()).toBe(1);
    });
}, 10_000);

test("busy loops remain logic failures even after a completed HTTP request", async () => {
    await withLocalHttpServer(0, async (requests) => {
        for (const compiledCheck of [
            "function check() { while (true) {} }",
            `function check(cap) { cap.httpGet("${TIMEOUT_URL}"); while (true) {} }`,
        ]) {
            const result = await runCompiledSmartNoteCheck({
                compiledCheck,
                capabilityFactory: capabilities,
                timeoutMs: 100,
            });
            expect(result).toMatchObject({
                ok: false,
                cancelled: false,
                network: false,
                persistent: false,
            });
            if (result.ok || result.cancelled) throw new Error("expected execution failure");
            expect(result.retryAt).toBeUndefined();
        }
        expect(requests()).toBe(1);
    });
});

test("slow sweeps admit fewer notes instead of cutting the next request short", async () => {
    await withLocalHttpServer(3_000, async (requests) => {
        for (let i = 0; i < 3; i++) seedCompiled(source().id);
        const startedAt = Date.now();
        const result = await runDueCompiledSmartNoteChecks({
            db: fixture.db,
            projectIdentity: PROJECT,
            projectRoot: process.cwd(),
            leaseHeld: () => true,
            sweepBudgetMs: 10_000,
        });
        // Two 3-second checks fit an idle machine; a loaded runner may admit only
        // one. Either way no check is cut short and at least one note stays due.
        expect(result.ran === 1 || result.ran === 2).toBe(true);
        expect(result).toMatchObject({ surfaced: 0, failed: 0, networkFailed: 0 });
        expect(Date.now() - startedAt).toBeLessThan(10_000);
        expect(requests()).toBe(result.ran);
        const notes = getNotes(fixture.db, { type: "smart", projectPath: PROJECT });
        expect(notes.filter((n) => n.checkNextDueAt === 0)).toHaveLength(3 - result.ran);
    });
}, 20_000);
