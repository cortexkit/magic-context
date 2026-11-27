import { describe, expect, spyOn, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { Worker } from "node:worker_threads";
import { EmbeddingWorkerClient } from "./embedding-worker-client";

// The fixture serves requests through the production worker loop. A text request
// runs one synchronous 350 ms batch, standing in for the native inference call:
// while it runs, the worker cannot read a stop request. "hang" never finishes.
const entry = new URL("./embedding-worker.fixture.ts", import.meta.url);

type HarnessOptions = {
    stopGraceMs?: number;
    forcedExitWaitMs?: number;
    idleMs?: number;
    /** Worker data for the fixture. */
    data?: Record<string, unknown>;
    /**
     * Simulate a forced stop that does not end the worker: "terminate" ignores
     * `terminate()` and the default kill signal, "all" also ignores SIGKILL.
     */
    ignoreForce?: "terminate" | "all";
};

function harness(transport: "thread" | "child", options: HarnessOptions = {}) {
    const lines: string[] = [];
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    const refOps: string[] = [];
    const targets = new Set<Worker | ChildProcess>();
    // Count forced stops while keeping the real behaviour unless told otherwise.
    const originalTerminate = Worker.prototype.terminate;
    const originalKill = ChildProcess.prototype.kill;
    const terminate = spyOn(Worker.prototype, "terminate").mockImplementation(function (
        this: Worker,
    ) {
        targets.add(this);
        if (options.ignoreForce) return new Promise<number>(() => {});
        return originalTerminate.call(this);
    });
    const kill = spyOn(ChildProcess.prototype, "kill").mockImplementation(function (
        this: ChildProcess,
        signal?: NodeJS.Signals | number,
    ) {
        targets.add(this);
        signals.push(signal);
        if (options.ignoreForce === "all") return true;
        if (options.ignoreForce === "terminate" && signal !== "SIGKILL") return true;
        return originalKill.call(this, signal);
    });
    const spies = [terminate, kill];
    for (const prototype of [Worker.prototype, ChildProcess.prototype] as const) {
        for (const method of ["ref", "unref"] as const) {
            const original = prototype[method] as (this: unknown) => unknown;
            spies.push(
                spyOn(prototype, method).mockImplementation(function (this: unknown) {
                    refOps.push(method);
                    return original.call(this);
                } as never) as never,
            );
        }
    }
    const client = new EmbeddingWorkerClient(
        options.data ?? {},
        entry,
        undefined,
        async () => transport === "thread",
        options.idleMs,
        {
            stopGraceMs: options.stopGraceMs,
            forcedExitWaitMs: options.forcedExitWaitMs,
            log: (line) => lines.push(line),
        },
    );
    return {
        client,
        lines,
        signals,
        refOps,
        /** How often the worker was stopped by force rather than asked. */
        forced: () => terminate.mock.calls.length + kill.mock.calls.length,
        async cleanup() {
            await client.dispose();
            for (const spy of spies) spy.mockRestore();
            // End workers whose forced stop was simulated away.
            for (const target of targets) {
                if (target instanceof Worker) await target.terminate();
                else if (target.exitCode === null && target.signalCode === null)
                    target.kill("SIGKILL");
            }
        },
    };
}

/** Records how a request settled without awaiting it. */
function outcome(request: Promise<unknown>): Promise<string> {
    return request.then(
        () => "resolved",
        (error) => String(error),
    );
}

async function timed(action: () => Promise<void>): Promise<number> {
    const started = performance.now();
    await action();
    return performance.now() - started;
}

describe("embedding worker stop", () => {
    for (const transport of ["thread", "child"] as const) {
        test(`${transport}: a stop during an inference waits for it and never forces the worker`, async () => {
            const { client, lines, forced, cleanup } = harness(transport);
            try {
                await client.request();
                const inflight = outcome(client.request(["slow"]));
                // Let the 350 ms batch start before stopping.
                await Bun.sleep(100);
                const elapsed = await timed(() => client.dispose());
                expect(await inflight).toBe("Error: embedding worker disposed");
                expect(forced()).toBe(0);
                // The stop waited for the rest of the running batch.
                expect(elapsed).toBeGreaterThan(150);
                expect(lines).toEqual([
                    expect.stringMatching(
                        /^\[magic-context\] embedding worker stopped \(embedding worker disposed; pid \d+[^;]*; inference running: yes \(for \d+ms\); stop took \d+ms\)$/,
                    ),
                ]);
            } finally {
                await cleanup();
            }
        });

        test(`${transport}: a stop with no inference running ends at once`, async () => {
            const { client, lines, forced, cleanup } = harness(transport);
            try {
                await client.request(["hello"]);
                const elapsed = await timed(() => client.dispose());
                expect(forced()).toBe(0);
                expect(elapsed).toBeLessThan(1_000);
                expect(lines).toEqual([
                    expect.stringContaining("(embedding worker disposed; pid "),
                ]);
                expect(lines[0]).toContain("; inference running: no; stop took ");
            } finally {
                await cleanup();
            }
        });

        test(`${transport}: a worker that does not stop within the bound is forced and the log says so`, async () => {
            const { client, lines, forced, cleanup } = harness(transport, { stopGraceMs: 150 });
            try {
                await client.request();
                const hung = outcome(client.request(["hang"]));
                await Bun.sleep(50);
                await client.dispose();
                expect(await hung).toBe("Error: embedding worker disposed");
                expect(forced()).toBe(1);
                expect(lines).toEqual([
                    expect.stringMatching(
                        /^\[magic-context\] embedding worker did not stop within 150ms; terminating it \(embedding worker disposed; pid \d+[^;]*; inference running: yes \(for \d+ms\)\)$/,
                    ),
                ]);
            } finally {
                await cleanup();
            }
        });
    }

    test("a worker still inside one call when the bound expires is reported as not answering", async () => {
        const { client, lines, forced, cleanup } = harness("thread", { stopGraceMs: 100 });
        try {
            await client.request();
            const inflight = outcome(client.request(["slow"]));
            await Bun.sleep(50);
            await client.dispose();
            expect(await inflight).toBe("Error: embedding worker disposed");
            expect(forced()).toBe(1);
            expect(lines).toEqual([
                expect.stringMatching(
                    /did not stop within 100ms; terminating it \(.*inference running: yes \(for \d+ms\), no answer to the stop request\)$/,
                ),
            ]);
        } finally {
            await cleanup();
        }
    });

    test("a cancelled caller's inference still counts as running", async () => {
        const { client, lines, forced, cleanup } = harness("thread");
        try {
            await client.request();
            const controller = new AbortController();
            const request = outcome(client.request(["slow"], controller.signal));
            await Bun.sleep(100);
            controller.abort();
            expect(await request).toBe("Error: embedding request aborted");
            // The caller has gone, but the worker is still inside its batch.
            const elapsed = await timed(() => client.dispose());
            expect(forced()).toBe(0);
            expect(elapsed).toBeGreaterThan(100);
            expect(lines).toEqual([expect.stringContaining("; inference running: yes (for ")]);
        } finally {
            await cleanup();
        }
    });

    test("dispose also waits for a worker an earlier idle stop is still stopping", async () => {
        const { client, lines, forced, cleanup } = harness("thread", { idleMs: 50 });
        try {
            await client.request();
            const controller = new AbortController();
            const request = outcome(client.request(["slow"], controller.signal));
            await Bun.sleep(100);
            // With its only caller gone the client counts as idle and stops the
            // worker after 50 ms, while the worker is still inside its batch.
            controller.abort();
            expect(await request).toBe("Error: embedding request aborted");
            await Bun.sleep(80);
            const elapsed = await timed(() => client.dispose());
            expect(forced()).toBe(0);
            expect(elapsed).toBeGreaterThan(50);
            expect(lines).toEqual([
                expect.stringMatching(
                    /^\[magic-context\] embedding worker stopped \(embedding worker idle; pid \d+; inference running: yes/,
                ),
            ]);
        } finally {
            await cleanup();
        }
    });

    for (const transport of ["thread", "child"] as const) {
        test(`${transport}: the client waits for the worker's real exit, not its stopped message`, async () => {
            // The fixture posts `stopped` and then takes 300 ms to exit.
            const { client, lines, forced, cleanup } = harness(transport, {
                data: { exitDelayMs: 300 },
            });
            try {
                await client.request();
                const elapsed = await timed(() => client.dispose());
                expect(forced()).toBe(0);
                expect(elapsed).toBeGreaterThan(250);
                expect(lines).toEqual([expect.stringContaining("inference running: no;")]);
            } finally {
                await cleanup();
            }
        });

        test.skipIf(transport === "child" && process.platform === "win32")(
            `${transport}: a forced stop that never produces an exit settles within the bound and releases the worker`,
            async () => {
                const { client, lines, signals, refOps, cleanup } = harness(transport, {
                    stopGraceMs: 100,
                    forcedExitWaitMs: 150,
                    ignoreForce: "all",
                });
                try {
                    await client.request();
                    const hung = outcome(client.request(["hang"]));
                    await Bun.sleep(50);
                    const elapsed = await timed(() => client.dispose());
                    expect(await hung).toBe("Error: embedding worker disposed");
                    // Grace, forced-exit wait and the SIGKILL wait, with scheduling slack.
                    expect(elapsed).toBeLessThan(100 + 150 + 200 + 400);
                    expect(lines).toEqual([
                        expect.stringContaining("did not stop within 100ms; terminating it"),
                        expect.stringMatching(
                            transport === "child"
                                ? /has not exited 150ms after it was terminated and sent SIGKILL; no longer waiting for it \(embedding worker disposed; pid \d+, worker pid \d+\)$/
                                : /has not exited 150ms after it was terminated; no longer waiting for it \(embedding worker disposed; pid \d+\)$/,
                        ),
                    ]);
                    if (transport === "child") expect(signals).toEqual([undefined, "SIGKILL"]);
                    // The host is no longer held by a worker that never ended.
                    expect(refOps.at(-1)).toBe("unref");
                } finally {
                    await cleanup();
                }
            },
        );
    }

    test.skipIf(process.platform === "win32")(
        "child: a child that survives the termination gets SIGKILL once and its exit is awaited",
        async () => {
            const { client, lines, signals, cleanup } = harness("child", {
                stopGraceMs: 100,
                forcedExitWaitMs: 150,
                ignoreForce: "terminate",
            });
            try {
                await client.request();
                const hung = outcome(client.request(["hang"]));
                await Bun.sleep(50);
                await client.dispose();
                expect(await hung).toBe("Error: embedding worker disposed");
                expect(signals).toEqual([undefined, "SIGKILL"]);
                expect(lines).toEqual([
                    expect.stringContaining("did not stop within 100ms; terminating it"),
                ]);
            } finally {
                await cleanup();
            }
        },
    );

    test("dispose joining an earlier idle stop of a worker that never exits is bounded too", async () => {
        const { client, lines, cleanup } = harness("thread", {
            idleMs: 30,
            stopGraceMs: 100,
            forcedExitWaitMs: 150,
            ignoreForce: "all",
        });
        try {
            await client.request();
            const controller = new AbortController();
            const request = outcome(client.request(["hang"], controller.signal));
            await Bun.sleep(30);
            controller.abort();
            expect(await request).toBe("Error: embedding request aborted");
            // The idle stop has started; dispose joins it.
            await Bun.sleep(60);
            const elapsed = await timed(() => client.dispose());
            expect(elapsed).toBeLessThan(100 + 150 + 400);
            expect(lines).toEqual([
                expect.stringContaining("(embedding worker idle; pid "),
                expect.stringContaining("no longer waiting for it (embedding worker idle; pid "),
            ]);
        } finally {
            await cleanup();
        }
    });
});
