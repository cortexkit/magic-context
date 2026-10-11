import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TestHarness } from "../src/harness";

// OpenCode moves cache annotations as new messages append. Compare every content byte,
// system instruction and tool definition, excluding only those moving annotations.
const bytes = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);

test("OpenCode 1 live cache_ttl edits affect the next idle check without changing prompt identity", async () => {
    const startedAt = new Date().toISOString();
    const previousTmp = process.env.TMPDIR;
    const taskRoot = join(tmpdir(), "magic-context", "issue-624");
    mkdirSync(taskRoot, { recursive: true });
    process.env.TMPDIR = taskRoot;
    let h: TestHarness;
    try {
        h = await TestHarness.create({
            magicContextConfig: {
                cache_ttl: { default: "5m", "mock-anthropic/mock-sonnet": "1h" },
                execute_threshold_percentage: 90,
                historian: { disable: true }, dreamer: { disable: true }, memory: { enabled: false },
            },
        });
    } finally {
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
    }
    const root = dirname(h.opencode.env.configDir);
    const pluginLogPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    const turns: { id: string; time: { completed: number } }[] = [];
    let writer: Database | undefined;
    try {
        expect(realpathSync(root).startsWith(realpathSync(taskRoot) + "/")).toBe(true);
        const health = await fetch(`${h.serverUrl}/global/health`).then(r => r.json()) as { version: string };
        expect(health.version).toMatch(/^1\./);
        const containment = () => {
            const result = spawnSync("timeout", ["10s", "lsof", "-p", String(h.opencode.pid), "-Fn"], { encoding: "utf8" });
            expect(result.status).toBe(0);
            const databases = result.stdout.split("\n").filter(line => /^n.*\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(line)).map(line => line.slice(1));
            writeFileSync(join(taskRoot, `host-lsof-${h.opencode.pid}.txt`), result.stdout);
            expect(databases.length).toBeGreaterThan(0);
            const outside = databases.filter(path => !path.startsWith(root + "/"));
            expect(outside).toEqual([]);
            writeFileSync(join(root, "host-lsof.txt"), result.stdout);
        };
        containment();
        const session = await h.createSession();
        const meta = () => h.contextDb().query("SELECT cache_ttl, trailing_blank_decisions, last_response_time FROM session_meta WHERE session_id = ?").get(session) as { cache_ttl: string; trailing_blank_decisions: string; last_response_time: number };
        const completedPrompt = async (text: string) => {
            const result = await h.sendPrompt(session, text) as { data: { info: { id: string; time: { completed: number } } } };
            const assistant = result.data.info;
            expect(assistant.id).toMatch(/^msg_/);
            expect(assistant.time.completed).toBeGreaterThan(0);
            turns.push(assistant);
            // The usage-bearing step-finish update precedes the terminal assistant
            // update. Only the latter persists this exact completion timestamp.
            // Fence it before backdating the idle clock: the HTTP response alone
            // allows that late host write to undo the fixture's clock edit.
            await h.waitFor(() => meta().last_response_time === assistant.time.completed, { timeoutMs: 5000, label: `${assistant.id} completion clock` });
            return assistant;
        };
        await completedPrompt("Seed a cached conversation.");
        await completedPrompt("Keep the original prefix.");
        const prior = h.requests().filter(r => !bytes(r.body.system).includes("title generator")).at(-1)!;
        writer = new Database(h.contextDbPath());
        // A busy timeout handles SQLite lock contention, not event ordering; the
        // completedPrompt fence above handles the host's late response-clock write.
        writer.exec("PRAGMA busy_timeout = 5000");
        const configPath = join(h.opencode.env.configDir, "cortexkit", "magic-context.jsonc");
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        const edit = (ttl: string) => {
            config.cache_ttl["mock-anthropic/mock-sonnet"] = ttl;
            writeFileSync(configPath, JSON.stringify(config, null, 2));
            // Set only this test session's last provider-response time to an older value. Avoid
            // real-time waits and saved-policy edits so the live loader must choose the new lifetime.
            writer!.query("UPDATE session_meta SET last_response_time = ? WHERE session_id = ?").run(Date.now() - 2 * 60 * 60 * 1000, session);
        };
        const decision = (messageId: string) => h.contextDb().query("SELECT ts_ms, decision, materialize_reason FROM transform_decisions WHERE session_id = ? AND harness = 'opencode' AND message_id = ?").get(session, messageId) as { ts_ms: number; decision: string; materialize_reason: string | null } | null;
        edit("13h");
        const warmLogOffset = readFileSync(pluginLogPath, "utf8").length;
        await completedPrompt("The two-hour idle cache should stay warm.");
        expect(JSON.parse(readFileSync(configPath, "utf8")).cache_ttl["mock-anthropic/mock-sonnet"]).toBe("13h");
        expect(meta().cache_ttl).toBe("13h");
        // An unchanged warm defer has no durable decision row. Read this pass's
        // scheduler line, not the seed assistant's defer/first_render row.
        const warmSchedulers = readFileSync(pluginLogPath, "utf8").slice(warmLogOffset).split("\n")
            .filter(line => line.includes(`[magic-context][${session}] transform scheduler:`));
        expect(warmSchedulers).toHaveLength(1);
        expect(warmSchedulers[0]).toMatch(/cacheTtl=13h .*decision=defer\b/);
        const raised = h.requests().filter(r => !bytes(r.body.system).includes("title generator")).at(-1)!;
        expect(bytes(raised.body.system)).toBe(bytes(prior.body.system));
        expect(bytes(raised.body.tools)).toBe(bytes(prior.body.tools));
        expect(bytes(raised.body.messages?.slice(0, prior.body.messages?.length))).toBe(bytes(prior.body.messages));
        edit("1h");
        const expired = await completedPrompt("Now the same idle interval is expired.");
        expect(JSON.parse(readFileSync(configPath, "utf8")).cache_ttl["mock-anthropic/mock-sonnet"]).toBe("1h");
        expect(meta().cache_ttl).toBe("1h");
        // ts_ms is sampled at the transform tail, before the provider request.
        // The deferred telemetry write binds to the completed assistant's id;
        // that identity, not a wall-clock cutoff, selects this turn's row.
        const expiredDecision = await h.waitFor(() => decision(expired.id), { timeoutMs: 5000, label: "expired turn transform decision" });
        expect(expiredDecision).toMatchObject({ decision: "execute", materialize_reason: "ttl_idle" });
        const policy = JSON.parse(meta().trailing_blank_decisions).cacheTtlPolicy;
        expect(policy).toMatchObject({ value: "1h", source: "config" });
        containment();
        console.log(`OpenCode ${health.version}: TTL 1h -> 13h/defer -> 1h/ttl_idle; PID ${h.opencode.pid} databases contained in ${root}`);
    } finally {
        writer?.close();
        try {
            const hostDb = new Database(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
            try {
                writeFileSync(join(taskRoot, `host-run-${h.opencode.pid}.json`), JSON.stringify({
                    pid: h.opencode.pid, root, projectPath: h.workdir, startedAt,
                    finishedAt: new Date().toISOString(),
                    turns,
                    sessions: hostDb.query("SELECT id FROM session ORDER BY id").all(),
                    projects: h.contextDb().query("SELECT session_id, project_path FROM session_projects").all(),
                    decisions: h.contextDb().query("SELECT * FROM transform_decisions ORDER BY ts_ms").all(),
                    clocks: h.contextDb().query("SELECT session_id, cache_ttl, last_response_time FROM session_meta").all(),
                }, null, 2));
            } finally { hostDb.close(); }
            copyFileSync(pluginLogPath, join(taskRoot, `host-plugin-${h.opencode.pid}.log`));
            writeFileSync(join(taskRoot, `host-stdout-${h.opencode.pid}.log`), h.opencode.stdout());
            writeFileSync(join(taskRoot, `host-stderr-${h.opencode.pid}.log`), h.opencode.stderr());
        } finally { await h.dispose(); }
    }
}, 120_000);
