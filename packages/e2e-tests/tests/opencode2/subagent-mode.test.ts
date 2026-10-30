import { openTestDb } from "../../src/test-db";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { expectedOpenCode2Version } from "../../src/opencode2-runner/cli-resolution";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import type { CapturedRequest } from "../../src/mock-provider/server";
import {
    CLI,
    inspectOpenFiles,
    isolation,
    spawnOpencode2,
    waitForPluginActive,
    waitForPluginLog,
} from "../../src/opencode2-runner/spawn";

const TAG = /§\d+§/;
const REDUCE_GUIDANCE = "`ctx_reduce` with its tag";
const FULL_GUIDANCE = "durable working relationship";
const HISTORIAN = "the hippocampus of a long-running coding agent";

// Anthropic moves its ephemeral cache_control boundary to the appended tool
// result. Compare content bytes, not that host-owned per-request annotation.
const contentBytes = (value: unknown) =>
    JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item));

async function eventually(read: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!read()) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(50);
    }
}

async function fixture() {
    const isolated = isolation();
    const probe = join(isolated.root, "agents-probe");
    mkdirSync(probe);
    // Real host agents, not fabricated child sessions. The host itself filters
    // ctx_reduce before handing its context draft to Magic Context.
    writeFileSync(
        join(probe, "index.js"),
        `export default {
        id: "issue-612-agents",
        async setup(context) {
            await context.agent.transform(editor => {
                for (const id of ["worker-allowed", "worker-denied", "primary-denied"]) {
                    editor.update(id, agent => {
                        agent.mode = id === "primary-denied" ? "primary" : "subagent";
                        agent.hidden = false;
                        agent.description = "Issue 612 fixture " + id;
                        agent.system = "ISSUE-612-AGENT " + id;
                        agent.permissions = [
                            { action: "*", resource: "*", effect: "allow" },
                            ...(id.endsWith("denied") ? [{ action: "ctx_reduce", resource: "*", effect: "deny" }] : [])
                        ];
                    });
                }
            });
            await context.agent.reload();
        }
    };`,
    );
    const host = await spawnOpencode2({
        existingIsolation: isolated,
        probePlugin: probe,
        providerID: "anthropic",
        modelContextLimit: 100_000,
        modelOutputLimit: 1024,
        compactionAuto: false,
        magicContextConfig: {
            execute_threshold_percentage: 40,
            protected_tokens: 4000,
            historian: { two_pass: false },
            dreamer: { disable: true },
            memory: { enabled: false },
        },
    });
    const client = OpenCode.make({
        baseUrl: host.url,
        headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
    });
    const parent = await client.session.create({
        title: "issue 612 parent",
        location: { directory: host.cwd },
        model: { providerID: "anthropic", id: "mock-model" },
    });
    await waitForPluginActive(client, host.cwd);
    await waitForPluginActive(client, host.cwd, "issue-612-agents");
    const contextDb = openTestDb(join(host.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), {
        readonly: true,
    });
    const store = new Database(join(host.env.XDG_DATA_HOME!, "opencode", "opencode2.db"), {
        readonly: true,
    });
    const mode = (id: string) =>
        (
            contextDb
                .query("SELECT is_subagent FROM session_meta WHERE session_id = ?")
                .get(id) as { is_subagent: number } | null
        )?.is_subagent;
    const turn = async (sessionID: string, text: string) => {
        await client.session.prompt({ sessionID, text });
        await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
    };
    const stop = async () => {
        contextDb.close();
        store.close();
        await host.stop();
    };
    const version = JSON.parse(
        readFileSync(join(realpathSync(CLI), "..", "..", "package.json"), "utf8"),
    ).version;
    expect(version).toBe(expectedOpenCode2Version());
    const databases = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
        /\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path),
    );
    console.log(
        JSON.stringify({
            cliVersion: version,
            hostPid: host.pid,
            root: host.root,
            openDatabases: databases,
        }),
    );
    expect(databases.length).toBeGreaterThan(0);
    expect(databases.every((path) => path.startsWith(host.root))).toBe(true);
    host.mock.setDefault({
        text: "ordinary answer",
        usage: { input_tokens: 100, output_tokens: 10 },
    });
    host.mock.addMatcher((body) => {
        if (!JSON.stringify(body.system).includes(HISTORIAN)) return null;
        const range = JSON.stringify(body.messages).match(/Messages (\d+)-(\d+):/);
        if (!range) throw new Error("historian request lacked its source range");
        return {
            text: `<compartment start="${range[1]}" end="${range[2]}" title="Control"><p1>Durable control history.</p1></compartment>`,
            usage: { input_tokens: 100, output_tokens: 10 },
        };
    });
    return { host, client, parent, contextDb, store, mode, turn, stop };
}

