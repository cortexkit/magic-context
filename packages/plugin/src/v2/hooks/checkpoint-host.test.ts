import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { MockProvider } from "../../../../e2e-tests/src/mock-provider/server";
import {
    estimateTokens,
    preloadTokenizer,
} from "../../hooks/magic-context/read-session-formatting";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { V2StoreReader } from "../store-reader";
import { rawMessages } from "./store";

const cli = process.env.MC_ISSUE824_HOST_CLI;
const versionUnderReview = process.env.MC_ISSUE824_HOST_VERSION ?? "2.2.2";

// Opt in with a built plugin and an explicit versioned binary; never resolve a live host from PATH.
test.skipIf(!cli)(
    `${versionUnderReview} checkpoint: fresh and upgraded compactions fit before egress`,
    async () => {
        const parent = join(tmpdir(), "magic-context", "issue824");
        mkdirSync(parent, { recursive: true });
        const root = createTestTempDirFromPath(join(parent, "host-"));
        const env: NodeJS.ProcessEnv = { PATH: process.env.PATH };
        for (const key of [
            "HOME",
            "XDG_DATA_HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_RUNTIME_DIR",
            "XDG_CACHE_HOME",
            "TMPDIR",
            "MAGIC_CONTEXT_STORAGE_DIR",
        ]) {
            env[key] = join(root, key);
            mkdirSync(env[key]!, { mode: 0o700 });
        }
        Object.assign(env, {
            CFFIXED_USER_HOME: env.HOME,
            OPENCODE_DB: "issue824.db",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
            OPENCODE_DISABLE_AUTOUPDATE: "true",
            OPENCODE_DISABLE_MODELS_FETCH: "true",
            MAGIC_CONTEXT_LOG_PATH: join(root, "mc.log"),
            MAGIC_CONTEXT_LOG_SYNC: "1",
        });
        const version = spawnSync(cli!, ["--version"], {
            env,
            encoding: "utf8",
            windowsHide: true,
        });
        expect(version.status).toBe(0);
        expect(version.stdout.trim()).toBe(`opencode v${versionUnderReview}`);
        const plugin = resolve(import.meta.dir, "../../../dist/v2/server.js");
        expect(existsSync(plugin)).toBe(true);
        await preloadTokenizer();
        const mock = new MockProvider();
        const { baseURL } = await mock.start();
        const cwd = join(root, "work");
        mkdirSync(cwd);
        const pre = join(root, "pre"),
            post = join(root, "post"),
            mc = join(root, "plugin");
        for (const path of [pre, post, mc]) mkdirSync(path);
        writeFileSync(join(mc, "server.js"), `export {default} from ${JSON.stringify(plugin)};`);
        for (const [path, label] of [
            [pre, "before"],
            [post, "after"],
        ]) {
            writeFileSync(
                join(path!, "server.js"),
                `import {appendFileSync} from 'node:fs'; export default {id:'checkpoint-${label}',async setup(ctx){await ctx.agent.transform(e=>e.update('build',a=>{a.permissions=[{action:'*',resource:'*',effect:'allow'}]}));await ctx.agent.reload();await ctx.session.hook('context',d=>appendFileSync(${JSON.stringify(join(root, `${label}.jsonl`))},JSON.stringify(d.messages)+'\\n'));}}`,
            );
        }
        const config = join(cwd, "opencode.json");
        const configure = (window: number) =>
            writeFileSync(
                config,
                JSON.stringify({
                    plugins: [pre, mc, post],
                    model: "anthropic/mock",
                    compaction: { auto: false, keep: { tokens: 1024 } },
                    providers: {
                        anthropic: {
                            settings: { baseURL, apiKey: "fixture" },
                            models: {
                                mock: {
                                    name: "mock",
                                    compaction: { mode: "provider" },
                                    limit: { context: window, output: 1024 },
                                },
                            },
                        },
                    },
                }),
            );
        configure(200000);
        mkdirSync(join(env.XDG_CONFIG_HOME!, "cortexkit"));
        writeFileSync(
            join(env.XDG_CONFIG_HOME!, "cortexkit/magic-context.jsonc"),
            JSON.stringify({
                auto_update: false,
                historian: { disable: true },
                dreamer: { disable: true },
                memory: { enabled: false },
                embedding: { provider: "off" },
                cache_ttl: "never",
            }),
        );
        let child: ChildProcess | undefined;
        let client: ReturnType<typeof OpenCode.make>;
        const start = async () => {
            child = spawn(
                cli!,
                ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
                {
                    cwd,
                    env,
                    detached: true,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
            child.stderr!.on("data", (data) => appendFileSync(join(root, "host.log"), data));
            const ready = await new Promise<{ url: string; password: string }>((ok, fail) => {
                let output = "";
                const timer = setTimeout(
                    () => fail(new Error(`Host startup timed out: ${root}`)),
                    60000,
                );
                child!.stdout!.on("data", (data) => {
                    output += data;
                    const url = output.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
                    const password = output.match(/server password (\S+)/)?.[1];
                    if (url && password) {
                        clearTimeout(timer);
                        ok({ url, password });
                    }
                });
                child!.on("exit", (code) => {
                    clearTimeout(timer);
                    fail(new Error(`Host exited: ${code}`));
                });
            });
            client = OpenCode.make({
                baseUrl: ready.url,
                headers: { authorization: `Basic ${btoa(`opencode:${ready.password}`)}` },
            });
            await client.location.get({ location: { directory: cwd } });
            const { awaitPluginActivation } = await import(
                "../../../../e2e-tests/src/opencode2-runner/plugin-activation"
            );
            await awaitPluginActivation(client, cwd, "@cortexkit/opencode-magic-context");
            const lsof = spawnSync("lsof", ["-p", String(child.pid)], {
                encoding: "utf8",
                windowsHide: true,
            });
            expect(lsof.status).toBe(0);
            writeFileSync(join(root, `lsof-${Date.now()}.txt`), lsof.stdout);
            const databases = lsof.stdout
                .split("\n")
                .filter((line) => /\.db(?:\b|[- ])/.test(line));
            expect(databases.length).toBeGreaterThan(0);
            expect(databases.every((line) => line.includes(root))).toBe(true);
        };
        const stop = async () => {
            if (child?.pid && child.exitCode === null) {
                const exited = new Promise((ok) => child!.once("exit", ok));
                process.kill(-child.pid, "SIGKILL");
                await exited;
            }
            child = undefined;
        };
        const hostDB = join(env.XDG_DATA_HOME!, "opencode/issue824.db");
        const rows = (sid: string) => {
            const reader = new V2StoreReader(hostDB);
            try {
                return rawMessages(reader.history(sid));
            } finally {
                reader.close();
            }
        };
        const sha = (value: unknown) =>
            createHash("sha256").update(JSON.stringify(value)).digest("hex");
        let sid = "",
            building = false,
            step = 0,
            enforceWindow = false;
        mock.addMatcher((body) => {
            const wire = JSON.stringify(body);
            if (enforceWindow && estimateTokens(wire) > 21000)
                return {
                    error: {
                        status: 400,
                        type: "invalid_request_error",
                        message: "prompt is too long: exceeds 21000 tokens",
                    },
                };
            if (building && step === 6) {
                const raw = rows(sid),
                    end = raw.at(-2)!;
                const db = new Database(join(env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"));
                const summary =
                    "Published tool evidence: TOOL-ROW-1 TOOL-ROW-2 TOOL-ROW-3 TOOL-ROW-4 TOOL-ROW-5.";
                db.query(
                    "INSERT INTO compartments (session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at,harness) VALUES (?,1,?,?,?,?,'Published history fixture',?,?,?,'opencode2')",
                ).run(
                    sid,
                    raw[0]!.ordinal,
                    end.ordinal,
                    raw[0]!.id,
                    end.id,
                    summary,
                    summary,
                    Date.now(),
                );
                db.query(
                    "UPDATE session_meta SET cached_m0_model_key='fixture/previous-model' WHERE session_id=?",
                ).run(sid);
                db.close();
            }
            if (building && step++ < 12)
                return {
                    content: [
                        {
                            type: "tool_use" as const,
                            id: `call_${step}`,
                            name: "shell",
                            input: {
                                command:
                                    `python3 -c 'print("TOOL-ROW-${step} " + "historical evidence boundary context " * 350)'` +
                                    (step === 1
                                        ? ` # ${"raw-input-checkpoint-padding ".repeat(3000)}`
                                        : ""),
                            },
                        },
                    ],
                    stop_reason: "tool_use" as const,
                    usage: { input_tokens: 100, output_tokens: 30 },
                };
            return { text: "done", usage: { input_tokens: 100, output_tokens: 10 } };
        });
        const turn = async (text: string) => {
            const offset = mock.requests().length;
            await client.session.prompt({ sessionID: sid, text });
            await client.session.wait({ sessionID: sid }, { signal: AbortSignal.timeout(90000) });
            const captures = mock.requests().slice(offset);
            for (const [i, capture] of captures.entries())
                writeFileSync(join(root, `${text}-${i}.request.json`), capture.rawBody!);
            return captures;
        };
        try {
            await start();
            sid = (
                await client!.session.create({
                    location: { directory: cwd },
                    title: "checkpoint regression",
                    model: { providerID: "anthropic", id: "mock" },
                })
            ).id;
            await turn("initialize");
            building = true;
            await turn("build-history");
            building = false;
            // Apply the smaller window before compaction, without sending another
            // context request. The next turn is the first to use the fresh checkpoint.
            await stop();
            configure(21000);
            enforceWindow = true;
            await start();
            await client!.session.compact({ sessionID: sid });
            await client!.session.wait({ sessionID: sid }, { signal: AbortSignal.timeout(60000) });
            const db = new Database(hostDB);
            const cut = db
                .query(
                    "SELECT id,data FROM session_message WHERE session_id=? AND type='compaction' ORDER BY seq DESC LIMIT 1",
                )
                .get(sid) as { id: string; data: string };
            const data = JSON.parse(cut.data);
            expect(data.status).toBe("completed");
            expect(Object.hasOwn(data.metadata ?? {}, "keepID")).toBe(false);
            const storedRecent = data.metadata?.recent ?? data.recent ?? "";
            if (versionUnderReview === "2.0.22") {
                // 2.0.22 copies recent separately from the supplied hook result;
                // keepID only suppresses stored recent in the 2.1+ host protocol.
                expect(storedRecent).not.toBe("");
            } else {
                expect(storedRecent).toBe("");
            }
            const frames = (label: string) =>
                readFileSync(join(root, `${label}.jsonl`), "utf8")
                    .trim()
                    .split("\n")
                    .map((line) => JSON.parse(line));
            const logOffset = readFileSync(join(root, "mc.log"), "utf8").length;
            const fresh = await turn("new-compaction");
            expect(fresh).toHaveLength(1);
            expect(fresh[0]!.rawBody).not.toContain("<recent-context>");
            expect(estimateTokens(fresh[0]!.rawBody!)).toBeLessThanOrEqual(21000);
            for (let i = 6; i <= 12; i++) expect(fresh[0]!.rawBody).toContain(`TOOL-ROW-${i}`);
            if (versionUnderReview === "2.0.22") {
                const incoming = JSON.stringify(frames("before").at(-1));
                expect(incoming).toContain("<recent-context>");
                expect(estimateTokens(incoming)).toBeGreaterThan(21000);
                const passLog = readFileSync(join(root, "mc.log"), "utf8").slice(logOffset);
                console.log(
                    `fresh legacy checkpoint: input=${estimateTokens(incoming)} wire=${estimateTokens(fresh[0]!.rawBody!)}\n${passLog
                        .split("\n")
                        .filter((line) => /HARD fold decision|heuristics WILL RUN/.test(line))
                        .join("\n")}`,
                );
            }

            // Recreate the old host record, then pin exactly the wrapper that an old
            // plugin observed. No live or external store is involved in this fixture.
            const user = db
                .query(
                    "SELECT id FROM session_message WHERE session_id=? AND type='user' ORDER BY seq LIMIT 1 OFFSET 1",
                )
                .get(sid) as { id: string };
            data.metadata = { ...data.metadata, keepID: user.id };
            db.query("UPDATE session_message SET data=? WHERE id=?").run(
                JSON.stringify(data),
                cut.id,
            );
            db.close();
            await stop();
            await start();
            await turn("legacy-checkpoint");
            const legacy = frames("before")
                .at(-1)
                .find((message: { id?: string }) => message.id === cut.id);
            expect(JSON.stringify(legacy)).toContain("<recent-context>");
            expect(estimateTokens(JSON.stringify(legacy))).toBeGreaterThan(21000);
            await stop();
            const seed = new Database(hostDB);
            const fold = seed
                .query("SELECT key,value FROM kv WHERE key LIKE ?")
                .get(`%fold/v1/${sid}`) as { key: string; value: string };
            const state = JSON.parse(fold.value);
            state.rendered = legacy;
            state.renderedSha = sha(legacy);
            state.renderedSummary = data.summary;
            delete state.withoutRecentContext;
            delete state.rejectedSha;
            seed.query("UPDATE kv SET value=? WHERE key=?").run(JSON.stringify(state), fold.key);
            seed.close();
            const before = rows(sid).map((row) => ({ id: row.id, sha: sha(row) }));
            configure(21000);
            enforceWindow = true;
            await start();
            const upgraded = await turn("first-upgrade");
            expect(upgraded).toHaveLength(1);
            expect(upgraded[0]!.rawBody).not.toContain("<recent-context>");
            expect(estimateTokens(upgraded[0]!.rawBody!)).toBeLessThanOrEqual(21000);
            const oldIDs = new Set(before.map((row) => row.id));
            expect(
                rows(sid)
                    .filter((row) => oldIDs.has(row.id))
                    .map((row) => ({ id: row.id, sha: sha(row) })),
            ).toEqual(before);
            const rawStore = JSON.stringify(rows(sid));
            for (let i = 6; i <= 12; i++) expect(rawStore).toContain(`TOOL-ROW-${i}`);
            const repaired = JSON.stringify(frames("after").at(-1)[0]);
            for (let i = 0; i < 3; i++) {
                await turn(`cache-hit-${i}`);
                expect(JSON.stringify(frames("after").at(-1)[0])).toBe(repaired);
            }
            console.log(`checkpoint host checked isolated stores at ${root}`);
        } finally {
            await stop();
            await mock.stop();
        }
    },
    300000,
);
