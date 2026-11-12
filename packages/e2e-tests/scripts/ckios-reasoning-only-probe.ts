#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { MockProvider } from "../src/mock-provider/server";
import { spawnOpencode } from "../src/opencode-runner/spawn";
import { openTestDb } from "../src/test-db";
import { sessionMetaFieldSelect } from "../src/session-meta-fields";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import { setPendingCompactionMarkerState } from "../../plugin/src/features/magic-context/storage-meta-persisted";
import { queuePendingOp } from "../../plugin/src/features/magic-context/storage";

process.env.MC_E2E_MODE = "ts";
const output = resolve(Bun.argv[2] ?? "ckios-probe-output");
mkdirSync(output, { recursive: true });
// MC_SPECIMEN_DIR supplies store-rows.txt with captured reasoning and a completion notice.
// Replay only those inert parts; captured tool commands may mutate real projects.
const specimen = process.env.MC_SPECIMEN_DIR;
const storeRows = specimen ? readFileSync(resolve(specimen, "store-rows.txt"), "utf8").split("\n") : [];
const partFor = (mid: string, type: string) => storeRows.flatMap(line => {
    const [id, owner, ...data] = line.split("|");
    if (!id?.startsWith("prt_") || owner !== mid) return [];
    const part = JSON.parse(data.join("|"));
    return part.type === type ? [part] : [];
})[0];
const stagedThinking = partFor("msg_0bedb7d8f001FvFOQdZoGqywkr", "reasoning");
const thinkingText = stagedThinking?.text ?? "CKIOS_REASONING_ONLY";
const thinkingSignature = stagedThinking?.metadata?.anthropic?.signature ?? "fixture-signature";
const notice = partFor("msg_0bedbd073001dWTdnRGldoxnBq", "text")?.text ?? "<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>";
for (const lane of ["plain", "mc", "marker", "marker-drops", "marker-dropped-boundary"].filter(lane => !process.env.MC_PROBE_LANE || process.env.MC_PROBE_LANE === lane)) {
    const enabled = lane !== "plain";
    const marker = lane.startsWith("marker");
    const markerDrops = lane === "marker-drops" || lane === "marker-dropped-boundary";
    const mock = new MockProvider();
    const { baseURL } = await mock.start();
    mock.setDefault({ text: "finished", usage: { input_tokens: 1000, output_tokens: 1 } });
    mock.addMatcher(body => JSON.stringify(body.messages).includes("Generate a title for this conversation:") ? { text: "Fixture", usage: { input_tokens: 10, output_tokens: 1 } } : null);
    // A plugin that repeats a stored message once makes the recorded host order
    // unusable, so the prefix trim cannot prove its cut on that pass.
    const refuseTrim = process.env.MC_PROBE_REFUSE_TRIM === "1";
    const probes = ["before", "after"].map(stage => {
        const path = `${output}/${lane}-${stage}-plugin.ts`;
        const refusalInjection = refuseTrim && stage === "before" ? `if (!injected && output.messages.some(m => m.parts.some(p => p.type === 'text' && p.text.includes(${JSON.stringify(notice)})))) { injected = true; output.messages.splice(2, 0, structuredClone(output.messages[1])); }` : "";
        writeFileSync(path, `import { appendFileSync } from 'node:fs';\nlet injected = false;\nexport default async () => ({ 'experimental.chat.messages.transform': async (_input, output) => { ${refusalInjection} appendFileSync(${JSON.stringify(`${output}/${lane}-${stage}.jsonl`)}, JSON.stringify(output.messages) + '\\n'); } });\n`);
        return `file://${path}`;
    });
    const upgradePlugin = process.env.MC_PROBE_UPGRADE_FROM;
    const fixedPlugin = `file://${resolve(import.meta.dir, '../../plugin/src/index.ts')}`;
    const spawnOptions: Parameters<typeof spawnOpencode>[0] = {
        mockProviderURL: baseURL,
        mockProviderID: "anthropic",
        mockModelID: "claude-opus-5",
        expectedMagicContextState: enabled ? "enabled" : "configured-disabled",
        prepareContextDatabase: enabled,
        extraEnv: { MAGIC_CONTEXT_LOG_PATH: `${output}/${lane}.log` },
        openCodeConfigExtra: { plugin: enabled ? [probes[0], upgradePlugin ? `file://${resolve(upgradePlugin)}` : fixedPlugin, probes[1]] : probes },
        magicContextConfig: { execute_threshold_percentage: markerDrops ? 65 : 90, protected_tokens: 0, compressor: { enabled: false }, memory: { auto_search: { enabled: false } } },
    };
    let host = await spawnOpencode(spawnOptions);
    try {
        let client = createOpencodeClient({ baseUrl: host.url });
        const session = await client.session.create({ query: { directory: host.env.workdir }, throwOnError: true });
        const id = session.data!.id;
        const prompt = async (text: string, synthetic = false) => client.session.prompt({
            path: { id }, query: { directory: host.env.workdir }, throwOnError: true,
            body: { model: { providerID: "anthropic", modelID: "claude-opus-5" }, parts: [{ type: "text", text, synthetic }] },
        });
        if (marker) {
            await prompt("older history to compact");
            if (markerDrops) {
                const history = (await client.session.messages({ path: { id }, query: { directory: host.env.workdir }, throwOnError: true })).data!;
                const db = openTestDb(resolve(host.env.dataDir, "cortexkit/magic-context/context.db"));
                try {
                    appendCompartments(db as unknown as Parameters<typeof appendCompartments>[0], id, [{ sequence: 0, startMessage: 1, endMessage: lane === "marker-dropped-boundary" ? 1 : 2, startMessageId: history[0].info.id, endMessageId: history[lane === "marker-dropped-boundary" ? 0 : 1].info.id, title: "Baseline fixture", content: "Previously compacted fixture." }]);
                } finally { db.close(); }
            }
            await prompt("boundary user before retained tail");
            const history = (await client.session.messages({ path: { id }, query: { directory: host.env.workdir }, throwOnError: true })).data!;
            const boundary = history[markerDrops ? 3 : 2].info.id;
            const db = openTestDb(resolve(host.env.dataDir, "cortexkit/magic-context/context.db"));
            try {
                const storageDb = db as unknown as Parameters<typeof appendCompartments>[0];
                if (!markerDrops) appendCompartments(storageDb, id, [{ sequence: 0, startMessage: 1, endMessage: 3, startMessageId: history[0].info.id, endMessageId: boundary, title: "Compacted fixture", content: "Older fixture history." }]);
                setPendingCompactionMarkerState(storageDb, id, { ordinal: markerDrops ? 4 : 3, endMessageId: boundary, publishedAt: Date.now() });
            } finally { db.close(); }
            // Reload the plugin so startup restores the pending marker's deferred signals.
            await client.instance.dispose({ query: { directory: host.env.workdir }, throwOnError: true });
        }
        mock.script([
            ...Array.from({ length: markerDrops ? 25 : 1 }, (_, index) => ({ content: [{ type: "tool_use", id: `tool-first-${index}`, name: "bash", input: { command: "printf done", description: "fixture" } }], stop_reason: "tool_use" as const, usage: { input_tokens: 1000, output_tokens: 1 } })),
            { content: [{ type: "thinking", thinking: thinkingText, signature: thinkingSignature }], stop_reason: "end_turn", usage: { input_tokens: marker ? (markerDrops ? 140000 : 185000) : 1000, output_tokens: 1 } },
        ]);
        await prompt("Run the fixture");
        writeFileSync(`${output}/${lane}-store-before.json`, JSON.stringify((await client.session.messages({ path: { id }, query: { directory: host.env.workdir } })).data, null, 2));
        if (markerDrops) {
            const history = (await client.session.messages({ path: { id }, query: { directory: host.env.workdir }, throwOnError: true })).data!;
            const db = openTestDb(resolve(host.env.dataDir, "cortexkit/magic-context/context.db"));
            try {
                const storageDb = db as unknown as Parameters<typeof appendCompartments>[0];
                const endOrdinal = lane === "marker-dropped-boundary" ? 6 : 4;
                appendCompartments(storageDb, id, [{ sequence: 1, startMessage: 3, endMessage: endOrdinal, startMessageId: history[2].info.id, endMessageId: history[endOrdinal - 1].info.id, title: "Compacted fixture", content: "Older fixture history." }]);
                setPendingCompactionMarkerState(storageDb, id, { ordinal: endOrdinal, endMessageId: history[endOrdinal - 1].info.id, publishedAt: Date.now() });
                if (lane === "marker-dropped-boundary") {
                    for (const user of [history[2], history[4]]) db.query("UPDATE tags SET status = 'dropped', drop_mode = 'full' WHERE session_id = ? AND message_id = ?").run(id, `${user.info.id}:p0`);
                }
                const tags = db.query("SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number LIMIT 1").all(id) as Array<{ tag_number: number }>;
                for (const tag of tags) {
                    queuePendingOp(storageDb, id, tag.tag_number, "drop", Date.now());
                    db.query("UPDATE tags SET status = 'dropped', drop_mode = 'full' WHERE session_id = ? AND tag_number = ?").run(id, tag.tag_number);
                }
                if (lane === "marker-dropped-boundary") writeFileSync(`${output}/${lane}-boundary-fixture.json`, JSON.stringify({ boundary: history[endOrdinal - 1], tags: db.query("SELECT status, drop_mode, tool_owner_message_id FROM tags WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id = ?").all(id, history[endOrdinal - 1].info.id) }, null, 2));
            } finally { db.close(); }
        }
        const captureMarkerState = (label: string) => {
            const db = openTestDb(resolve(host.env.dataDir, "cortexkit/magic-context/context.db"));
            try {
                const state = db.query("SELECT pending_compaction_marker_state, compaction_marker_state FROM session_meta WHERE session_id = ?").get(id);
                writeFileSync(`${output}/${lane}-${label}-state.json`, JSON.stringify(state, null, 2));
            } finally { db.close(); }
        };
        if (refuseTrim) captureMarkerState("before-refusal");
        const first = mock.requests().length;
        mock.script([
            { content: [{ type: "thinking", thinking: "NEWEST_THINKING", signature: "new-signature" }, { type: "tool_use", id: "tool-second", name: "bash", input: { command: "printf next", description: "fixture next" } }], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 1 } },
            { text: "done", usage: { input_tokens: 1000, output_tokens: 1 } },
        ]);
        if (upgradePlugin || refuseTrim) mock.script([{ text: "upgrade boundary", usage: { input_tokens: refuseTrim ? 140000 : 1000, output_tokens: 1 } }]);
        await prompt(notice, true);
        if (refuseTrim) {
            captureMarkerState("after-refusal");
            await prompt("retry with provable source order", true);
            captureMarkerState("after-retry");
            await prompt("verify marker does not advance twice", true);
            captureMarkerState("after-defer");
            await Bun.sleep(750);
        }
        if (upgradePlugin) {
            const env = host.env;
            // Let the 500ms logger flush scheduler and marker-drain records before shutdown.
            await Bun.sleep(750);
            writeFileSync(`${output}/${lane}-pre-upgrade.log`, readFileSync(`${output}/${lane}.log`));
            // Freeze the raw hook arrays served before the restart so the gate can
            // tell the pre-upgrade pass apart from the passes that follow it.
            writeFileSync(`${output}/${lane}-pre-upgrade-after.jsonl`, readFileSync(`${output}/${lane}-after.jsonl`));
            const db = openTestDb(resolve(env.dataDir, "cortexkit/magic-context/context.db"));
            try {
                writeFileSync(`${output}/${lane}-pre-upgrade-ledger.json`, JSON.stringify(db.query(`SELECT ${sessionMetaFieldSelect("merged_reasoning_stripped_ids", "merged_reasoning_stripped_ids", db)} FROM session_meta WHERE session_id = ?`).get(id)));
                // What the pre-fix build durably recorded as its last served array. Since
                // context.db v94 the prefix is stored as ordered slices in lkg_slot_chunks,
                // so its length is the sum of the slice lengths. This reads the rows directly:
                // the plugin's loader clears a slot that fails verification, and a probe
                // must not change the state it records.
                writeFileSync(`${output}/${lane}-pre-upgrade-lkg.json`, JSON.stringify(db.query("SELECT s.session_id, (SELECT COALESCE(SUM(length(c.body)), 0) FROM lkg_slot_chunks c WHERE c.session_id = s.session_id) AS prefix_bytes, s.captured_at FROM lkg_slots s WHERE s.session_id = ?").all(id)));
            } finally { db.close(); }
            await host.kill();
            host = await spawnOpencode({ ...spawnOptions, existingEnv: env, openCodeConfigExtra: { plugin: [probes[0], fixedPlugin, probes[1]] } });
            client = createOpencodeClient({ baseUrl: host.url });
            await prompt("post-restart defer", true);
            writeFileSync(`${output}/${lane}-post-restart-after.jsonl`, readFileSync(`${output}/${lane}-after.jsonl`));
            // A second defer pass: whatever the first pass after the upgrade
            // serves, the session must keep serving it.
            await prompt("post-restart defer again", true);
        }
        const bodies = mock.requests().slice(first).map(request => request.body);
        if (marker) {
            const db = openTestDb(resolve(host.env.dataDir, "cortexkit/magic-context/context.db"));
            try {
                const state = db.query("SELECT pending_compaction_marker_state, compaction_marker_state FROM session_meta WHERE session_id = ?").get(id);
                writeFileSync(`${output}/${lane}-state.json`, JSON.stringify(state, null, 2));
                console.log(JSON.stringify({ lane, state }));
            } finally { db.close(); }
        }
        writeFileSync(`${output}/${lane}-bodies.json`, JSON.stringify(bodies, null, 2));
        writeFileSync(`${output}/${lane}-host.json`, JSON.stringify({ env: host.env, session: id }));
        for (const [index, body] of bodies.entries()) {
            const messages = body.messages ?? [];
            console.log(JSON.stringify({ lane, index, target: messages.findIndex(message => JSON.stringify(message).includes(JSON.stringify(thinkingText).slice(1, -1))), sha256: createHash("sha256").update(JSON.stringify(messages)).digest("hex"), tail: messages.slice(-5) }));
        }
    } finally {
        await host.kill();
        await mock.stop();
    }
}
