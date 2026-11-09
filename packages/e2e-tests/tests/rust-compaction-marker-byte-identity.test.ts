/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { closeCompactionMarkerDb, injectCompactionMarker, prepareCompactionMarkerCandidates } from "../../plugin/src/features/magic-context/compaction-marker";
import { MARKER_SUMMARY_TEXT } from "../../plugin/src/hooks/magic-context/compaction-marker-manager";
import { stableStringify } from "../../plugin/src/shared/stable-json";
import { RustTestHarness } from "../src/rust-harness";
import { assertHermeticStores, driveDeferredMarkerMove, FOLD_CONFIG, markerDiscoveryDeferrals, requestRustCtxFlush } from "../src/rust-marker-test-support";
import { rustPrereqs } from "../src/rust-scenario-support";

interface SqliteRow {
    id: string;
    message_id?: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/** The session's published compartments, in order. */
function contextHistoryRows(path: string, sessionId: string): Array<{ sequence: number; title: string }> {
    const db = new Database(path, { readonly: true });
    try {
        return db
            .query("SELECT sequence, title FROM compartments WHERE session_id = ? ORDER BY sequence")
            .all(sessionId) as Array<{ sequence: number; title: string }>;
    } finally {
        db.close();
    }
}

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

    it(
        "advances indexed Rust markers on busts and resyncs a 12900-message cut without changing ordinary wire bytes",
        async () => {
            const health = await fetch(`${h.opencode.url}/global/health`).then(response => response.json()) as { version: string };
            expect(health.version).toMatch(/^1\./);
            const sessionId = await h.createSession();
            await h.sendPrompt(sessionId, "seed the long session");
            assertHermeticStores(h);
            h.setSessionCacheTtl(sessionId, "0");
            h.appendSyntheticHistory(sessionId, { count: 12_900, textBytes: 64 });
            // These rows precede the seed. Refresh raw ordinals before the module
            // starts folding, rather than presenting a reordered incremental tail.
            await h.restart({ rust: true, magicContextConfig: FOLD_CONFIG });
            assertHermeticStores(h);
            console.log(`OpenCode ${health.version}`);
            const opencodeDb = new Database(join(h.env.dataDir, "opencode", "opencode.db"));
            // The harness's OpenCode server writes this database concurrently; bun:sqlite
            // defaults to no busy wait, so the marker deletes below would fail on the
            // first overlapping host write (seen as SQLITE_BUSY in release run r2).
            opencodeDb.exec("PRAGMA busy_timeout = 30000");

            const markerOrdinals = new Set<number>();
            for (let turn = 1; turn <= 90; turn += 1) {
                h.mock.setDefault({
                    text: `fold reply ${turn}`,
                    usage: {
                        input_tokens: 60_000,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `marker fold turn ${turn}: ${h.ballast(400)}`, { timeoutMs: 300_000 });
                const row = h.contextDb().query("SELECT compaction_marker_state FROM session_meta WHERE session_id=?").get(sessionId) as { compaction_marker_state: string };
                const ordinal = row.compaction_marker_state ? (JSON.parse(row.compaction_marker_state) as { boundaryOrdinal: number }).boundaryOrdinal : 0;
                if (ordinal > 0) markerOrdinals.add(ordinal);
                const published = (h.contextDb().query("SELECT count(*) AS n FROM compartments WHERE session_id=?").get(sessionId) as { n: number }).n;
                if (turn >= 4 && published >= 3) expect(markerOrdinals.size).toBeGreaterThan(0);
                if (turn % 10 === 0) console.log(`fold turn=${turn} ordinal=${ordinal}; compartments=${JSON.stringify(h.contextDb().query("SELECT sequence,end_message,end_block_index FROM compartments WHERE session_id=? ORDER BY sequence DESC LIMIT 3").all(sessionId))}`);
                if (markerOrdinals.size >= 3 && ordinal > 12_700) break;
                await Bun.sleep(100);
            }

            expect(markerOrdinals.size).toBeGreaterThanOrEqual(3);
            const indexedCount = (h.contextDb().query("SELECT count(*) AS n FROM compartments WHERE session_id=? AND end_block_index IS NOT NULL").get(sessionId) as { n: number }).n;
            expect(indexedCount).toBeGreaterThanOrEqual(3);
            console.log(`indexed compartments=${indexedCount}; marker ordinals=${JSON.stringify([...markerOrdinals])}`);
            h.mock.setDefault({ text: "ordinary probe", usage: { input_tokens: 500, output_tokens: 20 } });
            h.setSessionCacheTtl(sessionId, "5m");
            const ordinaryConfig = { ...FOLD_CONFIG, cache_ttl: "5m", execute_threshold_tokens: { default: 800_000 } };
            h.subc.writeModuleConfig(ordinaryConfig);

            // The three probe passes below must all render the same session history.
            // A historian run still in flight when the fixture loop above stops (on a
            // slow runner the run covering the newest turn often is) would publish a
            // compartment between the control pass and the marker pass, and the two
            // would differ by that compartment rather than by the marker. Let every
            // run finish, then stop the producer so no later run can publish while
            // the passes are compared. Keep the module running so the one-step host
            // cut exercises its full-resync path rather than a cold module boot.
            const historianDeadline = Date.now() + 120_000;
            let historianState: string | undefined;
            while (Date.now() < historianDeadline) {
                const status = (await h.subc.moduleStatus(sessionId, h.env.workdir)) as {
                    historian?: { state?: string };
                };
                historianState = status.historian?.state;
                if (historianState === "idle") break;
                await Bun.sleep(100);
            }
            expect(historianState).toBe("idle");
            h.subc.killProducer();
            await h.subc.waitForProducerDeath();
            // Runtime config is also sent by the host; changing only the module's
            // file would leave the host's zero-TTL bust permission in force.
            await h.restart({ rust: true, magicContextConfig: ordinaryConfig });
            assertHermeticStores(h);
            // TTL policy freezes on the first model pass, independently of the
            // config file. End the fixture's zero-TTL setup explicitly so the
            // comparison really observes ordinary passes, not repeated idle busts.
            const contextWriter = new Database(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"));
            try {
                contextWriter.exec("PRAGMA busy_timeout=5000");
                contextWriter.query(`UPDATE session_meta SET cache_ttl='5m',
                    trailing_blank_decisions=json_set(trailing_blank_decisions,
                        '$.cacheTtlPolicy.value', '5m', '$.cacheTtlPolicy.config', '5m')
                    WHERE session_id=?`).run(sessionId);
            } finally { contextWriter.close(); }
            // A publication can finish after the last fold turn. Consume that
            // coverage on its bust before taking the marker snapshot, or the first
            // comparison would measure a new history render instead of SOFT+ replay.
            const settlingPasses = h.readRustPasses().length;
            await h.sendPrompt(sessionId, "settle the last published coverage");
            await h.waitForRustPasses(settlingPasses + 1);
            const summaryRows = opencodeDb.query(`SELECT * FROM message
                WHERE session_id=? AND json_extract(data, '$.summary')=1
                AND json_extract(data, '$.providerID')='magic-context'`).all(sessionId) as SqliteRow[];
            const compactionRows = opencodeDb.query(`SELECT * FROM part
                WHERE session_id=? AND json_extract(data, '$.type')='compaction'
                AND json_extract(data, '$.auto')=1`).all(sessionId) as SqliteRow[];
            expect(summaryRows).toHaveLength(1);
            expect(compactionRows).toHaveLength(1);
            const summaryPartRows = opencodeDb.query("SELECT * FROM part WHERE session_id=? AND message_id=?").all(sessionId, summaryRows[0]!.id) as SqliteRow[];
            // Simulate the frozen host cut without altering any indexed ends or
            // module state. Restoring these same rows is the one-step input shrink.
            opencodeDb.transaction(() => {
                for (const row of [...compactionRows, ...summaryPartRows]) {
                    opencodeDb.prepare("DELETE FROM part WHERE id=?").run(row.id);
                }
                opencodeDb.prepare("DELETE FROM message WHERE id=?").run(summaryRows[0]!.id);
            })();
            const publishedHistory = () =>
                contextHistoryRows(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"), sessionId);
            const historyBeforeComparison = publishedHistory();

            const probe = "byte identity marker probe";
            const probeMessageId = "msg_01MKRBYT3ID3NT1TYPR0BE0000";
            await Bun.sleep(700);
            const controlPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const controlPasses = await h.waitForRustPasses(controlPassesBefore + 1);
            const controlInput = controlPasses.at(-1)!.inputCount;
            const controlSerialized = h.lastMainWireSerialized();
            const controlHash = sha256(controlSerialized);
            const exactPrefix = () => {
                const body = h.mainRequests().at(-1)!.body;
                return JSON.stringify({ system: body.system, messages: body.messages });
            };
            const exactControl = exactPrefix();
            const controlProbe = (await h.listMessages(sessionId))
                .filter(
                    (message) =>
                        message.info?.role === "user" &&
                        message.parts?.some((part) => part.type === "text" && part.text === probe),
                )
                .at(-1)?.info?.id;
            expect(controlProbe).toBe(probeMessageId);
            await h.revertMessage(sessionId, controlProbe!);

            opencodeDb.transaction(() => {
                for (const row of summaryRows) {
                    opencodeDb
                        .prepare(
                            "INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                        )
                        .run(row.id, row.session_id, row.time_created, row.time_updated, row.data);
                }
                for (const row of [...compactionRows, ...summaryPartRows]) {
                    opencodeDb
                        .prepare(
                            "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
                        )
                        .run(
                            row.id,
                            row.message_id!,
                            row.session_id,
                            row.time_created,
                            row.time_updated,
                            row.data,
                        );
                }
            })();

            await Bun.sleep(700);
            const markerPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const markerPasses = await h.waitForRustPasses(markerPassesBefore + 1);
            const markerInput = markerPasses.at(-1)!.inputCount;
            const markerSerialized = h.lastMainWireSerialized();
            const markerHash = sha256(markerSerialized);
            const exactMarker = exactPrefix();
            const markerProbe = (await h.listMessages(sessionId))
                .filter(
                    (message) =>
                        message.info?.role === "user" &&
                        message.parts?.some((part) => part.type === "text" && part.text === probe),
                )
                .at(-1)?.info?.id;
            expect(markerProbe).toBe(probeMessageId);
            await h.revertMessage(sessionId, markerProbe!);

            const replayPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const replayPasses = await h.waitForRustPasses(replayPassesBefore + 1);
            const replaySerialized = h.lastMainWireSerialized();
            const replayHash = sha256(replaySerialized);
            expect(exactMarker).toBe(exactControl);
            expect(exactPrefix()).toBe(exactControl);

            // No compartment may land while the passes are compared; the producer is
            // gone, so a change here means the drain above missed a run.
            expect(publishedHistory()).toEqual(historyBeforeComparison);
            console.log(`rust marker byte identity control sha256=${controlHash}`);
            console.log(`rust marker byte identity post-cut-1 sha256=${markerHash}`);
            console.log(`rust marker byte identity post-cut-2 sha256=${replayHash}`);
            expect(controlInput).toBeGreaterThan(markerInput);
            expect(controlInput).toBeGreaterThan(12_900);
            expect(markerInput).toBeLessThan(400);
            expect(replayPasses.at(-1)!.inputCount).toBe(markerInput);
            const comparedPasses = [controlPasses.at(-1)!, markerPasses.at(-1)!, replayPasses.at(-1)!];
            console.log(`rust marker compared passes=${JSON.stringify(comparedPasses.map(pass => ({ decision: pass.decision, reason: pass.reason })))}`);
            expect(comparedPasses.every(pass => pass.applied && pass.servedFrom === "transform")).toBe(true);
            expect(comparedPasses.every(pass => pass.decision === "SOFT+" || pass.decision === "DEFER")).toBe(true);
            // The first smaller input is sent whole, not mistaken for an append
            // delta against the thousands of messages the module saw before it.
            expect(markerPasses.at(-1)!.wireMessages).toBe(markerInput);
            const ordinaryBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, "ordinary append after the input cut");
            const ordinaryPass = (await h.waitForRustPasses(ordinaryBefore + 1)).at(-1)!;
            expect(ordinaryPass.servedFrom).toBe("transform");
            expect(ordinaryPass.applied).toBe(true);
            expect(ordinaryPass.decision).toBe("SOFT+");
            expect(ordinaryPass.wireMessages).toBeLessThanOrEqual(4);
            const replayArray = JSON.parse(replaySerialized) as unknown[];
            expect((JSON.parse(h.lastMainWireSerialized()) as unknown[]).slice(0, replayArray.length)).toEqual(replayArray);
            const sessionLines = h.diagnosticLog().split("\n").filter(line => line.includes(`[${sessionId}]`));
            const moves = sessionLines.flatMap((line, index) => line.includes("compaction-marker drain: applied") ? [index] : []);
            expect(moves.length).toBeGreaterThanOrEqual(3);
            for (const index of moves) {
                const consumingPass = sessionLines.slice(index + 1).find(line => line.includes("rust pass:"));
                expect(consumingPass).toMatch(/decision=(?:HARD|SOFT)\s/);
            }
            expect(sessionLines.filter(line => /rust transform failed|lkg_replay_served|mc_rust_\w*refusal|served_from=refused|replaying LKG/.test(line))).toEqual([]);
            console.log(`one-step input shrink=${controlInput}->${markerInput}; full cut send=${markerPasses.at(-1)!.wireMessages}; next ordinary delta=${ordinaryPass.wireMessages}`);
            if (controlHash !== markerHash || markerHash !== replayHash) {
                const firstDifference =
                    controlHash !== markerHash
                        ? [...controlSerialized].findIndex(
                              (character, index) => character !== markerSerialized[index],
                          )
                        : [...markerSerialized].findIndex(
                              (character, index) => character !== replaySerialized[index],
                          );
                throw new Error(
                    `wire bytes diverged at ${firstDifference}: ` +
                        `control=${JSON.stringify(controlSerialized.slice(firstDifference, firstDifference + 500))} ` +
                        `postRestart1=${JSON.stringify(markerSerialized.slice(firstDifference, firstDifference + 500))} ` +
                        `postRestart2=${JSON.stringify(replaySerialized.slice(firstDifference, firstDifference + 500))}`,
                );
            }
            opencodeDb.close();
        },
        600_000,
    );

    it("recovers ALF-like seven sparse gaps but preserves the old cut when a post-marker gap contains a real message", async () => {
        const initialSession = await h.createSession();
        await h.sendPrompt(initialSession, "initial isolation probe");
        assertHermeticStores(h);
        for (const realGap of [false, true]) {
            // Stage an old TS-era cut before this session's first Rust transform.
            // This is generated fixture content, never a copy of the live store.
            await h.restart({ rust: false, magicContextConfig: FOLD_CONFIG });
            assertHermeticStores(h);
            const sessionId = await h.createSession();
            h.mock.setDefault({ text: "fixture seed", usage: { input_tokens: 500, output_tokens: 20 } });
            await h.sendPrompt(sessionId, "seed sparse history");
            h.appendSyntheticHistory(sessionId, { count: 160, textBytes: 64 });
            const oc = new Database(join(h.env.dataDir, "opencode", "opencode.db"));
            const context = new Database(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"));
            let seedBoundaryId = "";
            let recoveredEndMessageId = "";
            try {
                oc.exec("PRAGMA busy_timeout=30000");
                context.exec("PRAGMA busy_timeout=30000");
                const raw = oc.query("SELECT id,time_created FROM message WHERE session_id=? AND json_extract(data,'$.summary') IS NOT 1 ORDER BY time_created,id").all(sessionId) as Array<{ id: string; time_created: number }>;
                seedBoundaryId = `${raw[139]!.id}#0`;
                recoveredEndMessageId = raw[139]!.id;
                const ranges = [[1,15],[17,28],[30,42],[44,62],[64,74],[76,84],[87,108],[111,140]];
                const notices = [16,29,43,63,75,85,86,109,110];
                for (const ordinal of notices) {
                    const message = raw[ordinal-1]!;
                    oc.query("UPDATE part SET data=json_set(data,'$.synthetic',json('true')) WHERE session_id=? AND message_id=?").run(sessionId, message.id);
                }
                if (realGap) {
                    const message = raw[84]!;
                    oc.query("INSERT INTO part (id,session_id,message_id,time_created,time_updated,data) VALUES (?,?,?,?,?,?)").run("prt_real_gap", sessionId, message.id, message.time_created+1, message.time_created+1, JSON.stringify({id:"prt_real_gap",sessionID:sessionId,messageID:message.id,type:"text",text:"REAL UNSUMMARIZED GAP CONTENT"}));
                }
                for (const [sequence, [start, end]] of ranges.entries()) {
                    context.query(`INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,start_block_index,end_block_index,title,content,p1,importance,episode_type,created_at)
                        VALUES (?,?,?,?,?,?,0,0,'fixture','covered generated history','covered generated history',50,'feature',1)`).run(sessionId, sequence, start!, end!, raw[start!-1]!.id, raw[end!-1]!.id);
                }
                const previousDb = process.env.OPENCODE_DB;
                try {
                    process.env.OPENCODE_DB = join(h.env.dataDir, "opencode", "opencode.db");
                    expect(await prepareCompactionMarkerCandidates(sessionId)).toBe(true);
                    const marker = injectCompactionMarker({ sessionId, endOrdinal: 50, endMessageId: raw[49]!.id, summaryText: MARKER_SUMMARY_TEXT, directory: h.env.workdir });
                    expect(marker).not.toBeNull();
                    context.query("UPDATE session_meta SET compaction_marker_state=?, pending_compaction_marker_state=NULL WHERE session_id=?").run(JSON.stringify({ ...marker, boundaryOrdinal: 50, targetEndMessageId: raw[49]!.id }), sessionId);
                } finally {
                    closeCompactionMarkerDb();
                    if (previousDb === undefined) delete process.env.OPENCODE_DB;
                    else process.env.OPENCODE_DB = previousDb;
                }
            } finally { oc.close(); context.close(); }
            // Import the legacy history with its actual last-block anchor, which
            // remains visible after the old host cut. A missing TS-era anchor
            // would correctly trigger pending_rewrite instead of marker recovery.
            const seed = await h.subc.moduleRequest(sessionId, h.env.workdir, { method: "state_sync", shadow_generation: 0, expected_shadow_seq: 0, seed_boundary_id: seedBoundaryId });
            expect(seed.ok).toBe(true);
            h.subc.writeModuleConfig(FOLD_CONFIG);
            await h.restart({ rust: true, magicContextConfig: FOLD_CONFIG });
            assertHermeticStores(h);
            const before = h.readRustPasses().length;
            const providerRequestsBefore = h.mainRequests().length;
            const deferralsBefore = markerDiscoveryDeferrals(h, sessionId);
            const recoveringTurn = h.sendPrompt(sessionId, "recover this sparse history on a genuine bust");
            if (realGap) {
                // OpenCode may return a completed assistant carrying an error or
                // reject the HTTP call. The semantic refusal, exact module cause
                // and absence of a provider send are required below in either case.
                await recoveringTurn.catch(() => undefined);
            } else {
                await recoveringTurn;
            }
            const pass = (await h.waitForRustPasses(before+1)).at(-1)!;
            if (realGap) {
                // The real module independently refuses a PRESENT uncovered item
                // before even reaching host repair. Require that precise safe
                // refusal, not any startup error, and never send a lossy prefix.
                expect(pass.applied).toBe(false);
                expect(pass.servedFrom).toBe("refused");
                expect(h.diagnosticLog()).toContain("(ordinal 85) sits at or below coverage end Some(140) but no compartment covers it");
                expect(h.mainRequests().length).toBe(providerRequestsBefore);
            } else {
                expect(pass.applied).toBe(true);
                expect(pass.servedFrom).toBe("transform");
                expect(pass.decision).toMatch(/^(HARD|SOFT|MIGRATE_HARD)$/);
            }
            const markerState = () => {
                const state = (h.contextDb().query("SELECT compaction_marker_state FROM session_meta WHERE session_id=?").get(sessionId) as { compaction_marker_state: string }).compaction_marker_state;
                return JSON.parse(state) as { boundaryOrdinal: number };
            };
            // Without the real gap, the recovering pass is the first pass of a
            // freshly restarted plugin, and the summary discovery a marker move
            // needs starts on that same pass, in the background. The pass serves
            // the recovered history without waiting for it and records the 140
            // target as pending; a later cache-busting pass moves the marker. Both
            // cases get that later rebuild, so the real-gap case shows the old cut
            // is still kept at a point where a move could have happened.
            if (realGap) {
                const flushedBefore = h.readRustPasses().length;
                await requestRustCtxFlush(h, sessionId);
                await h.sendPrompt(sessionId, "a requested rebuild still cannot cover the real gap").catch(() => undefined);
                const flushed = (await h.waitForRustPasses(flushedBefore + 1)).at(-1)!;
                expect(flushed.applied).toBe(false);
                expect(flushed.servedFrom).toBe("refused");
                expect(h.mainRequests().length).toBe(providerRequestsBefore);
            } else if (markerState().boundaryOrdinal !== 140) {
                expect(markerDiscoveryDeferrals(h, sessionId)).toBe(deferralsBefore + 1);
                const pending = JSON.parse((h.contextDb().query("SELECT pending_compaction_marker_state FROM session_meta WHERE session_id=?").get(sessionId) as { pending_compaction_marker_state: string }).pending_compaction_marker_state) as { ordinal: number; endMessageId: string };
                expect(pending.ordinal).toBe(140);
                expect(pending.endMessageId).toBe(recoveredEndMessageId);
                await driveDeferredMarkerMove(h, sessionId, () => markerState().boundaryOrdinal !== 50, "move the recovered marker on a requested rebuild");
            }
            const marker = markerState();
            expect(marker.boundaryOrdinal).toBe(realGap ? 50 : 140);
            console.log(`ALF-like gaps=7, sizes=1,1,1,1,1,2,2, behind-marker=3, real-gap=${realGap}, marker=${marker.boundaryOrdinal}`);
        }
    }, 300_000);


    it("real producer metadata-only committed execute cannot drain pending markers on unchanged SOFT+", async () => {
        const isolationSession = await h.createSession();
        await h.sendPrompt(isolationSession, "metadata fixture isolation probe");
        assertHermeticStores(h);
        const config = { ...FOLD_CONFIG, cache_ttl: "5m" };
        h.subc.writeModuleConfig(config);
        await h.restart({ rust: true, magicContextConfig: config });
        const sessionId = await h.createSession();
        h.mock.setDefault({ text: "metadata reply", usage: { input_tokens: 50_000, output_tokens: 20 } });
        const warmBefore = h.readRustPasses().length;
        await h.sendPrompt(sessionId, "warm the metadata-only execute fixture");
        await h.waitForRustPasses(warmBefore + 1);
        assertHermeticStores(h);
        // Anthropic merges adjacent user messages; compare the two frozen history
        // blocks, not the growing user/assistant tail or moving tail breakpoint.
        const historyBlocks = () => (JSON.parse(h.lastMainWireSerialized()) as Array<{ content: unknown[] }>)[0]!.content.slice(0,2);
        const first = historyBlocks();
        const firstUser = (await h.listMessages(sessionId)).find(message => message.info?.role === "user")!.info!.id!;
        const context = new Database(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"));
        const pending = { ordinal: 1, endMessageId: firstUser, publishedAt: 1, injectAttempts: 3 };
        try {
            context.query(`UPDATE session_meta SET cache_ttl='5m', trailing_blank_decisions=json_set(trailing_blank_decisions,
                '$.cacheTtlPolicy.value','5m','$.cacheTtlPolicy.config','5m'), pending_compaction_marker_state=? WHERE session_id=?`).run(stableStringify(pending), sessionId);
        }
        finally { context.close(); }
        const before = h.readRustPasses().length;
        await h.sendPrompt(sessionId, "execute with no new published history");
        const pass = (await h.waitForRustPasses(before+1)).at(-1)!;
        expect(pass.decision).toBe("SOFT+");
        expect(pass.raw).toContain("scheduler=execute");
        expect(pass.raw).toContain("committed=true");
        expect(pass.servedFrom).toBe("transform");
        expect(historyBlocks()).toEqual(first);
        const row = h.contextDb().query("SELECT pending_compaction_marker_state FROM session_meta WHERE session_id=?").get(sessionId) as { pending_compaction_marker_state: string };
        expect(JSON.parse(row.pending_compaction_marker_state)).toEqual(pending);
        console.log(`real metadata-only execute: ${pass.raw}`);
    }, 180_000);

    it("recovery uses real session.flush and only supported rebuilding admission clears the fence", async () => {
        // Keep TTL alive so recovery depends on the dispatched flush, not an
        // unrelated idle-expiry HARD opportunity.
        const config = { ...FOLD_CONFIG, cache_ttl: "5m" };
        h.subc.writeModuleConfig(config);
        await h.restart({ rust: false, magicContextConfig: config });
        const sessionId = await h.createSession();
        h.mock.setDefault({ text: "fence recovery reply", usage: { input_tokens: 500, output_tokens: 20 } });
        await h.sendPrompt(sessionId, "seed the summarized fence recovery history");
        const firstUser = (await h.listMessages(sessionId)).find(message => message.info?.role === "user")!.info!.id!;
        const contextPath = join(h.env.dataDir, "cortexkit", "magic-context", "context.db");
        const seedContext = new Database(contextPath);
        try {
            seedContext.exec("PRAGMA busy_timeout=30000");
            seedContext.query(`INSERT INTO compartments(session_id,sequence,start_message,end_message,
                start_message_id,end_message_id,start_block_index,end_block_index,title,content,p1,importance,episode_type,created_at)
                VALUES (?,0,1,1,?,?,0,0,'fixture','covered seed history','covered seed history',50,'feature',1)`)
                .run(sessionId, firstUser, firstUser);
        } finally { seedContext.close(); }
        const seed = await h.subc.moduleRequest(sessionId, h.env.workdir, {
            method: "state_sync", shadow_generation: 0, expected_shadow_seq: 0, seed_boundary_id: `${firstUser}#0`,
        });
        expect(seed.ok).toBe(true);
        await h.restart({ rust: true, magicContextConfig: config });
        const warmBefore = h.readRustPasses().length;
        await h.sendPrompt(sessionId, "warm the real fence recovery fixture");
        await h.waitForRustPasses(warmBefore + 1);
        assertHermeticStores(h);
        for (const restart of [false, true]) {
            // Recreate the durable state left by an unadmitted cut, not a mock
            // flush acknowledgement. The live module must dispatch and rebuild it.
            const context = new Database(contextPath);
            try {
                context.exec("PRAGMA busy_timeout=30000");
                context.transaction(() => {
                    // End the harness's frozen zero-TTL setup explicitly; changing
                    // config alone does not replace an already adopted TTL policy.
                    context.query(`UPDATE session_meta SET cache_ttl='5m', trailing_blank_decisions=json_set(
                        COALESCE(NULLIF(trailing_blank_decisions,''),'{"version":2,"trailingBlank":{}}'),
                        '$.version',2,'$.trailingBlank',json('{}'),'$.rustMarkerAdmissionFence',json('true'),
                        '$.cacheTtlPolicy.value','5m','$.cacheTtlPolicy.config','5m')
                        WHERE session_id=?`).run(sessionId);
                    context.query("DELETE FROM lkg_slot_chunks WHERE session_id=?").run(sessionId);
                    context.query("DELETE FROM lkg_slots WHERE session_id=?").run(sessionId);
                }).immediate();
            } finally { context.close(); }
            if (restart) await h.restart({ rust: true, magicContextConfig: config });
            assertHermeticStores(h);
            const before = h.readRustPasses().length;
            const providerRequestsBefore = h.mainRequests().length;
            await h.sendPrompt(sessionId, `recover the armed fence restart=${restart}`);
            const pass = (await h.waitForRustPasses(before + 1)).at(-1)!;
            console.log(`real fence recovery restart=${restart}: ${pass.raw}`);
            if (!pass.applied) throw new Error(`real fence recovery refused:\n${h.diagnosticLog().slice(-6000)}`);
            expect(pass.applied).toBe(true);
            expect(pass.servedFrom).toBe("transform");
            expect(pass.decision).toBe("SOFT");
            expect(pass.raw).toContain("prefix_bust_permitted=true");
            expect(pass.wireMessages).toBe(pass.inputCount);
            expect(h.mainRequests().length).toBeGreaterThan(providerRequestsBefore);
            const state = h.contextDb().query(`SELECT
                COALESCE(json_extract(trailing_blank_decisions,'$.rustMarkerAdmissionFence'),0) AS fence,
                (SELECT count(*) FROM lkg_slots WHERE session_id=?) AS slots
                FROM session_meta WHERE session_id=?`).get(sessionId, sessionId) as { fence: number; slots: number };
            expect(state).toEqual({ fence: 0, slots: 1 });
        }
    }, 180_000);
});
