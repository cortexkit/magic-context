import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHarness } from "../../../shared/harness";
import {
    __resetStoragePrivatePermissionEnforcementForTests,
    setStoragePrivatePermissionEnforcement,
} from "../../../shared/storage-permissions";
import { cleanupTestTempDir, createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import {
    __resetLocalEmbeddingForTests,
    __setLocalEmbeddingTestHooks,
    LocalEmbeddingProvider,
    resolveLocalEmbeddingWorkerRuntime,
} from "./embedding-local";
import { EmbeddingWorkerClient } from "./embedding-worker-client";

afterEach(() => {
    __resetLocalEmbeddingForTests();
    __resetStoragePrivatePermissionEnforcementForTests();
});

const entry = new URL("./embedding-worker.fixture.ts", import.meta.url);

async function waitForIdle(client: EmbeddingWorkerClient): Promise<void> {
    const deadline = Date.now() + 3000;
    while (client.isRunning() && Date.now() < deadline) await Bun.sleep(10);
    expect(client.isRunning()).toBe(false);
}

describe("embedding worker transport", () => {
    for (const transport of ["thread", "child"] as const) {
        const inProcess = async () => transport === "thread";
        test(`${transport} idle shutdown releases the owner and restarts with identical vector bytes`, async () => {
            const client = new EmbeddingWorkerClient({}, entry, undefined, inProcess, 80);
            try {
                const before = await client.request(["special-floats", "hello", "pid"]);
                const pid = before.vectors![2]![0]!;
                await waitForIdle(client);
                if (transport === "child") {
                    const deadline = Date.now() + 3000;
                    while (existsSync(`/proc/${pid}`) && Date.now() < deadline) await Bun.sleep(10);
                    expect(existsSync(`/proc/${pid}`)).toBe(false);
                }
                const after = await client.request(["special-floats", "hello", "pid"]);
                expect(after.loaded).toBe(true);
                for (const index of [0, 1]) {
                    expect(Buffer.from(after.vectors![index]!.buffer)).toEqual(
                        Buffer.from(before.vectors![index]!.buffer),
                    );
                }
                if (transport === "child") expect(after.vectors![2]![0]).not.toBe(pid);
            } finally {
                await client.dispose();
            }
        });

        test(`${transport} requests racing idle shutdown complete on either owner`, async () => {
            const client = new EmbeddingWorkerClient({}, entry, undefined, inProcess, 80);
            try {
                await client.request();
                await Bun.sleep(40);
                // This batch outlasts the old idle deadline, but must not be interrupted.
                expect((await client.request(["before deadline"])).vectors?.[0]?.[0]).toBe(15);
                // The idle callback and a new sender become runnable at the same deadline.
                await Bun.sleep(80);
                expect((await client.request(["at deadline"])).vectors?.[0]?.[0]).toBe(11);
            } finally {
                await client.dispose();
            }
        });
    }

    test("concurrent startup prepares telemetry once and disposal prevents a late worker", async () => {
        let ready!: (value: boolean) => void;
        let preparations = 0;
        const preparation = new Promise<boolean>((resolve) => {
            ready = resolve;
        });
        const client = new EmbeddingWorkerClient({}, entry, undefined, () => {
            preparations++;
            return preparation;
        });
        const requests = Promise.allSettled([client.request(), client.request()]);
        const disposed = client.dispose();
        ready(true);
        const results = await requests;
        await disposed;
        expect(preparations).toBe(1);
        expect(results.every((result) => result.status === "rejected")).toBe(true);
        expect(client.isRunning()).toBe(false);
    });
    test.skipIf(process.platform !== "linux" || !existsSync("/usr/include/node/node_api.h"))(
        "native getenv sees telemetry disabled before the model worker initializes",
        async () => {
            const dir = createTestTempDirFromPath(join(tmpdir(), "ort-getenv-"));
            const addon = join(dir, "probe.node");
            const build = spawnSync(
                "cc",
                [
                    "-shared",
                    "-fPIC",
                    "-I/usr/include/node",
                    new URL(
                        "../../../../../../scripts/fixtures/onnx-telemetry-probe.c",
                        import.meta.url,
                    ).pathname,
                    "-ldl",
                    "-o",
                    addon,
                ],
                { windowsHide: true },
            );
            try {
                expect(build.status, build.stderr.toString()).toBe(0);
                const script = `import { EmbeddingWorkerClient } from ${JSON.stringify(new URL("./embedding-worker-client.ts", import.meta.url).pathname)};
                    const client = new EmbeddingWorkerClient({probeAddon:${JSON.stringify(addon)}}, new URL(${JSON.stringify(entry.href)}));
                    try {
                        const reply = await client.request(["native-env", "pid"]);
                        console.log(JSON.stringify({native:reply.vectors?.[0]?.[0], workerPid:reply.vectors?.[1]?.[0], hostPid:process.pid}));
                    } finally { await client.dispose(); }`;
                const child = Bun.spawn([process.execPath, "-e", script], {
                    windowsHide: true,
                    env: { ...process.env, ORT_DISABLE_TELEMETRY: "0" },
                    stdout: "pipe",
                    stderr: "pipe",
                });
                const stdout = await new Response(child.stdout).text();
                const stderr = await new Response(child.stderr).text();
                expect(await child.exited, stderr).toBe(0);
                const result = JSON.parse(stdout);
                expect(result.native).toBe(1);
                expect(result.workerPid).toBe(result.hostPid);
            } finally {
                cleanupTestTempDir(dir);
            }
        },
    );
    test("worker inherits the resolved model cache, harness and trusted-group permission policy", async () => {
        let captured: Record<string, unknown> | undefined;
        setStoragePrivatePermissionEnforcement(false);
        __setLocalEmbeddingTestHooks({
            modelCacheDir: () => "/throwaway/custom-model-cache",
            workerFactory: (data) => {
                captured = data;
                return new EmbeddingWorkerClient(data, entry);
            },
        });
        const provider = new LocalEmbeddingProvider();
        expect(captured?.modelCacheDir).toBe("/throwaway/custom-model-cache");
        expect(captured?.harness).toBe(getHarness());
        expect(captured?.enforcePrivateStoragePermissions).toBe(false);
        await provider.dispose();
    });
    test("provider reports worker crashes and recovers lazily without changing its interface", async () => {
        __setLocalEmbeddingTestHooks({
            workerFactory: (data) => new EmbeddingWorkerClient(data, entry),
            log: () => {},
        });
        const provider = new LocalEmbeddingProvider();
        try {
            expect(await provider.embed("crash")).toBeNull();
            expect(provider.getLastFailureReason()?.reason).toContain("exited (7)");
            expect(provider.isLoaded()).toBe(false);
            expect(Array.from((await provider.embed("recovered"))!)).toEqual([9, 0.125, -0.25]);
            expect(provider.isLoaded()).toBe(true);
            expect(provider.getLastFailureReason()).toBeNull();
        } finally {
            await provider.dispose();
        }
    });

    test("old Bun worker teardown protection also overrides explicit native", () => {
        expect(
            resolveLocalEmbeddingWorkerRuntime("native", {
                isBun: true,
                isElectron: false,
                bunVersion: "1.3.14",
            }),
        ).toBe("wasm");
        expect(
            resolveLocalEmbeddingWorkerRuntime("native", {
                isBun: true,
                isElectron: false,
                bunVersion: "1.4.0",
            }),
        ).toBe("native");
        expect(
            resolveLocalEmbeddingWorkerRuntime("native", { isBun: false, isElectron: false }),
        ).toBe("native");
    });
    test("host timers remain responsive during a synchronous large batch", async () => {
        const client = new EmbeddingWorkerClient({}, entry);
        const lags: number[] = [];
        let last = performance.now();
        const timer = setInterval(() => {
            const now = performance.now();
            lags.push(Math.max(0, now - last - 50));
            last = now;
        }, 50);
        try {
            const result = await client.request(
                Array.from({ length: 128 }, () => "embedding input"),
            );
            expect(result.vectors).toHaveLength(128);
            expect(lags.length).toBeGreaterThanOrEqual(4);
            const sorted = lags.sort((a, b) => a - b);
            expect(sorted[Math.ceil(sorted.length * 0.99) - 1]).toBeLessThan(100);
        } finally {
            clearInterval(timer);
            await client.dispose();
        }
    });

    test("transferred vectors preserve float32 bits", async () => {
        const client = new EmbeddingWorkerClient({}, entry);
        try {
            const result = await client.request(["hello", "world!"]);
            expect(result.vectors?.map((vector) => Array.from(vector ?? []))).toEqual([
                [5, 0.125, -0.25],
                [6, 0.125, -0.25],
            ]);
            expect(result.vectors?.[0]).toBeInstanceOf(Float32Array);
            const special = (await client.request(["special-floats"])).vectors?.[0];
            expect(Object.is(special?.[0], -0)).toBe(true);
            expect(Number.isNaN(special?.[1])).toBe(true);
            expect(special?.[2]).toBe(Infinity);
            expect(special?.[3]).toBe(-Infinity);
        } finally {
            await client.dispose();
        }
    });

    test("worker crash rejects outstanding requests and a later request recovers", async () => {
        const client = new EmbeddingWorkerClient({}, entry);
        try {
            await expect(client.request(["crash"])).rejects.toThrow("embedding worker exited (7)");
            expect((await client.request(["recovered"])).vectors?.[0]?.[0]).toBe(9);
        } finally {
            await client.dispose();
        }
    });

    test("killed subprocess rejects every in-flight request and restarts lazily", async () => {
        const client = new EmbeddingWorkerClient({}, entry, undefined, async () => false);
        try {
            const pid = (await client.request(["pid"])).vectors?.[0]?.[0];
            expect(pid).toBeDefined();
            const requests = [client.request(["hang-a"]), client.request(["hang-b"])];
            const settled = Promise.allSettled(requests);
            process.kill(pid!, "SIGKILL");
            for (const result of await settled) {
                expect(result.status).toBe("rejected");
                if (result.status === "rejected") {
                    expect(String(result.reason)).toContain("embedding worker exited (SIGKILL)");
                }
            }
            expect((await client.request(["recovered"])).vectors?.[0]?.[0]).toBe(9);
        } finally {
            await client.dispose();
        }
    });

    test("unresponsive worker times out all pending callers and restarts on the next request", async () => {
        // The hung worker never finishes its request, so its stop ends by termination;
        // a short bound keeps the test fast.
        const client = new EmbeddingWorkerClient({}, entry, 1000, undefined, undefined, {
            stopGraceMs: 200,
            log: () => {},
        });
        try {
            await client.request();
            await Promise.all([
                expect(client.request(["hang-a"])).rejects.toThrow("timed out"),
                expect(client.request(["hang-b"])).rejects.toThrow("timed out"),
            ]);
            expect((await client.request(["recovered"])).vectors?.[0]?.[0]).toBe(9);
        } finally {
            await client.dispose();
        }
    });

    test("aborted caller settles without waiting for inference", async () => {
        const client = new EmbeddingWorkerClient({}, entry);
        const controller = new AbortController();
        try {
            const request = client.request(["slow"], controller.signal);
            controller.abort();
            await expect(request).rejects.toThrow("aborted");
        } finally {
            await client.dispose();
        }
    });

    test("idle worker does not prevent clean process exit", async () => {
        const script = `import { EmbeddingWorkerClient } from ${JSON.stringify(new URL("./embedding-worker-client.ts", import.meta.url).pathname)};
            const client = new EmbeddingWorkerClient({}, new URL(${JSON.stringify(entry.href)}));
            await client.request(["exit"]);`;
        const child = Bun.spawn([process.execPath, "-e", script], {
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
        });
        const timeout = setTimeout(() => child.kill(), 5000);
        try {
            expect(await child.exited).toBe(0);
        } finally {
            clearTimeout(timeout);
        }
    });
});
