/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test";
import { createDreamerOutputCapSampler } from "../../config/live-child-output-cap";
import { runMigrations } from "../../features/magic-context/migrations";
import { RescoreService } from "../../features/magic-context/rescore-service";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    type PromptArgs,
    promptSyncWithModelSuggestionRetry,
} from "../../shared/model-suggestion-retry";
import { recordPromptSessionError } from "../../shared/prompt-async-transport";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createV1HiddenCompletionExecutor } from "./compartment-runner-historian";
import type { HiddenRunIdentity } from "./compartment-runner-types";
import { createOpenCodeRescoreCarrier, driveRescore } from "./rescore-driver";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

/** A host whose child finishes on the first status poll after a prompt_async send. */
function host() {
    const messages: unknown[] = [];
    const promptAsync = mock(async () => {
        messages.push(
            { info: { id: "msg_user", role: "user", time: { created: 1 } }, parts: [] },
            {
                info: {
                    id: "msg_final",
                    role: "assistant",
                    time: { created: 2, completed: 3 },
                    finish: "stop",
                },
                parts: [{ type: "text", text: "<classify/>" }],
            },
        );
        return { data: undefined };
    });
    const prompt = mock(async () => ({}));
    return {
        client: {
            session: {
                create: async () => ({ data: { id: "ses-child" } }),
                promptAsync,
                prompt,
                status: async () => ({ data: {} }),
                messages: async () => ({ data: [...messages] }),
                delete: async () => ({}),
            },
        } as never,
        promptAsync,
        prompt,
    };
}

function run(kind: HiddenRunIdentity["kind"]): HiddenRunIdentity {
    return {
        agent: "dreamer-classifier",
        kind,
        system: "system",
        timeoutMs: 60_000,
        title: "child",
        directory: "/repo",
    };
}

const request = {
    path: { id: "ses-child" },
    query: { directory: "/repo" },
    body: { parts: [{ type: "text", text: "go" }] },
};

describe("OpenCode 1 hidden executor transport", () => {
    test("a dreamer task child sends with prompt_async instead of a held request", async () => {
        const db = freshDb();
        try {
            const h = host();
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("dreamer-task"));

            await executor.attempt(handle, request);

            expect(h.promptAsync).toHaveBeenCalledTimes(1);
            expect(h.prompt).not.toHaveBeenCalled();
        } finally {
            closeQuietly(db);
        }
    });

    test("a historian child sends with prompt_async instead of a held request", async () => {
        const db = freshDb();
        try {
            const h = host();
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));

            await executor.attempt(handle, request);

            expect(h.promptAsync).toHaveBeenCalledTimes(1);
            expect(h.prompt).not.toHaveBeenCalled();
        } finally {
            closeQuietly(db);
        }
    });
});

/**
 * A host whose held requests die on a short request timer, standing in for the
 * Bun fetch timer (300-360 s) that some OpenCode 1 builds leave on the plugin's
 * client. The child's run takes `runMs`; `Infinity` never finishes.
 */
function slowHost(options: { runMs: number; hostRequestTimerMs: number }) {
    const messages: unknown[] = [];
    let running = false;
    let finish: ReturnType<typeof setTimeout> | undefined;
    const startRun = () => {
        running = true;
        messages.push({ info: { id: "msg_user", role: "user", time: { created: 1 } }, parts: [] });
        if (Number.isFinite(options.runMs)) {
            finish = setTimeout(() => {
                running = false;
                messages.push({
                    info: {
                        id: "msg_final",
                        role: "assistant",
                        time: { created: 2, completed: 3 },
                        finish: "stop",
                    },
                    parts: [{ type: "text", text: "<output/>" }],
                });
            }, options.runMs);
        }
    };
    const prompt = mock(async () => {
        startRun();
        await Bun.sleep(options.hostRequestTimerMs);
        if (running) throw new DOMException("The operation timed out.", "TimeoutError");
        return {};
    });
    const promptAsync = mock(async () => {
        startRun();
        return { data: undefined };
    });
    const abort = mock(async () => {
        running = false;
        clearTimeout(finish);
        return { data: true };
    });
    return {
        client: {
            session: {
                create: async () => ({ data: { id: "ses-child" } }),
                prompt,
                promptAsync,
                abort,
                status: async () => ({
                    data: running ? { "ses-child": { type: "busy" } } : {},
                }),
                messages: async () => ({ data: [...messages] }),
                delete: async () => ({}),
            },
        } as never,
        prompt,
        promptAsync,
        abort,
        stop: () => clearTimeout(finish),
    };
}

