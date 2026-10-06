import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as https from "node:https";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { addNote } from "../storage-notes";
import { createSmartNoteCapabilities } from "./capabilities";
import { runDueCompiledSmartNoteChecks } from "./runner";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import { guardedSmartNoteHttpGet } from "./ssrf-guard";
import {
    getStaleCompiledSmartNotes,
    markCompiledCheckNetworkFailure,
    markSmartNoteCompilationFailure,
} from "./storage";
import { SmartNoteNetworkError } from "./types";

const signal = new AbortController().signal;
const resolver = { lookup: async () => [{ address: "1.1.1.1", family: 4 as const }] };
const resource = "https://api.github.com/repos/owner/repo/releases/latest";

function get(status: number, parentStatus = 200) {
    return (url: string) =>
        guardedSmartNoteHttpGet(url, {
            signal,
            resolver,
            requestAddress: async (validation) => ({
                status: validation.url.pathname === "/repos/owner/repo" ? parentStatus : status,
                body: "{}",
            }),
        });
}

async function check(httpGet: ReturnType<typeof get>, code: string) {
    return runCompiledSmartNoteCheck({
        compiledCheck: code,
        capabilities: {
            ...createSmartNoteCapabilities({ projectRoot: process.cwd(), signal }),
            httpGet,
        },
    });
}

function fakeTransport(status: number, bytes: number, headers: Record<string, string> = {}) {
    let destroyed = false;
    let emittedBytes = 0;
    const spy = spyOn(https, "request").mockImplementation(((
        _options: unknown,
        callback: (response: unknown) => void,
    ) => {
        const response = Object.assign(new EventEmitter(), {
            statusCode: status,
            headers,
            destroy: () => {
                destroyed = true;
            },
        });
        const request = Object.assign(new EventEmitter(), {
            destroy: () => {
                destroyed = true;
            },
            end: () =>
                queueMicrotask(() => {
                    for (let sent = 0; sent < bytes && !destroyed; sent += 16384) {
                        const chunk = Buffer.alloc(Math.min(16384, bytes - sent), 97);
                        emittedBytes += chunk.byteLength;
                        response.emit("data", chunk);
                    }
                    if (!destroyed) response.emit("end");
                }),
        });
        callback(response);
        return request;
    }) as typeof https.request);
    return { spy, destroyed: () => destroyed, emittedBytes: () => emittedBytes };
}

test("default streamed cap accepts ordinary source documents above 64 KiB", async () => {
    const transport = fakeTransport(200, 77380);
    try {
        const response = await guardedSmartNoteHttpGet("https://example.test/source", {
            signal,
            resolver,
        });
        expect(Buffer.byteLength(response.body)).toBe(77380);
    } finally {
        transport.spy.mockRestore();
    }
});

test("default streamed cap cuts off bodies above 1 MiB with URL and size", async () => {
    const transport = fakeTransport(200, 2 * 1048576);
    try {
        const error = await guardedSmartNoteHttpGet("https://example.test/source", {
            signal,
            resolver,
        }).catch((e) => e);
        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect(error.persistent).toBe(true);
        expect(error.message).toContain(
            "https://example.test/source (received at least 1064960 bytes; limit 1048576)",
        );
        expect(transport.destroyed()).toBe(true);
        expect(transport.emittedBytes()).toBe(1064960);
    } finally {
        transport.spy.mockRestore();
    }
});

test("existing compiled checks throwing on readable-resource 404 return not met", async () => {
    expect(
        await check(
            get(404),
            `function check(cap) {
        var r = cap.httpGet("${resource}");
        if (r.status !== 200) throw new Error("HTTP request failed with status " + r.status);
        return {met: true};
    }`,
        ),
    ).toEqual({ ok: true, result: { met: false } });
});

test("deletion checks trust normal guest verdicts on readable-resource 404", async () => {
    expect(
        await check(
            get(404),
            `function check(cap) {
                return {met: cap.httpGet("${resource}").status === 404};
            }`,
        ),
    ).toEqual({ ok: true, result: { met: true } });
});

test("withdrawal checks trust normal guest verdicts on readable-resource 410", async () => {
    expect(
        await check(
            get(410),
            `function check(cap) {
                return {met: cap.httpGet("${resource}").status === 410};
            }`,
        ),
    ).toEqual({ ok: true, result: { met: true } });
});

