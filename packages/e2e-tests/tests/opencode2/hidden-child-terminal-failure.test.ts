import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath } from "../../../plugin/src/v2/store-reader";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";
import { writeJsonAtomically } from "../../src/write-json-atomically";

async function waitForFile(path: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
        await Bun.sleep(20);
    }
}

async function eventually(check: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for host cleanup");
        await Bun.sleep(50);
    }
}

function sessionStored(path: string, sessionID: string): boolean {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        db.exec("PRAGMA busy_timeout = 5000");
        const row = db.prepare("SELECT id FROM session_v2 WHERE id = ?").get(sessionID);
        return row !== null && row !== undefined;
    } finally {
        db.close();
    }
}

function responseInputText(body: Record<string, unknown>): string[] {
    const input = body.input;
    if (!Array.isArray(input)) return [];
    return input.flatMap((message) => {
        const content = (message as { content?: unknown } | null)?.content;
        if (!Array.isArray(content)) return [];
        return content.flatMap((part) =>
            typeof (part as { text?: unknown } | null)?.text === "string"
                ? [(part as { text: string }).text]
                : [],
        );
    });
}

interface ContextCall {
    at: number;
    sessionID: string;
    owned: boolean;
    outcome: "handled" | "not-hidden" | "threw";
    error?: string;
}

interface RunResult {
    ok: boolean;
    childID: string;
    error?: string;
    startedAt: number;
    finishedAt: number;
}

// A mock-backed turn takes tens of milliseconds. Five seconds leaves ample room for a loaded
// machine yet still fails promptly if the host's event path stalls behind a hidden child.
const TURN_BUDGET_MS = 5_000;

test("OpenCode 2 hidden historian survives a retried and a terminal provider failure without refusing a host drain", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "mc-hidden-child-terminal-"));
    const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "hidden-child-terminal-failure-probe.ts")],
        outdir: bundleDir,
        naming: "index.js",
        target: "node",
        format: "esm",
        define: { "process.env.NODE_ENV": '"production"' },
        external: ["bun:sqlite", "node:sqlite"],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));

    const host = await spawnOpencode2({
        probePlugin: bundleDir,
        includeMagicContext: false,
        serviceMode: true,
        defaultModelID: "mock-model-user",
        additionalModelIDs: ["mock-model-cheap"],
        modelContextLimit: 200_000,
        mockResponse: { text: "hidden completion", usage: { input_tokens: 101, output_tokens: 11 } },
    });
    // Hidden requests only: the user session keeps getting ordinary replies throughout.
    let hiddenFailure: { status: number; remaining: number } | undefined;
    host.mock.addMatcher((body) => {
        if (!hiddenFailure || body.model !== "mock-model-cheap") return null;
        const { status } = hiddenFailure;
        hiddenFailure.remaining--;
        if (hiddenFailure.remaining <= 0) hiddenFailure = undefined;
        return {
            error: {
                status,
                type: status >= 500 ? "server_error" : "invalid_request_error",
                message: `forced hidden failure ${status}`,
            },
        };
    });
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        await waitForPluginActive(client, host.cwd, "mc-hidden-child-terminal-failure-proof");
        await waitForFile(join(host.cwd, "hidden-child-ready"));
        const user = await client.session.create({
            title: "user session",
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model-user" },
        });
        const command = async (seq: number): Promise<RunResult> => {
            const resultPath = join(host.cwd, `hidden-child-result-${seq}.json`);
            writeJsonAtomically(
                join(host.cwd, "hidden-child-command.json"),
                { seq, parentSessionID: user.id },
            );
            await waitForFile(resultPath);
            return JSON.parse(readFileSync(resultPath, "utf8")) as RunResult;
        };
        const userTurn = async (text: string) => {
            const started = Date.now();
            await client.session.prompt({ sessionID: user.id, text });
            await client.session.wait({ sessionID: user.id }, { signal: AbortSignal.timeout(60_000) });
            return Date.now() - started;
        };
        const calls = (): ContextCall[] => {
            const path = join(host.cwd, "context-calls.jsonl");
            if (!existsSync(path)) return [];
            return readFileSync(path, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as ContextCall);
        };
        const logLines = () => `${host.stdout()}\n${host.stderr()}`.split("\n");
        const turns: number[] = [await userTurn("baseline turn")];

        const first = await command(1);
        expect(first.ok).toBe(true);

        // A retryable provider error on a fresh child: the host retries the step, running
        // the context hook again over the child's whole history, which still starts with the
        // first run's marker. The retry must go through and carry only this run's prompt.
        hiddenFailure = { status: 500, remaining: 1 };
        const retried = await command(2);
        expect(retried.ok).toBe(true);
        expect(retried.childID).not.toBe(first.childID);
        const secondWires = host.mock
            .requests()
            .filter((request) =>
                responseInputText(request.body).includes("TERMINAL_HISTORIAN_CHUNK_2"),
            );
        expect(secondWires).toHaveLength(2);
        for (const wire of secondWires) {
            expect(responseInputText(wire.body)).toEqual(["TERMINAL_HISTORIAN_CHUNK_2"]);
        }

        // A terminal provider error, with the user session taking turns the whole time.
        hiddenFailure = { status: 400, remaining: 1 };
        let failing = true;
        const failedRun = command(3).finally(() => {
            failing = false;
        });
        while (failing) turns.push(await userTurn(`turn during the failure ${turns.length}`));
        const failed = await failedRun;
        expect(failed.ok).toBe(false);
        expect(failed.error).toContain("outcome=failed");
        expect(failed.error).toContain("provider.invalid-request");
        expect(failed.error).toContain("forced hidden failure 400");
        expect(failed.childID).not.toBe(first.childID);

        // The next run gets a clean child while the user session keeps taking turns.
        const [concurrentTurn, next] = await Promise.all([userTurn("concurrent turn"), command(4)]);
        turns.push(concurrentTurn);
        expect(next.ok).toBe(true);
        expect(next.childID).not.toBe(first.childID);
        for (let index = 0; index < 5; index++) turns.push(await userTurn(`after ${index}`));
        // Without keep_subagents the retired child's session is deleted from the host store.
        const storePath = gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env);
        await eventually(() => !sessionStored(storePath, failed.childID));

        // Nothing touched the retired child after its failed run returned, and no pass on any
        // hidden child was refused.
        expect(
            calls().filter((call) => call.sessionID === failed.childID && call.at > failed.finishedAt),
        ).toEqual([]);
        expect(calls().filter((call) => call.outcome === "threw")).toEqual([]);
        expect(logLines().filter((line) => line.includes("hidden_prompt_unrecognized"))).toEqual([]);
        // The host records every failed provider step as a failed drain. The only such line
        // allowed is the forced 400 itself, never a refusal from the hidden-child hook.
        const drainFailures = logLines().filter((line) => line.includes("Failed to drain Session"));
        expect(drainFailures).toHaveLength(1);
        expect(drainFailures[0]).toContain("forced hidden failure 400");
        expect(Math.max(...turns)).toBeLessThan(TURN_BUDGET_MS);
    } catch (error) {
        console.error(host.stdout(), host.stderr());
        throw error;
    } finally {
        await host.stop();
        rmSync(bundleDir, { recursive: true, force: true });
    }
}, 180_000);
