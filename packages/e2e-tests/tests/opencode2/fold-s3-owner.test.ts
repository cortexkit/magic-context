import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getPendingOps, queuePendingOp } from "../../../plugin/src/features/magic-context/storage";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import { rawMessages } from "../../../plugin/src/v2/hooks/store";
import { spawnOpencode2, waitForPluginActive, waitForPluginLog } from '../../src/opencode2-runner/spawn';
import { readSessionMetaField, writeSessionMetaField } from "../../src/session-meta-fields";

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
for (const mode of ["local", "provider"] as const) {
    test(`I6a I7 I8 I9 R39 ${mode}: host fold costs zero requests and restores unarchived tail`, async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-s3-fold-"));
        const build = await Bun.build({ entrypoints: [join(import.meta.dir, "fold-s3-probe.ts")], outdir: root, naming: "index.js", target: "bun", format: "esm", define: { "process.env.NODE_ENV": '"production"' }, external: ["bun:sqlite", "node:sqlite"] });
        if (!build.success) throw new Error(build.logs.join("\n"));
        // Bun emits an undefined __promiseAll helper for bundled top-level
        // asynchronous initializers. Replace it in this temporary probe only.
        const probe = join(root, "index.js");
        writeFileSync(probe, readFileSync(probe, "utf8").replaceAll("__promiseAll(", "Promise.all("));
        const host = await spawnOpencode2({ probePlugin: root, modelContextLimit: 16_000, modelOutputLimit: 1024 });
        const trace = join(host.cwd, "s3-fold.jsonl");
        try {
            const configDir = join(host.env.XDG_CONFIG_HOME!, "cortexkit");
            mkdirSync(configDir, { recursive: true });
            writeFileSync(join(configDir, "magic-context.jsonc"), JSON.stringify({ historian: { disable: true }, auto_update: false, memory: { enabled: false } }));
            const configPath = join(host.cwd, "opencode.json");
            const config = JSON.parse(readFileSync(configPath, "utf8"));
            config.providers.openai.models["mock-model"].compaction = { mode };
            writeFileSync(configPath, JSON.stringify(config));
            const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
            const session = await client.session.create({ location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
            await waitForPluginActive(client, host.cwd);
            const turn = async (text: string) => {
                await client.session.prompt({ sessionID: session.id, text });
                await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20000) });
            };
            const markers = ["UNARCHIVED-ALPHA-41", "UNARCHIVED-BETA-73", "UNARCHIVED-GAMMA-97"];
            host.mock.setDefault({ text: "source answer", usage: { input_tokens: 100, output_tokens: 10 } });
            for (const marker of markers) await turn(`${marker} ${"source history detail ".repeat(500)}`);
            const reader = new V2StoreReader(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
            const sourceBefore = rawMessages(reader.history(session.id));
            host.mock.setDefault({ text: "pressure answer", usage: { input_tokens: 15000, output_tokens: 10 } });
            await turn("Trigger next-turn pressure");
            const before = host.mock.requests().length;
            host.mock.setDefault({ text: "post-fold answer", usage: { input_tokens: 100, output_tokens: 10 } });
            await turn("First post-fold round-trip");
            const frames = () => readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line));
            const compactions = frames().filter(frame => frame.kind === "compaction");
            expect(compactions).toHaveLength(1);
            expect(host.mock.requests().length - before).toBe(1);
            const cut = reader.latestCompaction(session.id);
            expect(cut?.data.status).toBe("completed");
            expect(cut?.data.summary).toBe(compactions[0].result.summary);
            expect(cut?.data.summary).toContain("<session-history>");
            // In provider mode, the host saves messages not yet included in
            // the summary in `recent`; the next request includes those messages.
            if (mode === "provider") expect(cut?.data.recent).toContain(markers[2]);
            const wire = JSON.stringify(host.mock.requests().at(-1)!.body);
            for (const marker of markers) {
                expect(wire).toContain(marker);
                expect(cut?.data.summary).not.toContain(marker);
            }
            const sourceAfter = rawMessages(reader.history(session.id));
            expect(sourceAfter.slice(0, sourceBefore.length).map(row => [row.id, row.ordinal])).toEqual(sourceBefore.map(row => [row.id, row.ordinal]));
            const first = frames().filter(frame => frame.kind === "context").at(-1);
            expect(first.messages[0].id).toBe(cut?.id);
            expect(first.messages[1].id).toBe("__magic_context_v2_m1__");
            const pinned = sha(first.messages[0]);
            const preservedIDs = new Set(first.messages.map((message: { id?: string }) => message.id).filter(Boolean));
            const preserved = sha(first.messages);
            for (let index = 0; index < 10; index++) {
                await turn(`defer ${index}`);
                const current = frames().filter(frame => frame.kind === "context").at(-1);
                expect(sha(current.messages[0])).toBe(pinned);
                if (index < 3) expect(sha(current.messages.filter((message: { id?: string }) => preservedIDs.has(message.id)))).toBe(preserved);
                for (const marker of markers) expect(JSON.stringify(host.mock.requests().at(-1)!.body)).toContain(marker);
            }
            const beforePublication = host.mock.requests().length;
            host.mock.addMatcher(body => {
                const prompt = JSON.stringify(body);
                const range = prompt.match(/Messages (\d+)-(\d+):/);
                if (!range) return null;
                return { text: `<compartment start="${range[1]}" end="${range[2]}" title="Restored source"><p1>${markers.join(" ")} preserved.</p1></compartment>`, usage: { input_tokens: 100, output_tokens: 10 } };
            });
            await expect(client.session.generate({ sessionID: session.id, prompt: "S3_HISTORIAN" }, { signal: AbortSignal.timeout(30000) })).rejects.toThrow();
            const publication = JSON.parse(readFileSync(join(host.cwd, "s3-proof.json"), "utf8"));
            expect(publication.compartments.length).toBeGreaterThan(0);
            expect(publication.runs[0].status).toBe("success");
            expect(host.mock.requests().length - beforePublication).toBe(1);
            const mc = openTestDb(join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"));
            mc.exec("PRAGMA busy_timeout = 5000");
            queuePendingOp(mc as never, session.id, 2, "drop");
            host.mock.setDefault({ text: "Prime SOFT pressure", usage: { input_tokens: 11000, output_tokens: 10 } });
            await turn("Prime SOFT after publication");
            host.mock.setDefault({ text: "SOFT response", usage: { input_tokens: 100, output_tokens: 10 } });
            await turn("Serve published restored history");
            expect(getPendingOps(mc as never, session.id)).toEqual([]);
            mc.close();
            const afterPublication = frames().filter(frame => frame.kind === "context").at(-1);
            expect(sha(afterPublication.messages[0])).toBe(pinned);
            expect(sha(afterPublication.messages[1])).not.toBe(sha(first.messages[1]));
            const heads = JSON.stringify(afterPublication.messages.slice(0, 2));
            const tail = JSON.stringify(afterPublication.messages.slice(2));
            for (const marker of markers) { expect(heads.includes(marker)).toBe(true); expect(tail.includes(marker)).toBe(false); }
            await turn("Defer after SOFT publication");
            const afterDefer = frames().filter(frame => frame.kind === "context").at(-1);
            expect(sha(afterDefer.messages.slice(0, 2))).toBe(sha(afterPublication.messages.slice(0, 2)));
            const hardDb = openTestDb(join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"));
            hardDb.exec("PRAGMA busy_timeout = 5000");
            const snapshot = () => hardDb.prepare("SELECT cached_m0_materialized_at AS stamp FROM session_meta WHERE session_id = ?").get(session.id) as { stamp: number };
            // Stale persisted identities exercise the same real transform gates as a changed live signal.
            for (const [name, column, stale] of [
                ["model", "cached_m0_model_key", "openai/previous-model"],
                ["provider", "cached_m0_model_key", "previous-provider/mock-model"],
                ["system", "cached_m0_system_hash", "previous-system"],
                ["epoch", "cached_m0_project_memory_epoch", -1],
                ["mutation", "cached_m0_max_mutation_id", -1],
            ] as const) {
                const beforeHard = snapshot().stamp;
                hardDb.prepare(`UPDATE session_meta SET ${column} = ? WHERE session_id = ?`).run(stale, session.id);
                await turn(`HARD ${name}`);
                expect(snapshot().stamp).toBeGreaterThan(beforeHard);
                const hardStamp = snapshot().stamp;
                for (const marker of markers) expect(JSON.stringify(frames().filter(frame => frame.kind === "context").at(-1).messages[0])).toContain(marker);
                const hardHead = frames().filter(frame => frame.kind === "context").at(-1).messages[0];
                await turn(`Defer after HARD ${name}`);
                expect(snapshot().stamp).toBe(hardStamp);
                expect(sha(frames().filter(frame => frame.kind === "context").at(-1).messages[0])).toBe(sha(hardHead));
            }
            const beforeUpgrade = snapshot().stamp;
            // Replace the identity before the first '|' (the whole value when there is none), as
            // SQL `'old-upgrade' || substr(state, instr(state, '|'))` would.
            const upgradeState = readSessionMetaField(hardDb, session.id, "cached_m0_upgrade_state") as string | null | undefined;
            writeSessionMetaField(hardDb, session.id, "cached_m0_upgrade_state", upgradeState == null ? null : `old-upgrade${upgradeState.includes("|") ? upgradeState.slice(upgradeState.indexOf("|")) : upgradeState}`);
            await turn("HARD upgrade state");
            expect(snapshot().stamp).toBeGreaterThan(beforeUpgrade);
            const hostTimes = new Database(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
            const idleTime = Date.now() - 3600000;
            hostTimes.prepare("UPDATE session_message SET data = json_set(data, '$.time.completed', ?) WHERE session_id = ? AND type = 'assistant'").run(idleTime, session.id);
            hostTimes.close();
            hardDb.prepare("UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?").run(idleTime - 1, session.id);
            await turn("HARD TTL expiry");
            expect(snapshot().stamp).toBeGreaterThan(idleTime);
            const beforePressure = snapshot().stamp;
            const pressureText = "PRESSURE-BACKSTOP-CONTENT " + "Preserve concrete evidence of the completed work. ".repeat(4000);
            hardDb.prepare("INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, p1, created_at, harness) VALUES (?, 999, 10000, 10001, 'Pressure backstop', ?, ?, ?, 'opencode2')").run(session.id, pressureText, pressureText, Date.now());
            host.mock.setDefault({ text: "Prime delta pressure", usage: { input_tokens: 11000, output_tokens: 10 } });
            await turn("Prime pressure backstop");
            host.mock.setDefault({ text: "normal", usage: { input_tokens: 100, output_tokens: 10 } });
            await turn("HARD pressure backstop");
            expect(snapshot().stamp).toBeGreaterThan(beforePressure);
            const pressureHead = frames().filter(frame => frame.kind === "context").at(-1).messages[0];
            expect(JSON.stringify(pressureHead)).toContain("PRESSURE-BACKSTOP-CONTENT");
            await turn("Defer after pressure backstop");
            expect(sha(frames().filter(frame => frame.kind === "context").at(-1).messages[0])).toBe(sha(pressureHead));
            hardDb.close();
            const hostDb = new Database(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
            hostDb.prepare("UPDATE session_message SET data = json_set(data, '$.summary', ?) WHERE id = ?").run("CORRUPTED-PERSISTED-SUMMARY", cut!.id);
            hostDb.close();
            await turn("Detect persisted checkpoint divergence");
            expect(await waitForPluginLog(host.env, "HARD reason=host_rerender")).toContain("HARD reason=host_rerender");
            expect(JSON.stringify(host.mock.requests().at(-1)!.body)).not.toContain("CORRUPTED-PERSISTED-SUMMARY");
            const recovered = frames().filter(frame => frame.kind === "context").at(-1);
            await turn("Defer after divergence recovery");
            expect(sha(frames().filter(frame => frame.kind === "context").at(-1).messages[0])).toBe(sha(recovered.messages[0]));
            reader.close();
        } catch (error) { console.error(host.stderr().slice(-8000)); throw error; }
        finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
    }, 90000);
}