test("private or missing repository and package containers are persistent access failures", async () => {
    for (const url of [
        resource,
        "https://raw.githubusercontent.com/owner/repo/main/file",
        "https://registry.npmjs.org/@scope%2fpkg/latest",
    ]) {
        const calls: string[] = [];
        const error = await guardedSmartNoteHttpGet(url, {
            signal,
            resolver,
            requestAddress: async (validation) => {
                calls.push(validation.url.href);
                return { status: 404, body: "" };
            },
        }).catch((e) => e);
        expect(error.persistent).toBe(true);
        expect(error.message).toContain("container is not publicly readable");
        expect(calls.length).toBe(2);
    }
});

test("access and transient statuses remain failures even if guest swallows them", async () => {
    for (const status of [401, 403, 451, 408, 429, 500, 503]) {
        const result = await check(
            get(status),
            `function check(cap) {
            try {cap.httpGet("${resource}");} catch(e) {}
            return {met:true};
        }`,
        );
        expect(result.ok).toBe(false);
        if (!result.ok && !result.cancelled) {
            expect(result.network).toBe(true);
            expect(result.persistent).toBe([401, 403, 451].includes(status));
        }
    }
});

test("timeouts remain transient even when compiled code catches them", async () => {
    const httpGet = (url: string) =>
        guardedSmartNoteHttpGet(url, {
            signal,
            resolver,
            timeoutMs: 10,
            requestAddress: async () => {
                await Bun.sleep(30);
                return { status: 200, body: "{}" };
            },
        });
    const result = await check(
        httpGet,
        `function check(cap) {
        try {cap.httpGet("${resource}");} catch(e) {}
        return {met:true};
    }`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && !result.cancelled) {
        expect(result.network).toBe(true);
        expect(result.persistent).toBe(false);
        expect(result.error).toContain("request timed out");
    }
});

test("readability probes retain SSRF validation and the original byte budget", async () => {
    const raw = "https://raw.githubusercontent.com/owner/repo/main/file";
    await expect(
        guardedSmartNoteHttpGet(raw, {
            signal,
            resolver: {
                lookup: async (host) => [
                    { address: host === "api.github.com" ? "127.0.0.1" : "1.1.1.1", family: 4 },
                ],
            },
            requestAddress: async () => ({ status: 404, body: "" }),
        }),
    ).rejects.toThrow("non-global/internal");
    const budgets: number[] = [];
    await expect(
        guardedSmartNoteHttpGet(resource, {
            signal,
            resolver,
            bodyLimitBytes: 10,
            requestAddress: async (_validation, _candidate, options) => {
                budgets.push(options.bodyLimitBytes);
                return { status: budgets.length === 1 ? 404 : 200, body: "abcdef" };
            },
        }),
    ).rejects.toThrow("response body too large");
    expect(budgets).toEqual([10, 4]);
});

test.each([401, 403, 429])("rate-limited HTTP %i respects primary reset hints", async (status) => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const transport = fakeTransport(status, 0, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
    });
    try {
        const result = await check(
            (url) => guardedSmartNoteHttpGet(url, { signal, resolver }),
            `function check(cap) {
            try {cap.httpGet("${resource}");} catch(e) {}
            return {met:true};
        }`,
        );
        expect(result.ok).toBe(false);
        if (!result.ok && !result.cancelled) {
            expect(result.network).toBe(true);
            expect(result.persistent).toBe(false);
            expect(result.retryAt).toBe(reset * 1000);
        }
        expect(transport.spy).toHaveBeenCalledTimes(1);
    } finally {
        transport.spy.mockRestore();
    }
});

test.each([
    401, 403, 429,
])("rate-limited HTTP %i respects secondary Retry-After hints", async (status) => {
    const now = Date.now();
    const transport = fakeTransport(status, 0, { "retry-after": "3600" });
    try {
        const error = await guardedSmartNoteHttpGet(resource, { signal, resolver }).catch((e) => e);
        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect(error.persistent).toBe(false);
        expect(error.retryAt).toBeGreaterThanOrEqual(now + 3600 * 1000);
        expect(transport.spy).toHaveBeenCalledTimes(1);
    } finally {
        transport.spy.mockRestore();
    }
});

