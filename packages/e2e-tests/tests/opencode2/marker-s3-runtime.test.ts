import { openTestDb } from "../../src/test-db";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "../../../plugin/node_modules/typescript";
import { OpenCode } from "@opencode/client";
import { TestHarness } from "../../src/harness";
import { spawnOpencode2, waitForPluginActive } from '../../src/opencode2-runner/spawn';
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";
import { getCompartmentLeaseBlocker } from "../../../plugin/src/features/magic-context/compartment-lease";

const names = ["applyDeferredCompactionMarker", "reconcileMarkerRepresentation", "setPendingCompactionMarkerState", "updateCompactionMarkerAfterPublication"];

async function waitForWriterDrain(trace: string, sessionId: string, messageIds: string[]) {
    expect(messageIds.length).toBeGreaterThan(0);
    const rows = () => readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const drained = () => {
        const events = rows();
        const index = events.filter(row => row.kind === "index");
        const settled = new Map(index.filter(row => row.sessionId === sessionId && row.messageId).map(row => [row.messageId, row.outcome]));
        const queue = index.at(-1)?.queue;
        const embeddings = events.filter(row => row.kind === "embeddings" && row.sessionId === sessionId);
        return messageIds.every(id => {
            const outcome = settled.get(id);
            return outcome?.status === "indexed" || (outcome?.status === "skipped" && /already (completed|current)|inserted=false/.test(outcome.reason));
        }) && queue?.incrementalTimers === 0 && queue.pendingIncremental === 0 && queue.activeSessionLocks === 0
            && embeddings.filter(row => row.status === "started").length === embeddings.filter(row => row.status !== "started").length;
    };
    // File notifications carry producer completion, not a guessed quiet window.
    // Watch before checking so a worker finishing during setup cannot be missed.
    await new Promise<void>((resolve, reject) => {
        const watcher = watch(trace, check);
        const timer = setTimeout(() => finish(new Error(`context writers did not drain: ${JSON.stringify(rows().slice(-10))}`)), 15000);
        function finish(error?: Error) { clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); }
        function check() { try { if (drained()) finish(); } catch (error) { finish(error as Error); } }
        check();
    });
    console.info("I10_WRITERS_DRAINED", JSON.stringify({ sessionId, messages: messageIds.length, last: rows().at(-1) }));
}