for (const allowed of [true, false]) {
    test(`OC2 task child ${allowed ? "allowed" : "denied"} freezes reduced mode on its first request and never runs historian`, async () => {
        const f = await fixture();
        try {
            const agent = allowed ? "worker-allowed" : "worker-denied";
            const marker = `ISSUE-612-CHILD-${allowed ? "ALLOWED" : "DENIED"}`;
            const file = join(f.host.cwd, "child.txt");
            writeFileSync(file, "child tool result");
            let taskSent = false;
            let readSent = false;
            let childInputTokens = 100;
            const childRequests: CapturedRequest["body"][] = [];
            const firstPassModes: Array<{ id: string; mode: number | undefined }> = [];
            f.host.mock.addMatcher((body) => {
                const system = JSON.stringify(body.system ?? "");
                if (system.includes("ISSUE-612-AGENT " + agent)) {
                    childRequests.push(body);
                    const child = f.store
                        .query("SELECT id FROM session_v2 WHERE parent_id = ?")
                        .get(f.parent.id) as { id: string };
                    firstPassModes.push({ id: child.id, mode: f.mode(child.id) });
                    if (!readSent) {
                        readSent = true;
                        return {
                            content: [
                                {
                                    type: "tool_use",
                                    id: "child_read",
                                    name: "read",
                                    input: { path: file },
                                },
                            ],
                            stop_reason: "tool_use",
                            usage: { input_tokens: 100, output_tokens: 10 },
                        };
                    }
                    return {
                        text: "child finished",
                        usage: { input_tokens: childInputTokens, output_tokens: 10 },
                    };
                }
                // OpenCode 2.0.22 calls its native task tool `subagent`.
                const task = (body.tools as Array<{ name: string }> | undefined)?.find(
                    (tool) => tool.name === "subagent",
                );
                if (
                    task &&
                    JSON.stringify(body.messages).includes("ISSUE-612-LAUNCH") &&
                    !taskSent
                ) {
                    taskSent = true;
                    return {
                        content: [
                            {
                                type: "tool_use",
                                id: "launch_task",
                                name: task.name,
                                input: { description: "Issue 612 child", prompt: marker, agent },
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: { input_tokens: 100, output_tokens: 10 },
                    };
                }
                return null;
            });
            await f.turn(f.parent.id, "ISSUE-612-LAUNCH");
            expect(taskSent).toBe(true);
            expect(childRequests).toHaveLength(2);
            const childID = firstPassModes[0]!.id;
            expect(firstPassModes).toEqual([
                { id: childID, mode: 1 },
                { id: childID, mode: 1 },
            ]);
            expect((await f.client.session.get({ sessionID: childID })).parentID).toBe(f.parent.id);
            expect(f.mode(f.parent.id)).toBe(0);
            for (const body of childRequests) {
                const text = JSON.stringify(body.messages);
                const system = JSON.stringify(body.system);
                const tools = (body.tools as Array<{ name: string }>).map((tool) => tool.name);
                expect(tools.includes("ctx_reduce")).toBe(allowed);
                if (allowed) {
                    expect(text).toMatch(TAG);
                    expect(system).toContain("## Magic Context");
                    expect(system).toContain("ctx_reduce");
                    expect(system).not.toContain(FULL_GUIDANCE);
                } else {
                    expect(text).not.toMatch(TAG);
                    expect(system).not.toContain("## Magic Context");
                }
            }
            // Only the appended read arc may differ: the whole system and the
            // first request's message prefix must remain byte-identical.
            expect(JSON.stringify(childRequests[1]!.system)).toBe(
                JSON.stringify(childRequests[0]!.system),
            );
            const initialMessages = childRequests[0]!.messages!;
            expect(contentBytes(childRequests[1]!.messages!.slice(0, initialMessages.length))).toBe(
                contentBytes(initialMessages),
            );
            const parentRequests = f.host.mock
                .requests()
                .filter(
                    (request) =>
                        JSON.stringify(request.body.messages).includes("ISSUE-612-LAUNCH") &&
                        JSON.stringify(request.body.system).includes("## Magic Context"),
                );
            expect(parentRequests.length).toBeGreaterThan(0);
            expect(JSON.stringify(parentRequests[0]!.body.messages)).toMatch(TAG);
            expect(JSON.stringify(parentRequests[0]!.body.system)).toContain(FULL_GUIDANCE);
            expect(JSON.stringify(parentRequests[0]!.body.system)).toContain(REDUCE_GUIDANCE);

            // Enough real raw history and reported pressure for a primary to
            // schedule the historian; do not disable it to prove an absence.
            for (let i = 0; i < 8; i++)
                await f.turn(
                    childID,
                    `child history ${i}: ${"durable child history ".repeat(700)}`,
                );
            childInputTokens = 60_000;
            await f.turn(childID, "child pressure");
            childInputTokens = 100;
            await f.turn(childID, "child after pressure");
            const log = await waitForPluginLog(f.host.env, "inputTokens=60000");
            expect(
                log
                    .split("\n")
                    .some(
                        (line) =>
                            line.includes(`[${childID}]`) &&
                            line.includes("inputTokens=60000") &&
                            line.includes("decision=execute"),
                    ),
            ).toBe(true);
            expect(
                f.contextDb
                    .query("SELECT COUNT(*) AS n FROM historian_runs WHERE session_id = ?")
                    .get(childID),
            ).toEqual({ n: 0 });
            expect(
                f.contextDb
                    .query("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
                    .get(childID),
            ).toEqual({ n: 0 });
            expect(
                f.host.mock
                    .requests()
                    .filter((request) => JSON.stringify(request.body.system).includes(HISTORIAN)),
            ).toHaveLength(0);
            expect(f.mode(childID)).toBe(1);
            expect(f.mode(f.parent.id)).toBe(0);

            // Positive control: the same host/config does run the historian on
            // the primary, and its internal parented carrier stays untransformed.
            for (let i = 0; i < 8; i++)
                await f.turn(
                    f.parent.id,
                    `parent history ${i}: ${"durable parent history ".repeat(700)}`,
                );
            f.host.mock.setDefault({
                text: "pressure",
                usage: { input_tokens: 60_000, output_tokens: 10 },
            });
            await f.turn(f.parent.id, "parent pressure");
            f.host.mock.setDefault({
                text: "normal",
                usage: { input_tokens: 100, output_tokens: 10 },
            });
            await f.turn(f.parent.id, "parent after pressure");
            await eventually(
                () =>
                    (
                        f.contextDb
                            .query(
                                "SELECT COUNT(*) AS n FROM historian_runs WHERE session_id = ? AND status = 'success'",
                            )
                            .get(f.parent.id) as { n: number }
                    ).n > 0,
                "parent historian publication",
            );
            const hiddenRequests = f.host.mock
                .requests()
                .filter((request) => JSON.stringify(request.body.system).includes(HISTORIAN));
            expect(hiddenRequests.length).toBeGreaterThan(0);
            for (const { body } of hiddenRequests)
                expect(JSON.stringify(body.system)).not.toContain("## Magic Context");
            expect(
                f.contextDb
                    .query("SELECT COUNT(*) AS n FROM historian_runs WHERE session_id = ?")
                    .get(childID),
            ).toEqual({ n: 0 });
        } catch (error) {
            console.error(
                f.host.stderr().slice(-2000),
                (await waitForPluginLog(f.host.env, "transform scheduler:")).slice(-3000),
            );
            throw error;
        } finally {
            await f.stop();
        }
    }, 120_000);
}

test("OC2 primary agent denying ctx_reduce gets no tags or reduce guidance from the first pass", async () => {
    const f = await fixture();
    try {
        await f.client.session.switchAgent({ sessionID: f.parent.id, agent: "primary-denied" });
        for (let i = 0; i < 2; i++) await f.turn(f.parent.id, `ISSUE-612-DENIED-PRIMARY turn ${i}`);
        const requests = f.host.mock
            .requests()
            .filter((request) =>
                JSON.stringify(request.body.system).includes("ISSUE-612-AGENT primary-denied"),
            );
        expect(requests).toHaveLength(2);
        for (const { body } of requests) {
            expect((body.tools as Array<{ name: string }>).map((tool) => tool.name)).not.toContain(
                "ctx_reduce",
            );
            expect(JSON.stringify(body.messages)).not.toMatch(TAG);
            expect(JSON.stringify(body.system)).toContain("## Magic Context");
            expect(JSON.stringify(body.system)).not.toContain(REDUCE_GUIDANCE);
        }
        expect(f.mode(f.parent.id)).toBe(0);
    } finally {
        await f.stop();
    }
}, 120_000);