test.each([401, 403])("HTTP %i without rate-limit signals is an access problem", async (status) => {
    const transport = fakeTransport(status, 0);
    try {
        const error = await guardedSmartNoteHttpGet(resource, { signal, resolver }).catch((e) => e);
        expect(error.persistent).toBe(true);
        expect(error.retryAt).toBeUndefined();
    } finally {
        transport.spy.mockRestore();
    }
});

test("rate-limit backoff fences scheduled and liveness checks without owner notices or reauthoring", () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        const now = Date.now();
        const retryAt = now + 3600 * 1000;
        const note = addNote(db, "smart", {
            projectPath: "git:rate-test",
            sessionId: "owner",
            content: "future",
            surfaceCondition: "release appears",
        });
        db.prepare(
            `UPDATE notes SET compiled_check='function check() {return {met:false};}',check_status='compiled',policy_version=1,check_false_since_at=? WHERE id=?`,
        ).run(now - 8 * 24 * 3600 * 1000, note.id);
        for (let i = 0; i < 4; i++) markCompiledCheckNetworkFailure(db, note.id, now, 3, retryAt);
        const state = db
            .prepare(
                "SELECT check_status,check_next_due_at,check_quarantined_until FROM notes WHERE id=?",
            )
            .get(note.id) as {
            check_status: string;
            check_next_due_at: number;
            check_quarantined_until: number;
        };
        expect(state.check_status).toBe("compiled");
        expect(state.check_next_due_at).toBeGreaterThanOrEqual(retryAt);
        expect(state.check_quarantined_until).toBeGreaterThanOrEqual(retryAt);
        expect(getStaleCompiledSmartNotes(db, "git:rate-test", now, 10)).toEqual([]);
        expect(
            getStaleCompiledSmartNotes(db, "git:rate-test", state.check_quarantined_until, 10),
        ).toHaveLength(1);
        for (let i = 0; i < 4; i++)
            markSmartNoteCompilationFailure(
                db,
                note.id,
                now,
                3,
                "rate limited",
                false,
                "owner",
                retryAt,
            );
        expect(db.prepare("SELECT check_status FROM notes WHERE id=?").get(note.id)).toEqual({
            check_status: "uncompiled",
        });
        expect(
            db
                .prepare(
                    "SELECT count(*) AS n FROM notes WHERE type='session' AND session_id='owner'",
                )
                .get(),
        ).toEqual({ n: 0 });
    } finally {
        closeQuietly(db);
    }
});

test("generic document absence needs no container probe", async () => {
    let calls = 0;
    const response = await guardedSmartNoteHttpGet("https://docs.test/future.md", {
        signal,
        resolver,
        requestAddress: async () => {
            calls++;
            return { status: 404, body: "" };
        },
    });
    expect(response.status).toBe(404);
    expect(calls).toBe(1);
});

test("persistent due-check access failure notifies owner once and keeps note pending", async () => {
    const db = new Database(":memory:");
    const transport = fakeTransport(403, 0);
    try {
        initializeDatabase(db);
        runMigrations(db);
        const note = addNote(db, "smart", {
            projectPath: "git:http-test",
            sessionId: "owner",
            content: "future",
            surfaceCondition: "release appears",
        });
        db.prepare(
            `UPDATE notes SET compiled_check=?,check_status='compiled',check_next_due_at=0 WHERE id=?`,
        ).run(
            'function check(cap) { cap.httpGet("https://1.1.1.1/future"); return {met:true}; }',
            note.id,
        );
        for (let i = 0; i < 2; i++) {
            db.prepare(
                "UPDATE notes SET check_status='compiled',check_next_due_at=0,check_quarantined_until=NULL WHERE id=?",
            ).run(note.id);
            const result = await runDueCompiledSmartNoteChecks({
                db,
                projectIdentity: "git:http-test",
                projectRoot: process.cwd(),
                leaseHeld: () => true,
            });
            expect(result.networkFailed).toBe(1);
        }
        expect(db.prepare("SELECT status FROM notes WHERE id=?").get(note.id)).toEqual({
            status: "pending",
        });
        expect(
            db
                .prepare(
                    "SELECT count(*) AS n FROM notes WHERE type='session' AND session_id='owner'",
                )
                .get(),
        ).toEqual({ n: 1 });
    } finally {
        transport.spy.mockRestore();
        closeQuietly(db);
    }
});
