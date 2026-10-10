import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { closeDatabase } from "../../../plugin/src/features/magic-context/storage-db";
import { clearCachedM0M1 } from "../../../plugin/src/features/magic-context/storage-meta-shared";
import {
    assertOpenPaths,
    CLI,
    ROOT_KEYS,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

function fixture() {
    const base = join(tmpdir(), "magic-context", "issue-592");
    mkdirSync(base, { recursive: true });
    const root = realpathSync(mkdtempSync(join(base, "capture-")));
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        OPENCODE_DB: "opencode2.db",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        TMPDIR: root,
    };
    for (const key of ROOT_KEYS) {
        env[key] = join(root, key);
        mkdirSync(env[key]!);
    }
    const cwd = join(root, "work");
    mkdirSync(cwd);
    env.MAGIC_CONTEXT_STORAGE_DIR = join(
        env.XDG_DATA_HOME!,
        "cortexkit",
        "magic-context",
    );
    return { root, env, cwd };
}

function snapshot(path: string): string {
    const db = new Database(path, { readonly: true });
    try {
        const tables = db
            .query(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() as { name: string }[];
        return JSON.stringify(
            tables.map(({ name }) => [
                name,
                db
                    .query(`SELECT * FROM "${name}"`)
                    .all()
                    .map((row) => JSON.stringify(row))
                    .sort(),
            ]),
        );
    } finally {
        db.close();
    }
}

function assertStoresClosed(paths: string[], root: string, stage: string): void {
    const inventory = spawnSync("lsof", ["-p", String(process.pid), "-Fn"], {
        encoding: "utf8",
        windowsHide: true,
    });
    expect(inventory.status).toBe(0);
    writeFileSync(join(root, `lsof-${stage}.txt`), inventory.stdout);
    // Bun can report a closed JS handle while cached prepare() statements still
    // hold native WAL descriptors. Replacing bytes under those handles is unsafe.
    expect(
        inventory.stdout.split("\n").filter((line) =>
            paths.some((path) => line.startsWith(`n${path}`)),
        ),
    ).toEqual([]);
}

test("OpenCode 2 generate serves managed bytes without writes and preserves replay", async () => {
    const f = fixture();
    const version = spawnSync(CLI, ["--version"], {
        env: f.env,
        cwd: f.cwd,
        encoding: "utf8",
        windowsHide: true,
    });
    expect(version.status).toBe(0);
    console.info(`generate host=${version.stdout.trim()} root=${f.root}`);
    const probe = join(f.root, "probe");
    mkdirSync(probe);
    const trace = join(f.root, "trace.jsonl");
    writeFileSync(
        join(probe, "server.js"),
        `
        import mc from ${JSON.stringify(new URL("../../../plugin/dist/v2/server.js", import.meta.url).pathname)};
        import { appendFileSync } from 'node:fs';
        export default { id:'opencode-magic-context', async setup(context) {
            const session=new Proxy(context.session,{get(target,key) {
                if(key!=='hook') return Reflect.get(target,key);
                return (name,callback)=>target.hook(name,async draft=>{
                    const before={system:draft.system,messages:draft.messages};
                    const raw=JSON.parse(JSON.stringify(before));
                    await callback(draft);
                    if(name==='context'||name==='generate') appendFileSync(${JSON.stringify(trace)},JSON.stringify({name,raw,served:{system:draft.system,messages:draft.messages}})+'\\n');
                });
            }});
            return mc.setup(new Proxy(context,{get(target,key){return key==='session'?session:Reflect.get(target,key);}}));
        }};
    `,
    );
    const host = await spawnOpencode2({
        existingIsolation: f,
        includeMagicContext: false,
        probePlugin: probe,
        compactionAuto: false,
        magicContextConfig: {
            dreamer: { disable: true },
            memory: { enabled: false },
            historian: { disable: true },
            temporal_awareness: false,
        },
    });
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: {
                authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
            },
        });
        const session = await client.session.create({
            title: "generate test",
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        await waitForPluginActive(client, host.cwd);
        const prompt = async (text: string) => {
            await client.session.prompt({ sessionID: session.id, text });
            await client.session.wait(
                { sessionID: session.id },
                { signal: AbortSignal.timeout(60000) },
            );
            await Bun.sleep(500);
        };
        host.mock.enqueue({
            openaiOutput: [
                {
                    type: "function_call",
                    id: "fc_generate",
                    call_id: "call_generate",
                    name: "bash",
                    arguments: JSON.stringify({
                        command: "printf RAW-DROPPED-OUTPUT",
                        description: "Produce drop fixture",
                    }),
                },
            ],
            usage: { input_tokens: 100, output_tokens: 10 },
        });
        await prompt("FIRST-QUESTION");
        const frames = () =>
            readFileSync(trace, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
        const first = frames().filter((frame) => frame.name === "context")[0];
        const start = first.raw.messages[0].id;
        const dbPath = join(f.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db");
        const db = new Database(dbPath);
        db.query(
            `INSERT INTO compartments (session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,created_at,harness) VALUES (?,0,1,1,?,?,'Seeded work','GENERATE-COMPARTMENT','GENERATE-COMPARTMENT',?,'opencode')`,
        ).run(session.id, start, start, Date.now());
        const drop = db
            .query(
                "UPDATE tags SET status='dropped',drop_mode='output' WHERE session_id=? AND type='tool' AND message_id='call_generate'",
            )
            .run(session.id);
        expect(drop.changes).toBeGreaterThan(0);
        clearCachedM0M1(db as never, session.id);
        // clearCachedM0M1 prepares one-shot statements on this direct handle.
        // Plain close() would leave the native connection open until the
        // garbage collector finalizes them; close(true) finalizes them now,
        // which the descriptor check before the store restore relies on.
        db.close(true);
        await prompt("SECOND-QUESTION");
        const served = frames()
            .filter((frame) => frame.name === "context")
            .at(-1).served;
        expect(JSON.stringify(served)).toContain("GENERATE-COMPARTMENT");
        expect(JSON.stringify(served)).not.toContain("RAW-DROPPED-OUTPUT");
        const fds = spawnSync("lsof", ["-p", String(host.pid), "-Fn"], {
            encoding: "utf8",
            windowsHide: true,
        });
        expect(fds.status).toBe(0);
        writeFileSync(join(f.root, "lsof-with-mc.txt"), fds.stdout);
        const paths = fds.stdout
            .split("\n")
            .filter((line) => line.startsWith("n"))
            .map((line) => line.slice(1));
        assertOpenPaths(paths, f.root);
        console.info(
            `generate lsof databases=${JSON.stringify(paths.filter((path) => /\.db(-wal|-shm)?$/.test(path)))}`,
        );
        const mainTools = host.mock
            .requests()
            .filter((request) =>
                JSON.stringify(request.body).includes("SECOND-QUESTION"),
            )
            .at(-1)!.body.tools;
        const before = snapshot(dbPath);
        const generate = async () => {
            const response = await fetch(
                `${host.url}/api/session/${session.id}/generate`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ prompt: "SIDE-QUESTION" }),
                    signal: AbortSignal.timeout(60000),
                },
            );
            expect(response.status).toBe(200);
            await response.text();
        };
        await generate();
        expect(snapshot(dbPath)).toBe(before);
        await generate();
        expect(snapshot(dbPath)).toBe(before);
        const sides = frames().filter((frame) => frame.name === "generate");
        expect(sides).toHaveLength(2);
        expect(
            JSON.stringify(
                sides[0].served.messages.slice(0, served.messages.length),
            ),
        ).toBe(JSON.stringify(served.messages));
        expect(JSON.stringify(sides[0].served.system)).toBe(
            JSON.stringify(served.system),
        );
        expect(JSON.stringify(sides[0].raw)).not.toContain(
            "GENERATE-COMPARTMENT",
        );
        expect(JSON.stringify(sides[0].raw)).toContain("RAW-DROPPED-OUTPUT");
        expect(JSON.stringify(sides[0].served)).not.toContain(
            "RAW-DROPPED-OUTPUT",
        );
        expect(JSON.stringify(sides[0].served)).toBe(
            JSON.stringify(sides[1].served),
        );
        const requests = host.mock
            .requests()
            .filter((request) =>
                JSON.stringify(request.body).includes("SIDE-QUESTION"),
            );
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0].body)).toContain(
            "GENERATE-COMPARTMENT",
        );
        expect(JSON.stringify(requests[0].body.tools)).toBe(
            JSON.stringify(mainTools),
        );
        expect(JSON.stringify(requests[0].body)).toBe(
            JSON.stringify(requests[1].body),
        );
        await prompt("NEXT-MAIN-QUESTION");
        console.info(
            `generate captures=${trace}; MC database unchanged; repeated provider body identical`,
        );
        writeFileSync(
            join(f.root, "requests.json"),
            JSON.stringify(host.mock.requests(), null, 2),
        );
        await host.stop();
        closeDatabase();
        // Restart both arms from the same persisted session, in the same directories.
        // Comparing provider bodies avoids random host message IDs that are not sent.
        const hostDb = join(
            f.env.XDG_DATA_HOME!,
            "opencode",
            f.env.OPENCODE_DB!,
        );
        assertStoresClosed([dbPath, hostDb], f.root, "before-snapshot");
        const saved = [dbPath, hostDb].map((path) => {
            // stop() kills the host, so its last committed frames may still be
            // in the WAL. Checkpoint before saving only the main database bytes.
            const checkpoint = new Database(path);
            try {
                expect(checkpoint.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
                    busy: 0, log: 0, checkpointed: 0,
                });
                expect(checkpoint.query("PRAGMA integrity_check").all()).toEqual([
                    { integrity_check: "ok" },
                ]);
            } finally {
                checkpoint.close();
            }
            return { path, bytes: readFileSync(path) };
        });
        const unmanaged = await spawnOpencode2({
            existingIsolation: f,
            includeMagicContext: false,
            compactionAuto: false,
        });
        try {
            const response = await fetch(
                `${unmanaged.url}/api/session/${session.id}/generate`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Basic ${btoa(`opencode:${unmanaged.password}`)}`,
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ prompt: "UNMANAGED-SIDE" }),
                    signal: AbortSignal.timeout(60000),
                },
            );
            expect(response.status).toBe(200);
            await response.text();
            const wire = unmanaged.mock
                .requests()
                .filter((request) =>
                    JSON.stringify(request.body).includes("UNMANAGED-SIDE"),
                );
            expect(wire).toHaveLength(1);
            expect(JSON.stringify(wire[0]!.body)).not.toContain(
                "GENERATE-COMPARTMENT",
            );
            expect(JSON.stringify(wire[0]!.body)).toContain(
                "RAW-DROPPED-OUTPUT",
            );
            writeFileSync(
                join(f.root, "requests-without-mc.json"),
                JSON.stringify(wire, null, 2),
            );
            const descriptors = spawnSync(
                "lsof",
                ["-p", String(unmanaged.pid), "-Fn"],
                { encoding: "utf8", windowsHide: true },
            );
            expect(descriptors.status).toBe(0);
            writeFileSync(join(f.root, "lsof-without-mc.txt"), descriptors.stdout);
            assertOpenPaths(
                descriptors.stdout
                    .split("\n")
                    .filter((line) => line.startsWith("n"))
                    .map((line) => line.slice(1)),
                f.root,
            );
        } finally {
            await unmanaged.stop();
            closeDatabase();
        }
        const mainBodies: string[] = [];
        for (const side of [false, true]) {
            assertStoresClosed([dbPath, hostDb], f.root, `before-restore-${side}`);
            for (const { path, bytes } of saved) {
                for (const suffix of ["-wal", "-shm"])
                    if (existsSync(path + suffix)) unlinkSync(path + suffix);
                writeFileSync(path, bytes);
            }
            const arm = await spawnOpencode2({
                existingIsolation: f,
                includeMagicContext: false,
                probePlugin: probe,
                compactionAuto: false,
                magicContextConfig: {
                    dreamer: { disable: true },
                    memory: { enabled: false },
                    historian: { disable: true },
                    temporal_awareness: false,
                },
            });
            try {
                const armClient = OpenCode.make({
                    baseUrl: arm.url,
                    headers: {
                        authorization: `Basic ${btoa(`opencode:${arm.password}`)}`,
                    },
                });
                await waitForPluginActive(armClient, arm.cwd);
                const turn = async (text: string) => {
                    await armClient.session.prompt({
                        sessionID: session.id,
                        text,
                    });
                    await armClient.session.wait(
                        { sessionID: session.id },
                        { signal: AbortSignal.timeout(60000) },
                    );
                    await Bun.sleep(500);
                };
                arm.mock.setDefault({
                    openaiOutput: [
                        {
                            type: "message",
                            id: "msg_counterfactual_fixed",
                            role: "assistant",
                            content: [
                                {
                                    type: "output_text",
                                    text: "fixture reply",
                                    annotations: [],
                                    logprobs: [],
                                },
                            ],
                        },
                    ],
                    usage: { input_tokens: 100, output_tokens: 10 },
                });
                await turn("PRIME-CACHE");
                if (side) {
                    const previous = snapshot(dbPath);
                    const result = await fetch(
                        `${arm.url}/api/session/${session.id}/generate`,
                        {
                            method: "POST",
                            headers: {
                                authorization: `Basic ${btoa(`opencode:${arm.password}`)}`,
                                "content-type": "application/json",
                            },
                            body: JSON.stringify({
                                prompt: "COUNTERFACTUAL-SIDE",
                            }),
                            signal: AbortSignal.timeout(60000),
                        },
                    );
                    expect(result.status).toBe(200);
                    await result.text();
                    expect(snapshot(dbPath)).toBe(previous);
                }
                await turn("COUNTERFACTUAL-MAIN");
                const main = arm.mock
                    .requests()
                    .filter((request) =>
                        JSON.stringify(request.body).includes(
                            "COUNTERFACTUAL-MAIN",
                        ),
                    );
                expect(main).toHaveLength(1);
                mainBodies.push(JSON.stringify(main[0]!.body));
                writeFileSync(
                    join(f.root, `counterfactual-${side}.json`),
                    mainBodies.at(-1)!,
                );
            } finally {
                await arm.stop();
                closeDatabase();
            }
        }
        expect(mainBodies[1]).toBe(mainBodies[0]);
        console.info(
            "next main provider body byte-identical with and without generate",
        );
    } catch (error) {
        console.error(host.stderr());
        throw error;
    } finally {
        await host.stop();
    }
}, 120000);
