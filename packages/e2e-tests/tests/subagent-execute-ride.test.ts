import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TestHarness } from "../src/harness";
import type { MockResponse, MockUsage } from "../src/mock-provider/server";

// The host moves Anthropic's ephemeral boundary as tools append. That annotation
// is not a content rewrite; all message content and ordering remain compared.
const bytes = (value: unknown) =>
    JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item));

test("issue 619 task subagent drops ride execute once and replay the provider prefix", async () => {
    const previousTmp = process.env.TMPDIR;
    const taskRoot = join(tmpdir(), "magic-context", "issue-619");
    mkdirSync(taskRoot, { recursive: true });
    process.env.TMPDIR = taskRoot;
    let h: TestHarness;
    try {
        h = await TestHarness.create({
            modelContextLimit: 100_000,
            magicContextConfig: {
                execute_threshold_tokens: { default: 5000 },
                protected_tokens: 4000,
                dreamer: { disable: true },
                memory: { enabled: false },
            },
            openCodeConfigExtra: {
                agent: {
                    "ride-worker": {
                        mode: "subagent",
                        description: "Execute ride test worker",
                        prompt: "ISSUE-619-WORKER",
                        model: "mock-anthropic/mock-sonnet",
                        permission: { "*": "allow" },
                    },
                },
            },
        });
    } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
    }
    const root = dirname(h.opencode.env.configDir);
    const proof = join(root, "proof");
    mkdirSync(proof);
    try {
        expect(realpathSync(root).startsWith(realpathSync(taskRoot) + "/")).toBe(true);
        const health = (await fetch(`${h.serverUrl}/global/health`).then((r) => r.json())) as {
            version: string;
        };
        expect(health.version).toMatch(/^1\./);
        const containment = () => {
            const result = spawnSync("lsof", ["-p", String(h.opencode.pid), "-Fn"], {
                encoding: "utf8",
            });
            expect(result.status).toBe(0);
            const databases = result.stdout
                .split("\n")
                .filter((line) => /^n.*\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(line))
                .map((line) => line.slice(1));
            expect(databases.length).toBeGreaterThan(0);
            expect(databases.every((path) => path.startsWith(root + "/"))).toBe(true);
            writeFileSync(join(proof, "host-lsof.txt"), result.stdout);
            return databases;
        };
        const databases = containment();
        // Actual tool bytes, not inflated usage, reach the token-configured
        // threshold while remaining far below the unchanged 85% force floor.
        // Dense deterministic identifiers stay under the host's 50 KB output
        // cap but carry enough measured tokens to displace a 4000-token floor.
        for (const [index, name] of ["a", "b", "c"].entries()) {
            const content = Array.from(
                { length: 2000 },
                (_, n) => `${(n * 7919 + index * 104729).toString(16)}:${(n * 3571).toString(16)}!`,
            ).join(" ");
            writeFileSync(
                join(h.workdir, `spent-${name}.txt`),
                `SPENT-${name.toUpperCase()}\n${content}`,
            );
        }
        const passes: Array<{
            pass: number;
            decision: string;
            prefixChanged: boolean;
            requestBytes: number;
            cacheRead: number;
            cacheWrite: number;
            messages: unknown[];
        }> = [];
        let workerPass = 0;
        let sentTask = false;
        let previousMessages: unknown[] = [];
        let workerSystem: string | undefined;
        const tool = (
            id: string,
            name: string,
            input: unknown,
            usage: MockUsage,
        ): MockResponse => ({
            content: [{ type: "tool_use", id, name, input }],
            stop_reason: "tool_use",
            usage,
        });
        h.mock.addMatcher((body) => {
            if (bytes(body.system).includes("You are a title generator"))
                return { text: "Execute ride", usage: { input_tokens: 100, output_tokens: 5 } };
            if (!bytes(body.system).includes("ISSUE-619-WORKER")) {
                if (sentTask)
                    return {
                        text: "Parent complete.",
                        usage: { input_tokens: 100, output_tokens: 10 },
                    };
                sentTask = true;
                return tool(
                    "task-619",
                    "task",
                    {
                        subagent_type: "ride-worker",
                        description: "Reclaim spent outputs",
                        prompt: "Read the two files, discard spent outputs, then finish.",
                    },
                    { input_tokens: 100, output_tokens: 20 },
                );
            }
            workerPass++;
            const system = bytes(body.system);
            if (workerSystem !== undefined) expect(system).toBe(workerSystem);
            workerSystem = system;
            const messages = body.messages as Array<{ role: string; content: unknown }>;
            const requestBytes = Buffer.byteLength(bytes(messages), "utf8");
            const input = Math.ceil(
                (requestBytes + Buffer.byteLength(bytes(body.system), "utf8")) / 4,
            );
            let common = 0;
            while (
                common < previousMessages.length &&
                bytes(messages[common]) === bytes(previousMessages[common])
            )
                common++;
            const cacheRead = Math.floor(
                Buffer.byteLength(bytes(messages.slice(0, common)), "utf8") / 4,
            );
            const cacheWrite = Math.max(0, input - cacheRead);
            const child = h
                .contextDb()
                .query("SELECT session_id FROM session_meta WHERE is_subagent = 1")
                .get() as { session_id: string };
            const log = readFileSync(join(h.dataDir, "cortexkit", "magic-context-e2e.log"), "utf8");
            const decisions = log
                .split("\n")
                .filter(
                    (line) =>
                        line.includes(child.session_id) && /decision=(execute|defer)/.test(line),
                );
            const decision = decisions.at(-1)?.match(/decision=(execute|defer)/)?.[1] ?? "missing";
            passes.push({
                pass: workerPass,
                decision,
                prefixChanged: common < previousMessages.length,
                requestBytes,
                cacheRead,
                cacheWrite,
                messages: structuredClone(messages),
            });
            previousMessages = structuredClone(messages);
            const usage = {
                input_tokens: 0,
                output_tokens: 20,
                cache_read_input_tokens: cacheRead,
                cache_creation_input_tokens: cacheWrite,
            };
            if (workerPass <= 2)
                return tool(
                    `read-${workerPass}`,
                    "bash",
                    {
                        command: `cat spent-${workerPass === 1 ? "a" : "b"}.txt`,
                        description: "Read fixture",
                    },
                    usage,
                );
            if (workerPass === 4 || workerPass === 8) {
                const marker = workerPass === 4 ? "SPENT-A" : "SPENT-B";
                const target = (
                    h
                        .contextDb()
                        .query(
                            "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'active' ORDER BY tag_number",
                        )
                        .all(child.session_id) as Array<{ tag_number: number }>
                ).find(
                    (row) =>
                        bytes(messages).includes(`§${row.tag_number}§`) &&
                        messages.some(
                            (message) =>
                                bytes(message.content).includes(marker) &&
                                bytes(message.content).includes(`§${row.tag_number}§`),
                        ),
                );
                if (!target) throw new Error(`missing visible tool tag for ${marker}`);
                const reduce = tool(
                    `reduce-${workerPass}`,
                    "ctx_reduce",
                    { drop: String(target.tag_number) },
                    usage,
                );
                // B is still protected. The new C output displaces it before
                // the very next execute pass, so both pending work and all
                // other eligible cleanup land together on that one pass.
                if (workerPass === 8)
                    reduce.content!.push({
                        type: "tool_use",
                        id: "read-c",
                        name: "bash",
                        input: {
                            command: "cat spent-c.txt",
                            description: "Displace protection floor",
                        },
                    });
                return reduce;
            }
            if (workerPass < 11)
                return tool(
                    `continue-${workerPass}`,
                    "bash",
                    { command: "printf continue", description: "Continue replay" },
                    usage,
                );
            return { text: "Worker complete.", usage };
        });
        const parent = await h.createSession();
        await h.sendPrompt(parent, "Delegate the fixture work to ride-worker.", {
            timeoutMs: 90_000,
        });
        containment();
        // Check the cache counters that the real host received and persisted,
        // not just the counters the mock intended to send.
        const child = h
            .contextDb()
            .query("SELECT session_id FROM session_meta WHERE is_subagent = 1")
            .get() as { session_id: string };
        const hostDb = new Database(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
        let meters: Array<{ read: number; write: number }>;
        try {
            meters = (
                hostDb
                    .query("SELECT data FROM message WHERE session_id = ? ORDER BY id")
                    .all(child.session_id) as Array<{ data: string }>
            )
                .map((row) => JSON.parse(row.data))
                .filter((message) => message.role === "assistant")
                .map((message) => message.tokens.cache);
        } finally {
            hostDb.close();
        }
        expect(meters).toEqual(
            passes.map((pass) => ({ read: pass.cacheRead, write: pass.cacheWrite })),
        );
        writeFileSync(join(proof, "host-cache-meters.json"), JSON.stringify(meters, null, 2));
        writeFileSync(join(proof, "passes.json"), JSON.stringify(passes, null, 2));
        writeFileSync(join(proof, "requests.json"), JSON.stringify(h.mock.requests(), null, 2));
        writeFileSync(join(proof, "host-stderr.txt"), h.opencode.stderr());
        console.log(
            JSON.stringify(
                {
                    version: health.version,
                    pid: h.opencode.pid,
                    root,
                    databases,
                    passes: passes.map(({ messages: _messages, ...pass }) => pass),
                },
                null,
                2,
            ),
        );
        expect(passes).toHaveLength(11);
        expect(passes.slice(2).every((pass) => pass.decision === "execute")).toBe(true);
        expect(passes[4].prefixChanged).toBe(true);
        expect(passes[4].requestBytes).toBeLessThan(passes[3].requestBytes - 20_000);
        expect(bytes(passes[4].messages)).not.toContain("SPENT-A");
        for (const index of [5, 6, 7]) {
            expect(passes[index].prefixChanged).toBe(false);
            expect(bytes(passes[index].messages.slice(0, passes[4].messages.length))).toBe(
                bytes(passes[4].messages),
            );
            expect(passes[index].cacheRead).toBeGreaterThanOrEqual(passes[4].cacheRead);
        }
        expect(passes[8].prefixChanged).toBe(true);
        expect(bytes(passes[8].messages)).not.toContain("SPENT-B");
        expect(passes[9].prefixChanged).toBe(false);
        expect(passes[10].prefixChanged).toBe(false);
        expect(passes.filter((pass) => pass.prefixChanged)).toHaveLength(2);
        const wireRequests = h.mock
            .requests()
            .filter((request) => bytes(request.body.system).includes("ISSUE-619-WORKER"));
        expect(wireRequests).toHaveLength(11);
        // The whole request must shrink too, not just a normalized projection.
        expect(Buffer.byteLength(wireRequests[4].rawBody!, "utf8")).toBeLessThan(
            Buffer.byteLength(wireRequests[3].rawBody!, "utf8") - 20_000,
        );
        expect(
            h
                .contextDb()
                .query("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
                .get(child.session_id),
        ).toEqual({ n: 0 });
        expect(h.countCompartments(child.session_id)).toBe(0);
    } catch (error) {
        writeFileSync(
            join(proof, "failed-requests.json"),
            JSON.stringify(h.mock.requests(), null, 2),
        );
        writeFileSync(
            join(proof, "failed-tags.json"),
            JSON.stringify(h.contextDb().query("SELECT * FROM tags").all(), null, 2),
        );
        throw error;
    } finally {
        await h.dispose();
    }
}, 120_000);