async function instrument() {
    const root = mkdtempSync(join(tmpdir(), "mc-s3-markers-"));
    const trace = join(root, "calls.jsonl");
    const phaseTrace = join(root, "publication.jsonl");
    const writerTrace = join(root, "writers.jsonl");
    writeFileSync(trace, "");
    writeFileSync(phaseTrace, "");
    writeFileSync(writerTrace, "");
    symlinkSync(resolve(import.meta.dir, "../../../plugin/node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    const found = new Set<string>();
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "marker-s3-plugin.ts")], outdir: root, naming: "index.js", target: "node", format: "esm", define: { "process.env.NODE_ENV": '"production"', "process.env.MC_S3_PHASE_TRACE": JSON.stringify(phaseTrace), "process.env.MC_S3_WRITER_TRACE": JSON.stringify(writerTrace) }, external: ["@opencode-ai/plugin", "onnxruntime-node", "onnxruntime-web", "sharp", "bun:sqlite", "node:sqlite"], plugins: [{ name: "marker-counters", setup(builder) {
        builder.onLoad({ filter: /(?:compaction-marker-manager|transform-postprocess-phase|storage-meta-persisted|historian-publish-stage-logger)\.ts$/ }, async ({ path }) => {
            let source = readFileSync(path, "utf8");
            const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
            const insertions: Array<{ position: number; text: string }> = [];
            for (const node of tree.statements) if (ts.isFunctionDeclaration(node) && node.body && node.name && names.includes(node.name.text)) {
                const name = node.name.text;
                found.add(name);
                const session = name === "reconcileMarkerRepresentation" ? "options.sessionId" : "sessionId";
                insertions.push({ position: node.body.getStart(tree) + 1, text: `\n__s3Record(${JSON.stringify(trace)}, JSON.stringify({name:${JSON.stringify(name)},sessionID:${session}})+'\\n');\n` });
            }
            for (const node of tree.statements) if (ts.isFunctionDeclaration(node) && node.body && node.name && ["startHistorianPublishStage", "finishHistorianPublishStage"].includes(node.name.text)) {
                const status = node.name.text.startsWith("start") ? '"started"' : "status";
                insertions.push({ position: node.body.getStart(tree) + 1, text: `\nif(stage==='embeddings') __s3Record(${JSON.stringify(writerTrace)}, JSON.stringify({kind:'embeddings',sessionId,status:${status}})+'\\n');\n` });
            }
            for (const insert of insertions.sort((a,b) => b.position-a.position)) source = source.slice(0, insert.position) + insert.text + source.slice(insert.position);
            return { contents: `import {appendFileSync as __s3Record} from 'node:fs';\n${source}`, loader: "ts" };
        });
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    // The historian waits for this worker to load message positions and the
    // messages that own each tag. Ship it beside the plugin, as production does.
    const worker = await Bun.build({ entrypoints: [join(import.meta.dir, "../../../plugin/src/hooks/magic-context/raw-ordinal-warmup-worker.ts")], outdir: root, naming: "raw-ordinal-warmup-worker.js", target: "node", format: "esm", external: ["bun:sqlite", "node:sqlite"] });
    if (!worker.success) throw new Error(worker.logs.join("\n"));
    const markerWorker = await Bun.build({ entrypoints: [join(import.meta.dir, "../../../plugin/src/features/magic-context/compaction-marker-candidates-worker.ts")], outdir: root, naming: "compaction-marker-candidates-worker.js", target: "node", format: "esm", external: ["bun:sqlite", "node:sqlite"] });
    if (!markerWorker.success) throw new Error(markerWorker.logs.join("\n"));
    expect([...found].sort()).toEqual([...names].sort());
    return { root, writerTrace, calls: (sessionID: string) => readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(call => call.sessionID === sessionID), phases: (sessionId: string) => readFileSync(phaseTrace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.sessionId === sessionId).map(row => row.phase) };
}
const usage = { input_tokens: 100, output_tokens: 10 };
function historian(body: unknown) {
    const range = JSON.stringify(body).match(/Messages (\d+)-(\d+):/);
    if (!range) return null;
    const start = Number(range[1]), end = Number(range[2]);
    const split = Math.min(start + 1, end);
    return { text: `<compartment start="${start}" end="${split}" title="Published control"><p1>The source history remains accessible after publication.</p1></compartment>${split < end ? `<compartment start="${split + 1}" end="${end}" title="Protected continuation"><p1>The later source turns continue the same task.</p1></compartment>` : ""}`, usage };
}
async function until(predicate: () => boolean, failure = "historian publication did not complete") { const end = Date.now()+15000; while (!predicate()) { if (Date.now()>end) throw new Error(failure); await Bun.sleep(25); } }

test("I10 real-host counters: v2 fold plus historian publication plus ten turns invoke no v1 marker members; v1 control invokes all four", async () => {
    const fixture = await instrument();
    const host = await spawnOpencode2({ modelContextLimit: 16_000, modelOutputLimit: 1024 });
    try {
        const path = join(host.cwd, "opencode.json");
        const config = JSON.parse(readFileSync(path, "utf8")); config.plugins = [fixture.root]; writeFileSync(path, JSON.stringify(config));
        const directory = join(host.env.XDG_CONFIG_HOME!, "cortexkit"); mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "magic-context.jsonc"), JSON.stringify({ auto_update: false, protected_tokens: 4000, memory: { enabled: false }, dreamer: { disable: true }, historian: { two_pass: false } }));
        const client = OpenCode.make({ baseUrl: host.url, headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: host.cwd }, model: { providerID: "openai", id: "mock-model" } });
        await waitForPluginActive(client, host.cwd);
        const turn = async (text: string) => { await client.session.prompt({ sessionID: session.id, text }); await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(25000) }); };
        host.mock.setDefault({ text: "source answer", usage });
        for (let index=0;index<8;index++) await turn(`marker-source-${index} ${"bounded history ".repeat(700)}`);
        host.mock.addMatcher(historian);
        host.mock.setDefault({ text: "host pressure", usage: { ...usage, input_tokens: 15000 } });
        await turn("Prime host fold");
        host.mock.setDefault({ text: "hidden pressure", usage: { ...usage, input_tokens: 11000 } });
        await turn("Host fold then prime historian");
        host.mock.setDefault({ text: "normal", usage });
        await turn("Organic historian publication");
        const db = openTestDb(join(host.env.XDG_DATA_HOME!, "cortexkit/magic-context/context.db"));
        await until(() => (db.prepare("SELECT count(*) AS n FROM compartments WHERE session_id = ?").get(session.id) as {n:number}).n > 0);
        const reader = new V2StoreReader(gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env));
        expect(reader.latestCompaction(session.id)).toBeDefined(); reader.close();
        for(let index=0;index<10;index++) await turn(`post-publication ${index}`);
        expect(fixture.calls(session.id)).toEqual([]);
        console.info("I10_V2", JSON.stringify(Object.fromEntries(names.map(name => [name, fixture.calls(session.id).filter(call => call.name === name).length]))));
        expect(db.prepare("SELECT compaction_marker_state, pending_compaction_marker_state FROM session_meta WHERE session_id = ? AND (coalesce(compaction_marker_state, '') != '' OR pending_compaction_marker_state IS NOT NULL)").all(session.id)).toEqual([]);
        db.close();
    } catch(error) { console.error(host.stderr().slice(-6000)); console.error(host.pluginLog().slice(-10000)); throw error; }
    finally { await host.stop(); }
    const v1 = await TestHarness.create({ modelContextLimit: 16000, magicContextConfig: { execute_threshold_percentage: 65, protected_tokens: 4000, memory: { enabled: false } }, openCodeConfigExtra: { plugin: [fixture.root] } });
    try {
        const session = await v1.createSession();
        v1.mock.setDefault({ text: "source answer", usage });
        v1.mock.addMatcher(historian);
        for(let index=0;index<16;index++) await v1.sendPrompt(session, `control-${index} ${"bounded history ".repeat(700)}`);
        let directRequested = false;
        v1.mock.addMatcher(body => {
            const text = JSON.stringify(body);
            if (!directRequested && text.includes("Run direct marker control")) { directRequested = true; return { content: [{ type: "tool_use", id: "tool_s3_direct", name: "s3_direct_historian", input: { deferred: false } }], stop_reason: "tool_use", usage }; }
            return null;
        });
        v1.mock.setDefault({ text: "pressure", usage: { ...usage, input_tokens: 130000 } });
        await v1.sendPrompt(session, "Prime background historian");
        v1.mock.setDefault({ text: "normal", usage });
        await v1.sendPrompt(session, "Consume background historian");
        await until(() => v1.countCompartments(session)>0);
        v1.mock.setDefault({ text: "prime deferred drain", usage: { ...usage, input_tokens: 160000 } });
        await v1.sendPrompt(session, "Prime materialization after publication");
        v1.mock.setDefault({ text: "normal", usage });
        await v1.sendPrompt(session, "Consume published marker");
        for(let index=0;index<10;index++) await v1.sendPrompt(session, `control defer ${index}`);
        // A deferred chunk is not completion of its background run. Wait for its
        // lease, then add enough new source to leave an eligible prefix outside
        // the protected tail for the non-deferred publication control.
        await until(() => getCompartmentLeaseBlocker(v1.contextDb() as never, session) === null);
        for (let index=0;index<3;index++) await v1.sendPrompt(session, `direct source ${index} ${"bounded history ".repeat(700)}`);
        await v1.waitForMockQuiescence();
        await until(() => getCompartmentLeaseBlocker(v1.contextDb() as never, session) === null);
        const controlSessionClient = v1.client.session as typeof v1.client.session & {
            messages(options: { path: { id: string } }): Promise<{ data?: unknown }>;
        };
        const source = await controlSessionClient.messages({ path: { id: session } });
        const terminalIds = (source.data as Array<{ info: { id: string; role: string; summary?: boolean; time?: { completed?: number }; finish?: string } }>)
            .filter(({ info }) => !info.summary && (info.role === "user" || (info.role === "assistant" && (info.time?.completed !== undefined || info.finish !== undefined))))
            .slice(-2)
            .map(({ info }) => info.id);
        // Logical historian leases and provider responses do not join the
        // terminal-message index workers or detached publication registration.
        // Observe the last real turn and the whole queue, not older folded rows
        // whose terminal events predate the current indexing source.
        await waitForWriterDrain(fixture.writerTrace, session, terminalIds);
        // Exercise the same short ownership overlap on every platform. A tool
        // error is not a successful positive control merely because HTTP finished.
        const leaseControl = openTestDb(v1.contextDbPath());
        try {
            leaseControl.prepare(`INSERT INTO compartment_state_lease
                (session_id, holder_id, owner_pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
                .run(session, "s3-background-lease-control", process.pid, Date.now(), Date.now() + 1000);
        } finally { leaseControl.close(); }
        await v1.sendPrompt(session, "Run direct marker control");
        const controlResponse = await controlSessionClient.messages({ path: { id: session } });
        const controlMessages = controlResponse.data ?? [];
        const controlParts = (Array.isArray(controlMessages) ? controlMessages : [])
            .flatMap((message: any) => message.parts ?? [])
            .filter((part: any) => part.type === "tool" && part.tool === "s3_direct_historian");
        console.info("I10_V1_CONTROL", JSON.stringify(controlParts));
        expect(controlParts).toHaveLength(1);
        expect(controlParts[0].state.status).toBe("completed");
        expect(controlParts[0].state.output).toBe("Control historian published");
        expect(directRequested).toBe(true);
        expect(fixture.phases(session)).toEqual(["ready", "published", "complete"]);
        expect((v1.contextDb().prepare("SELECT count(*) AS n FROM compartment_state_lease WHERE session_id = ? AND expires_at > ?").get(session, Date.now()) as {n:number}).n).toBe(0);
        const called = new Set(fixture.calls(session).map(call => call.name));
        expect([...called].sort()).toEqual([...names].sort());
        const counts = Object.fromEntries(names.map(name => [name, fixture.calls(session).filter(call => call.name === name).length]));
        for (const count of Object.values(counts)) expect(count).toBeGreaterThanOrEqual(1);
        const latest = v1.contextDb().prepare("SELECT end_message_id FROM compartments WHERE session_id = ? ORDER BY sequence DESC LIMIT 1").get(session);
        console.info("I10_V1", JSON.stringify({ counts, latest, source: "fixture RawMessageProvider reads real v1 SDK messages" }));
    } catch (error) {
        console.error(v1.opencode.stderr().slice(-3000));
        try { console.error(readFileSync(join(v1.opencode.env.dataDir, "state", "marker.log"), "utf8").split("\n").filter(line => /trigger|historian|compartment|boundar|ordinal|owner/i.test(line)).slice(-35).join("\n")); } catch {}
        throw error;
    } finally { await v1.dispose(); rmSync(fixture.root, { recursive: true, force: true }); }
}, 180000);