describe("OpenCode 1 historian under a host request timer", () => {
    test("a run that outlasts the host's request timer still completes within the historian timeout", async () => {
        const db = freshDb();
        const h = slowHost({ runMs: 1_500, hostRequestTimerMs: 100 });
        try {
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));
            // The same wiring runHistorianPrompt uses: the retry chain owns the
            // configured timeout and sends through the executor.
            await promptSyncWithModelSuggestionRetry(h.client, request, {
                transport: Object.assign((args: PromptArgs) => executor.attempt(handle, args), {
                    childSessionId: handle.childSessionId,
                }),
                timeoutMs: 10_000,
                callContext: "historian",
            });
            const completion = await executor.collect(handle, 50);

            expect(completion.text).toBe("<output/>");
            expect(h.abort).not.toHaveBeenCalled();
        } finally {
            h.stop();
            closeQuietly(db);
        }
    });

    test("a run that outlasts the configured historian timeout is aborted", async () => {
        const db = freshDb();
        const h = slowHost({ runMs: Number.POSITIVE_INFINITY, hostRequestTimerMs: 60_000 });
        try {
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));
            const startedAt = Date.now();

            await expect(
                promptSyncWithModelSuggestionRetry(h.client, request, {
                    transport: Object.assign((args: PromptArgs) => executor.attempt(handle, args), {
                        childSessionId: handle.childSessionId,
                    }),
                    timeoutMs: 400,
                    callContext: "historian",
                }),
            ).rejects.toThrow("prompt timed out after 400ms");

            expect(Date.now() - startedAt).toBeLessThan(5_000);
            expect(h.abort).toHaveBeenCalledWith({ path: { id: "ses-child" } });
        } finally {
            h.stop();
            closeQuietly(db);
        }
    });

    test("a provider error the host records ends a historian attempt without throwing", async () => {
        const db = freshDb();
        const h = slowHost({ runMs: Number.POSITIVE_INFINITY, hostRequestTimerMs: 60_000 });
        try {
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            const handle = await executor.open(run("historian"));
            h.promptAsync.mockImplementationOnce(async () => {
                setTimeout(() => {
                    recordPromptSessionError("ses-child", {
                        name: "APIError",
                        data: { message: "overloaded" },
                    });
                }, 50);
                return { data: undefined };
            });

            // Resolves like the synchronous prompt did, so the historian's retry
            // loop does not send the prompt into this child a second time.
            await executor.attempt(handle, request);
            expect(h.promptAsync).toHaveBeenCalledTimes(1);
        } finally {
            h.stop();
            closeQuietly(db);
        }
    });
});

describe("OpenCode 1 score carrier", () => {
    test("host score errors settle failed with no fallback or second model", async () => {
        const db = freshDb();
        const h = slowHost({ runMs: Number.POSITIVE_INFINITY, hostRequestTimerMs: 60_000 });
        try {
            db.prepare(
                "INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES ('session','opencode','git:score',0)",
            ).run();
            db.prepare(`INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,importance,legacy,created_at)
                VALUES ('session',1,1,2,'m1','m2','Title','','P1',50,0,1)`).run();
            const service = new RescoreService({
                db,
                projectPath: "git:score",
                sessionId: "session",
                harness: "opencode",
                profile: {
                    model: "mock/score",
                    variant: "low",
                    temperature: 0,
                    maxOutputTokens: 1000,
                },
                admissionFailure: () => null,
            });
            const authority = service.confirm(service.preview().snapshotId);
            h.promptAsync.mockImplementationOnce(async () => {
                setTimeout(
                    () =>
                        recordPromptSessionError("ses-child", {
                            name: "APIError",
                            data: { message: "missing credentials" },
                        }),
                    50,
                );
                return { data: undefined };
            });
            const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
            await driveRescore(
                service,
                authority,
                createOpenCodeRescoreCarrier({
                    executor,
                    db,
                    sessionId: "session",
                    harness: "opencode",
                    directory: "/repo",
                    timeoutMs: 1000,
                }),
            );
            expect(h.promptAsync).toHaveBeenCalledTimes(1);
            expect(h.prompt).not.toHaveBeenCalled();
            const status = service.status(authority.jobId);
            expect(status.job.state).toBe("paused");
            expect(status.attempts[0].outcome).toBe("failed");
            expect(status.job.last_error).toContain("missing credentials");
            expect(db.prepare("SELECT subagent, model_id FROM subagent_invocations").all()).toEqual(
                [{ subagent: "rescore", model_id: "score" }],
            );
        } finally {
            h.stop();
            closeQuietly(db);
        }
    });
    test("score sampling is frozen, and finished-child recovery places no prompt", async () => {
        const db = freshDb();
        const h = host();
        const executor = createV1HiddenCompletionExecutor(h.client, db, "/repo");
        try {
            const handle = await executor.open({
                ...run("rescore"),
                agent: "rescore",
                maxOutputTokens: 1234,
                metadata: { temperature: 0 },
            });
            const sampler = createDreamerOutputCapSampler({}, () => ({}));
            const options = { temperature: 0.9, maxOutputTokens: 99 };
            sampler.apply({ sessionID: handle.id, agent: "rescore" }, options);
            expect(options).toEqual({ temperature: 0, maxOutputTokens: 1234 });
            expect(await executor.recover?.(handle.id)).toBeNull();
            await executor.attempt(handle, request);
            expect((await executor.recover?.(handle.id))?.text).toBe("<classify/>");
            expect(h.promptAsync).toHaveBeenCalledTimes(1);
        } finally {
            closeQuietly(db);
        }
    });
});
