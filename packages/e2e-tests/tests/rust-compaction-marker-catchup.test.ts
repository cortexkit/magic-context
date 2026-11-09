/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeCompactionMarkerDb, injectCompactionMarker, prepareCompactionMarkerCandidates } from "../../plugin/src/features/magic-context/compaction-marker";
import { MARKER_SUMMARY_TEXT } from "../../plugin/src/hooks/magic-context/compaction-marker-manager";
import { RustTestHarness } from "../src/rust-harness";
import { PLUGIN_ENTRY } from "../src/opencode-runner/spawn";
import { assertHermeticStores, driveDeferredMarkerMove, FOLD_CONFIG, markerDiscoveryDeferrals } from "../src/rust-marker-test-support";
import { rustPrereqs } from "../src/rust-scenario-support";

describe.skipIf(!rustPrereqs.ok)("rust invariant: compaction marker byte identity", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 1_000_000,
            historianModelContextLimit: 1_000_000,
            magicContextConfig: FOLD_CONFIG,
        });
        h.subc.writeModuleConfig(FOLD_CONFIG);
    });

    afterEach(async () => {
        if (h) {
            console.log(h.diagnosticLog().split("\n").filter(line => /rust pass:|compaction-marker drain:|rust transform failed/.test(line)).slice(-4).join("\n"));
            console.log(h.subc.moduleLog().split("\n").filter(line => /ERROR|historian firing failed/.test(line)).slice(-4).join("\n"));
        }
        await h?.dispose();
    });

    async function mixedCatchup(noOp = false) {
        expect(PLUGIN_ENTRY).toMatch(/\/dist\/index\.js$/);
        await h.dispose();
        const config = { execute_threshold_tokens: { default: 654_000 }, protected_tokens: 4_000, cache_ttl: "5m", compressor: { enabled: false } };
        h = await RustTestHarness.create({ modelContextLimit: 872_000, historianModelContextLimit: 872_000, magicContextConfig: config, startInTsMode: true, startHistorianProducer: false, mockDefault: { text: "mixed fixture reply", usage: { input_tokens: 350_000, output_tokens: 20 } } });
        h.subc.writeModuleConfig(config);
        const health = await fetch(`${h.opencode.url}/global/health`).then(response => response.json()) as { version: string };
        expect(health.version).toMatch(/^1\./);
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "seed mixed sparse history");
        assertHermeticStores(h);
        h.appendSyntheticHistory(sessionId, { count: 17_000, textBytes: 64 });
        const ocPath = join(h.env.dataDir, "opencode", "opencode.db");
        const contextPath = join(h.env.dataDir, "cortexkit", "magic-context", "context.db");
        const oc = new Database(ocPath);
        const context = new Database(contextPath);
        oc.exec("PRAGMA busy_timeout=30000");
        context.exec("PRAGMA busy_timeout=30000");
        type Raw = { id: string; time_created: number };
        let raw = oc.query("SELECT id,time_created FROM message WHERE session_id=? AND json_extract(data,'$.summary') IS NOT 1 ORDER BY time_created,id").all(sessionId) as Raw[];
        // Tie timestamps, then use the actual canonical order for every anchor below.
        oc.transaction(() => {
            for (let i = 0; i < 17_000; i++) {
                // Keep the retained turn's production ID/time order intact. Ties
                // exercise the covered head, not a hand-renumbered live suffix.
                if (i >= 16936) continue;
                const time = raw[Math.floor(i / 2) * 2]!.time_created;
                oc.query("UPDATE message SET time_created=?, data=json_set(data,'$.time.created',?) WHERE id=?").run(time, time, raw[i]!.id);
            }
        }).immediate();
        raw = oc.query("SELECT id,time_created FROM message WHERE session_id=? AND json_extract(data,'$.summary') IS NOT 1 ORDER BY time_created,id").all(sessionId) as Raw[];
        const gaps = new Set([16,29,43,63,75,85,86,109,110]);
        const endpoints = new Set([15,28,42,50,62,74,84,108,16939]);
        for (const ordinal of gaps) oc.query("UPDATE part SET data=json_set(data,'$.synthetic',json('true')) WHERE message_id=?").run(raw[ordinal-1]!.id);
        const mixHistory = () => oc.transaction(() => {
            for (let i = 0; i < 17_000; i++) {
                const row = raw[i]!;
                const ordinal = i + 1;
                if (gaps.has(ordinal)) {
                    oc.query("UPDATE part SET data=json_set(data,'$.synthetic',json('true')) WHERE message_id=?").run(row.id);
                    continue;
                }
                if ((!endpoints.has(ordinal) && ordinal % 3 !== 0) || ordinal === 16940) {
                    // Completed tool parts retain the production assistant envelope and
                    // decode to paired call/result blocks, including the retained end turn.
                    const template = JSON.parse((oc.query("SELECT data FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' ORDER BY time_created DESC LIMIT 1").get(sessionId) as { data: string }).data);
                    oc.query("UPDATE message SET data=? WHERE id=?").run(JSON.stringify({ ...template, id: row.id, sessionID: sessionId, parentID: raw[Math.max(0, i-1)]!.id, time: { created: row.time_created, completed: row.time_created } }), row.id);
                    if (ordinal % 8 === 0 || ordinal === 16940) {
                        const partId = `prt_mixed_tool_${ordinal}`;
                        const output = JSON.stringify({ path: `fixture-${ordinal}.json`, records: "large tool output ".repeat(256) });
                        oc.query("INSERT INTO part (id,message_id,session_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)").run(partId, row.id, sessionId, row.time_created, row.time_created, JSON.stringify({ id: partId, messageID: row.id, sessionID: sessionId, type: "tool", tool: "read", callID: `call_mixed_${ordinal}`, state: { status: "completed", input: { filePath: `fixture-${ordinal}.json` }, output, title: "read fixture", metadata: {}, time: { start: row.time_created, end: row.time_created } } }));
                    }
                }
            }
        }).immediate();
        const insertRange = (sequence: number, start: number, end: number) => {
            const block = end === 16940 ? 2 : 0;
            context.query(`INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,start_block_index,end_block_index,title,content,p1,importance,episode_type,created_at)
                VALUES (?,?,?,?,?,?,0,?,'mixed fixture','covered mixed history','covered mixed history',50,'feature',1)`).run(sessionId, sequence, start, end, raw[start-1]!.id, raw[end-1]!.id, block);
        };
        [[1,15],[17,28],[30,42],[44,50]].forEach(([start,end], sequence) => insertRange(sequence,start!,end!));
        const previousDb = process.env.OPENCODE_DB;
        try {
            process.env.OPENCODE_DB = ocPath;
            expect(await prepareCompactionMarkerCandidates(sessionId)).toBe(true);
            const marker = injectCompactionMarker({ sessionId, endOrdinal: 50, endMessageId: raw[49]!.id, summaryText: MARKER_SUMMARY_TEXT, directory: h.env.workdir });
            expect(marker).not.toBeNull();
            context.query("UPDATE session_meta SET compaction_marker_state=?,pending_compaction_marker_state=NULL WHERE session_id=?").run(JSON.stringify({ ...marker, boundaryOrdinal: 50, targetEndMessageId: raw[49]!.id }), sessionId);
        } finally { closeCompactionMarkerDb(); if (previousDb === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previousDb; }
        const seed = await h.subc.moduleRequest(sessionId, h.env.workdir, { method: "state_sync", shadow_generation: 0, expected_shadow_seq: 0, seed_boundary_id: `${raw[49]!.id}#0` });
        expect(seed.ok).toBe(true);
        await h.restart({ rust: true, magicContextConfig: config });
        assertHermeticStores(h);
        if (noOp) {
            mixHistory();
            [[51,62],[64,74],[76,84],[87,108],[111,16940]].forEach(([start,end], index) => insertRange(index+4,start!,end!));
        }
        const beforeWarm = h.readRustPasses().length;
        await h.sendPrompt(sessionId, "warm below the execute threshold");
        // The logger buffers pass lines after the host returns. Drain the warm
        // pass before counting the control, or the control's SOFT+ can be mistaken for the
        // later epoch HARD while that HARD is still waiting to be flushed.
        await h.waitForRustPasses(beforeWarm + 1);
        if (noOp) {
            const probeId = "msg_01N00PEP0CHREPLAYPR0BE0000";
            const probe = "literal no-op epoch probe";
            const provider = () => { const body=h.mainRequests().at(-1)!.body; return JSON.stringify({system:body.system,messages:body.messages}); };
            const oldDb = process.env.OPENCODE_DB;
            try {
                process.env.OPENCODE_DB = ocPath;
                expect(await prepareCompactionMarkerCandidates(sessionId)).toBe(true);
                const old = injectCompactionMarker({ sessionId, endOrdinal: 50, endMessageId: raw[49]!.id, summaryText: MARKER_SUMMARY_TEXT, directory: h.env.workdir });
                expect(old).not.toBeNull();
                context.query("UPDATE session_meta SET compaction_marker_state=?,pending_compaction_marker_state=? WHERE session_id=?").run(JSON.stringify({ ...old, boundaryOrdinal: 50, targetEndMessageId: raw[49]!.id }),JSON.stringify({ordinal:16940,endMessageId:raw[16939]!.id,publishedAt:1,injectAttempts:3,firstInjectFailedAt:1,lastInjectError:"busy"}),sessionId);
            } finally { closeCompactionMarkerDb(); if (oldDb === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB=oldDb; }
            const state = () => context.query("SELECT compaction_marker_state,pending_compaction_marker_state FROM session_meta WHERE session_id=?").get(sessionId);
            const held = state();
            const markerRows = () => oc.query("SELECT id,data FROM part WHERE session_id=? AND json_extract(data,'$.type')='compaction' ORDER BY id").all(sessionId);
            const rows = markerRows();
            // Establish the provider control after staging the lagging host
            // representation; staging itself changes the summary tag identity.
            const beforeProbe = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeId });
            await h.waitForRustPasses(beforeProbe+1);
            const frozen = provider();
            await h.revertMessage(sessionId,probeId);
            const moduleStore = new Database(join(h.env.dataDir,"cortexkit","magic-context","store.db"));
            try {
                moduleStore.exec("PRAGMA busy_timeout=30000");
                moduleStore.query("INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES (?,?,1)").run(sessionId,`${raw[16999]!.id}#0`);
                const stagedEpoch = moduleStore.query("UPDATE mc_cache_state SET meta=json_set(meta,'$.project_memory_epoch_pending',json('true')),row_version=row_version+1 WHERE session_id=? RETURNING row_version,json_extract(meta,'$.project_memory_epoch_pending') AS pending").get(sessionId) as { row_version: number; pending: number };
                expect(stagedEpoch.pending).toBe(1);
                const before = h.readRustPasses().length;
                await h.sendPrompt(sessionId,probe,{messageID:probeId});
                const pass = (await h.waitForRustPasses(before+1)).at(-1)!;
                expect(pass.decision).toBe("HARD");
                expect(pass.raw).toContain("prefix_bust_permitted=false");
                expect(pass.raw).toContain("reason=project_memory_epoch");
                expect(pass.rowVersion).toBeGreaterThan(stagedEpoch.row_version);
                expect(pass.applied).toBe(true);
                expect(state()).toEqual(held);
                expect(markerRows()).toEqual(rows);
                expect(moduleStore.query("SELECT count(*) AS n FROM pending_agent_drops WHERE session_id=?").get(sessionId)).toEqual({n:1});
                expect(provider()).toBe(frozen);
                expect(h.diagnosticLog()).not.toContain("lkg_frozen_replay_released");
                assertHermeticStores(h);
            } finally { moduleStore.close(); oc.close(); context.close(); }
            return;
        }
        mixHistory();
        [[51,62],[64,74],[76,84],[87,108],[111,16940]].forEach(([start,end], index) => insertRange(index+4,start!,end!));
        expect(context.query("SELECT pending_compaction_marker_state AS pending FROM session_meta WHERE session_id=?").get(sessionId)).toEqual({ pending: null });
        const rawHistoryApiBytes = Buffer.byteLength(JSON.stringify(await h.listMessages(sessionId)));
        const previousTools = JSON.stringify(h.mainRequests().at(-1)!.body.tools);
        // OpenCode can run messages.transform before system.transform, so a
        // newly discovered AGENTS.md hash may reach Rust only on the next turn.
        // Change MC's render configuration and a real provider tool description.
        // That epoch is in this request without introducing a second, later
        // system-hash epoch on the first smaller-input replay.
        const epochConfig = { ...config, prompt_surface: { tool_descriptions: { ctx_search: "Search the generated mixed-history marker fixture." } } };
        h.subc.writeModuleConfig(epochConfig);
        await h.restart({ rust: true, magicContextConfig: epochConfig });
        assertHermeticStores(h);
        let peakRssKiB = 0;
        const sample = () => {
            const pidFile = JSON.parse(readFileSync(join(h.env.dataDir,"cortexkit","rust-e2e-pids.json"),"utf8")) as { pids: Array<{pid:number}> };
            const pids = [h.opencode.pid, ...pidFile.pids.map(row => row.pid)];
            const rss = spawnSync("ps", ["-o","rss=","-p",pids.join(",")], {encoding:"utf8"});
            if (rss.status === 0) peakRssKiB = Math.max(peakRssKiB, rss.stdout.trim().split(/\s+/).reduce((sum,n)=>sum+Number(n),0));
        };
        const sampling = setInterval(sample,100);
        const before = h.readRustPasses().length;
        const deferralsBeforeHard = markerDiscoveryDeferrals(h, sessionId);
        try { await h.sendPrompt(sessionId,"rebuild this prefix below execute pressure"); sample(); } finally { clearInterval(sampling); }
        const hard = (await h.waitForRustPasses(before+1)).at(-1)!;
        expect(hard.decision).toBe("HARD");
        expect(hard.raw).toContain("scheduler=defer");
        expect(hard.raw).toContain("prefix_bust_permitted=true");
        expect(hard.raw).toContain("reason=epoch_change");
        expect(hard.applied).toBe(true);
        expect(JSON.stringify(h.mainRequests().at(-1)!.body.tools)).not.toBe(previousTools);
        const marker = () => JSON.parse((context.query("SELECT compaction_marker_state AS marker FROM session_meta WHERE session_id=?").get(sessionId) as {marker:string}).marker) as {boundaryOrdinal:number;boundaryMessageId:string};
        // This HARD is the first pass of a freshly restarted plugin, and the
        // summary discovery a marker move needs starts on that same pass, in the
        // background. The pass serves the rebuilt history without waiting for it
        // and records the 16940 target as pending; a later cache-busting pass
        // moves the marker. Ordinary SOFT+ passes never move it, so ask for one
        // rebuild here. The smaller-input checks below start after that move.
        if (marker().boundaryOrdinal !== 16940) {
            expect(markerDiscoveryDeferrals(h, sessionId)).toBe(deferralsBeforeHard + 1);
            const pending = JSON.parse((context.query("SELECT pending_compaction_marker_state AS pending FROM session_meta WHERE session_id=?").get(sessionId) as {pending:string}).pending) as {ordinal:number;endMessageId:string};
            expect(pending.ordinal).toBe(16940);
            expect(pending.endMessageId).toBe(raw[16939]!.id);
            await driveDeferredMarkerMove(h, sessionId, () => marker().boundaryOrdinal !== 50, "move the caught-up marker on a requested rebuild");
        }
        expect(marker().boundaryOrdinal).toBe(16940);
        expect(marker().boundaryMessageId).toBe(raw[16938]!.id);
        const retained = await h.listMessages(sessionId);
        expect(retained.some(message => message.info?.id === raw[16939]!.id && message.parts?.some(part=>part.type==="tool"))).toBe(true);
        const probe = "literal mixed marker replay probe";
        const probeId = "msg_01M1X3DPR3F1XREPLAYPR0BE000";
        const exactProvider = () => { const body=h.mainRequests().at(-1)!.body; return JSON.stringify({system:body.system,messages:body.messages}); };
        const replayBefore = h.readRustPasses().length;
        await h.sendPrompt(sessionId,probe,{messageID:probeId});
        const smaller = (await h.waitForRustPasses(replayBefore+1)).at(-1)!;
        expect(smaller.decision).toBe("SOFT+");
        expect(smaller.raw).toContain("prefix_bust_permitted=false");
        expect(smaller.inputCount).toBeLessThan(100);
        expect(smaller.wireMessages).toBe(smaller.inputCount);
        const first = exactProvider();
        await h.revertMessage(sessionId,probeId);
        await h.sendPrompt(sessionId,probe,{messageID:probeId});
        expect(exactProvider()).toBe(first);
        await h.waitForRustPasses(replayBefore+2);
        const history = (h.mainRequests().at(-1)!.body.messages as Array<{content:unknown[]}>)[0]!.content.slice(0,2);
        const appendBefore = h.readRustPasses().length;
        await h.sendPrompt(sessionId,"ordinary append after the smaller full sync");
        const append = (await h.waitForRustPasses(appendBefore+1)).at(-1)!;
        expect(append.decision).toBe("SOFT+");
        expect(append.raw).toContain("prefix_bust_permitted=false");
        expect(append.wireMessages).toBeLessThanOrEqual(4);
        expect((h.mainRequests().at(-1)!.body.messages as Array<{content:unknown[]}>)[0]!.content.slice(0,2)).toEqual(history);
        expect(marker().boundaryOrdinal).toBe(16940);
        expect(h.diagnosticLog().split("\n").filter(line=>line.includes(sessionId)&&/served_from=(lkg|refused)|rust transform failed/.test(line))).toEqual([]);
        const writerTimings = h.diagnosticLog().split("\n").filter(line=>/acquire.*hold|host.*write|marker.*fit/.test(line)).slice(-20);
        const writes = writerTimings.map(line=>line.match(/site=compaction-marker-replace .*acquire_ms=(\d+) hold_ms=(\d+).*outcome=committed/)).filter(match=>match!==null);
        expect(writes.length).toBeGreaterThan(0);
        expect(writes.every(match=>Number(match![1])<1000 && Number(match![2])<5000)).toBe(true);
        expect(Buffer.byteLength(first)).toBeLessThan(872_000*4);
        expect(hard.transportBytes).toBeGreaterThan(1_000_000);
        console.log(`mixed catch-up OpenCode=${health.version} incoming_module_payload_bytes=${hard.transportBytes} raw_history_api_bytes=${rawHistoryApiBytes} peak_rss_kib=${peakRssKiB} fit=under in=${hard.inputCount} first_smaller=${smaller.inputCount} full_transport=${smaller.wireMessages} append_delta=${append.wireMessages} writer_timings=${JSON.stringify(writerTimings)}`);
        assertHermeticStores(h);
        oc.close(); context.close();
    }

    it("byte-preserving marker HARD holds the host marker, queued drops and frozen provider bytes", () => mixedCatchup(true), 600_000);
    it("mixed 16k catch-up has byte-stable following SOFT+ and bounded host writes", () => mixedCatchup(), 600_000);
});
