import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { type RpcPortFileRecord, rpcPortDir } from "../../../plugin/src/shared/rpc-utils";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
    CLI,
    inspectOpenFiles,
    isolation,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

/**
 * Hidden runs (historian, dreamer) on a real OpenCode 2 host, through the shipped plugin.
 *
 * OpenCode 2.0.22 creates each hidden child under the user's session and removes it when the
 * run ends, leaving no root session behind. The probe reports the native capability and the
 * parent and metadata observed while each child is running.
 */

const REVIEW_PROMPT_MARKER = "Review User Memory Candidates";

interface ProbedSession {
    sessionID: string;
    parentID?: string | null;
    metadata?: { magic_context?: string; role?: string } | null;
    error?: string;
}

async function eventually<T>(
    read: () => T | undefined | Promise<T | undefined>,
    what: string,
    timeoutMs = 60_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(100);
    }
}

function withContextDb<T>(env: NodeJS.ProcessEnv, use: (db: Database) => T, writable = false): T {
    const db = openTestDb(join(env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), {
        ...(writable ? { readwrite: true } : { readonly: true }),
        fileMustExist: true,
    }, Database);
    try {
        return use(db);
    } finally {
        db.close();
    }
}

test("hidden runs on OpenCode 2.0.22 are parented and removed with no root children", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "mc-hidden-child-native-probe-"));
    const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "hidden-child-native-probe.ts")],
        outdir: bundleDir,
        naming: "index.js",
        target: "node",
        format: "esm",
    });
    if (!build.success) throw new Error(build.logs.join("\n"));

    const fixture = isolation();
    const logPath = join(fixture.root, "magic-context.log");
    fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
    const host = await spawnOpencode2({
        existingIsolation: fixture,
        probePlugin: bundleDir,
        modelContextLimit: 200_000,
        modelOutputLimit: 1_024,
        magicContextConfig: {
            historian: { two_pass: false },
            dreamer: { tasks: { "review-user-memories": { schedule: "0 3 * * *" } } },
        },
    });
    const pluginLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        const user = await client.session.create({
            title: "user session",
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        await waitForPluginActive(client, host.cwd);
        await waitForPluginActive(client, host.cwd, "mc-hidden-child-native-probe");
        const capability = JSON.parse(
            readFileSync(join(host.cwd, "native-probe-capability.json"), "utf8"),
        ) as { remove: string; metadataForward: string; metadataSemantics: string };
        const native = capability.remove === "function";
        expect(capability.metadataForward).toBe("stored");
        expect(capability.metadataSemantics).toBe("replace");
        const cliVersion = (
            JSON.parse(
                readFileSync(join(realpathSync(CLI), "..", "..", "package.json"), "utf8"),
            ) as { version: string }
        ).version;
        // Evidence for the record: which build ran, what it offers, and that every database the
        // host process holds open lives under this test's throwaway root.
        const openDatabases = inspectOpenFiles(host.pid!, host.root, host.env).filter((path) =>
            /\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(path),
        );
        console.log(
            JSON.stringify({
                cli: CLI,
                cliVersion,
                sessionRemove: capability.remove,
                metadataForward: capability.metadataForward,
                openDatabases,
            }),
        );
        expect(openDatabases.length).toBeGreaterThan(0);
        expect(openDatabases.every((path) => path.startsWith(host.root))).toBe(true);

        const roots = async () =>
            (await client.session.list({ directory: host.cwd, parentID: null })).data.map(
                (session) => ({
                    id: session.id,
                    parentID: session.parentID,
                    hidden: session.metadata?.magic_context === "hidden-run",
                }),
            );
        const childrenOfUser = async () =>
            (await client.session.list({ directory: host.cwd, parentID: user.id })).data.map(
                (session) => session.id,
            );
        const exists = async (sessionID: string) => {
            try {
                await client.session.get({ sessionID });
                return true;
            } catch {
                return false;
            }
        };
        host.mock.setDefault({ text: "late reply", delayMs: 5000, usage: { input_tokens: 10, output_tokens: 2 } });
        writeFileSync(join(host.cwd, "native-remove-start"), "start");
        await eventually(() => host.mock.requests().some((request) => JSON.stringify(request.body).includes("running remove probe")) ? true : undefined, "running child's provider request");
        writeFileSync(join(host.cwd, "native-remove-now"), "remove");
        const removal = await eventually(() => {
            const path = join(host.cwd, "native-remove-done.json");
            return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { id: string; missingError: string; error?: string } : undefined;
        }, "native removal of a running child");
        expect(removal.error).toBeUndefined();
        expect(await exists(removal.id)).toBe(false);
        expect(removal.missingError).toMatch(/not.*found/i);
        const probed = (role: string): ProbedSession[] => {
            const path = join(host.cwd, "native-probe-sessions.jsonl");
            if (!existsSync(path)) return [];
            return readFileSync(path, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => JSON.parse(line) as ProbedSession)
                .filter(
                    (entry) =>
                        entry.metadata?.magic_context === "hidden-run" &&
                        entry.metadata.role === role,
                );
        };

        // Give the historian something to compress.
        host.mock.setDefault({ text: "ordinary turn", usage: { input_tokens: 100, output_tokens: 10 } });
        for (let index = 0; index < 6; index++) {
            await client.session.prompt({
                sessionID: user.id,
                text: `Source turn ${index}: ${"durable history ".repeat(80)}`,
            });
            await client.session.wait({ sessionID: user.id }, { signal: AbortSignal.timeout(30_000) });
        }
        const rootsBefore = await roots();
        console.log(JSON.stringify({ rootsBefore }));
        expect(rootsBefore.filter((session) => session.hidden)).toEqual([]);

        // Historian: /ctx-recomp runs it through the hidden executor.
        host.mock.addMatcher((body) => {
            const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
            if (!range) return null;
            return {
                text: `<compartment start="${range[1]}" end="${range[2]}" title="Rebuilt"><p1>Rebuilt history.</p1></compartment>`,
                usage: { input_tokens: 100, output_tokens: 40 },
            };
        });
        await client.session.command({ sessionID: user.id, name: "ctx-recomp", text: "" });
        await eventually(
            () => (pluginLog().includes("recomp finished (published=true)") ? true : undefined),
            "the historian rebuild to publish",
        );
        const historianChildren = await eventually(
            () => (probed("historian").length > 0 ? probed("historian") : undefined),
            "the historian child to be shaped",
        );

        // Dreamer: a manual run of a task that asks the model one question.
        withContextDb(
            host.env,
            (db) => {
                const insert = db.prepare(
                    "INSERT INTO user_memory_candidates (content, session_id, created_at) VALUES (?, ?, ?)",
                );
                insert.run("User asks for short answers", "seed-a", Date.now());
                insert.run("User dislikes long preambles", "seed-b", Date.now());
                insert.run("User wants the answer first", "seed-c", Date.now());
            },
            true,
        );
        host.mock.addMatcher((body) =>
            JSON.stringify(body).includes(REVIEW_PROMPT_MARKER)
                ? {
                      text: '{"promote":[{"content":"Prefers short answers","candidate_ids":[1,2,3]}],"update_existing":[],"dismiss_existing":[],"consume_candidate_ids":[1,2,3]}',
                      usage: { input_tokens: 120, output_tokens: 40 },
                  }
                : null,
        );
        const discovery = await eventually(() => {
            const directory = rpcPortDir(host.env.MAGIC_CONTEXT_STORAGE_DIR!, host.cwd);
            if (!existsSync(directory)) return undefined;
            const file = readdirSync(directory).find(
                (name) => name.startsWith("port-") && name.endsWith(".json"),
            );
            return file
                ? (JSON.parse(readFileSync(join(directory, file), "utf8")) as RpcPortFileRecord)
                : undefined;
        }, "the RPC discovery file");
        const dream = await fetch(`http://127.0.0.1:${discovery.port}/rpc/dream`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${discovery.token}`,
            },
            body: JSON.stringify({ sessionId: user.id, task: "review-user-memories" }),
        });
        expect(dream.status).toBe(200);
        expect(await dream.json()).toMatchObject({ ok: true });
        await eventually(
            () =>
                withContextDb(host.env, (db) =>
                    (
                        db
                            .prepare("SELECT COUNT(*) AS count FROM user_memories WHERE status = 'active'")
                            .get() as { count: number }
                    ).count > 0
                        ? true
                        : undefined,
                ),
            "the dreamer's promotion to reach the database",
        );
        const dreamerChildren = await eventually(
            () => (probed("dreamer").length > 0 ? probed("dreamer") : undefined),
            "the dreamer child to be shaped",
        );
        const hiddenChildren = [...historianChildren, ...dreamerChildren];
        console.log(JSON.stringify({ hiddenChildren }));

        expect(native).toBe(true);
        {
            // Each hidden child was created under the user's session...
            for (const child of hiddenChildren) expect(child.parentID).toBe(user.id);
            // ...and is gone once its run has ended.
            for (const child of hiddenChildren) {
                await eventually(
                    async () => ((await exists(child.sessionID)) ? undefined : true),
                    `hidden child ${child.sessionID} to be removed`,
                );
            }
            const rootsAfter = await roots();
            console.log(JSON.stringify({ rootsAfter, childrenOfUser: await childrenOfUser() }));
            expect(rootsAfter).toEqual(rootsBefore);
            expect(await childrenOfUser()).toEqual([]);
            // Nothing about these children is recorded for later cleanup.
            expect(
                withContextDb(host.env, (db) =>
                    db
                        .prepare(
                            "SELECT value FROM schema_migrations_meta WHERE key LIKE 'opencode2_hidden_children:%'",
                        )
                        .all(),
                ),
            ).toEqual([]);
            expect(pluginLog()).not.toContain("does not keep the parent of hidden-run sessions");
        }
        expect(pluginLog()).not.toContain("could not be removed");
        expect(pluginLog()).not.toContain("could not read back hidden child");
    } catch (error) {
        console.error(host.stderr(), pluginLog().slice(-20_000));
        throw error;
    } finally {
        await host.stop();
        rmSync(bundleDir, { recursive: true, force: true });
    }
    // Two hidden runs plus a real host's boot and its teardown checks (open-file inspection and the
    // home-directory write fence) have taken over ten minutes on a heavily loaded machine.
}, 900_000);
