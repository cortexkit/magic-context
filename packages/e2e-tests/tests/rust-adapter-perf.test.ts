/// <reference types="bun-types" />
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, constants } from "node:fs";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";
import { SubcModuleTransport } from "../../plugin/src/hooks/magic-context/module-transport";
import { createRustModeTransform } from "../../plugin/src/hooks/magic-context/rust-mode-transform";
import { setRawMessageProvider } from "../../plugin/src/hooks/magic-context/read-session-chunk";
import { closeReadOnlySessionDb } from "../../plugin/src/hooks/magic-context/read-session-db";
import type { TransformDeps } from "../../plugin/src/hooks/magic-context/transform";
import type { MessageLike } from "../../plugin/src/hooks/magic-context/transform-operations";
import { Database } from "../../plugin/src/shared/sqlite";
import * as logger from "../../plugin/src/shared/logger";
import type { ContextDatabase } from "../../plugin/src/features/magic-context/storage";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import {
    measureLoopback,
    median,
    profileAdapterReceive,
} from "../src/rust-runner/adapter-profiler";
import * as persisted from "../../plugin/src/features/magic-context/storage-meta-persisted";
import { getOrCreateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";

// The daemon and module are real; only the host's raw-session reader is seeded in memory.
// No production store, daemon connection file, or installed binary is used.
describe.skipIf(!rustPrereqs.ok)("rust adapter performance", () => {
    const cleanups: Array<() => void | Promise<void>> = [];
    afterEach(async () => {
        const failures: unknown[] = [];
        for (const cleanup of cleanups.splice(0).reverse()) {
            try {
                await cleanup();
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length) throw new AggregateError(failures, "adapter benchmark cleanup failed");
    });
    it("profiles four defer passes over a 1500-message tool-heavy session", async () => {
        const h = await RustTestHarness.create({ startHistorianProducer: false });
        cleanups.push(() => h.dispose());
        const originalDataHome = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = h.env.dataDir;
        cleanups.push(() => {
            closeReadOnlySessionDb();
            if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = originalDataHome;
        });
        const snapshot = process.env.MC_ADAPTER_CONTEXT_SNAPSHOT;
        const dbPath = join(h.env.dataDir, "adapter-context.db");
        if (snapshot) copyFileSync(snapshot, dbPath, constants.COPYFILE_FICLONE);
        const db = new Database(snapshot ? dbPath : ":memory:") as ContextDatabase;
        db.exec("PRAGMA busy_timeout = 5000");
        cleanups.push(() => { db.close(); });
        if (!snapshot) {
            initializeDatabase(db);
            runMigrations(db);
        }
        const sessionId = "ses_adapter_perf";
        getOrCreateSessionMeta(db, sessionId);
        if (snapshot) {
            const sourceSession =
                process.env.MC_ADAPTER_SNAPSHOT_SESSION ?? "ses_227ce5788ffeRPA9THoPLOQreO";
            const columns = [
                "note_nudge_anchors",
                "auto_search_hint_decisions",
                "trailing_blank_decisions",
                "merged_reasoning_stripped_ids",
            ];
            const source = db
                .prepare(`SELECT ${columns.join(",")} FROM session_meta WHERE session_id = ?`)
                .get(sourceSession) as Record<string, string>;
            expect(source).toBeTruthy();
            for (const column of columns)
                db.prepare(`UPDATE session_meta SET ${column} = ? WHERE session_id = ?`).run(
                    source[column],
                    sessionId,
                );
            console.log(
                `adapter-snapshot bytes=${JSON.stringify(Object.fromEntries(columns.map((c) => [c, source[c]?.length])))}`,
            );
        }
        const messages: MessageLike[] = Array.from({ length: 1500 }, (_, i) => ({
            info: {
                id: `msg_perf_${String(i).padStart(5, "0")}`,
                role: i % 5 === 0 ? "user" : "assistant",
                sessionID: sessionId,
                model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
            },
            parts:
                i % 5 === 0
                    ? [{ type: "text", text: `request ${i} ${"y".repeat(1000)}` }]
                    : [
                          {
                              type: "tool",
                              callID: `call_${i}`,
                              tool: "read",
                              state: {
                                  status: "completed",
                                  input: { path: `src/${i}.ts` },
                                  output: `result ${i} ${"x".repeat(1000)}`,
                              },
                          },
                      ],
        }));
        const rows = messages.map((m, i) => ({
            id: m.info.id as string,
            ordinal: i + 1,
            role: String(m.info.role),
            parts: m.parts,
            createdAt: i + 1,
            timeCreated: i + 1,
            contributesOrdinal: true,
            hasValidInfo: true,
        }));
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => rows,
            readMessageOrdinalPage: (after, limit) =>
                rows.filter((r) => !after || r.timeCreated > after.timeCreated).slice(0, limit),
            getStoredMessageCount: () => rows.length,
            readMessagePartsById: (id) => {
                const index = rows.findIndex((r) => r.id === id);
                const message = messages[index];
                return message
                    ? {
                          id,
                          role: String(message.info.role),
                          parts: message.parts,
                          createdAt: index + 1,
                      }
                    : null;
            },
        });
        cleanups.push(unregister);
        const transport = new SubcModuleTransport(h.subc.connectionFile);
        await transport.call({
            sessionId,
            projectRoot: h.env.workdir,
            method: "session.status",
            body: { method: "session.status", v: 1, session_id: sessionId },
        });
        const receive = profileAdapterReceive(transport);
        cleanups.push(() => receive.dispose());
        const status = {
            method: "session.status" as const,
            v: 1,
            session_id: sessionId,
            padding: "",
        };
        status.padding = "x".repeat(18 * 1024 - Buffer.byteLength(JSON.stringify(status)));
        const loopbackBody = Buffer.from(JSON.stringify(status));
        const sdkSamples: number[] = [];
        const adapterSamples: number[] = [];
        for (let i = 0; i < 21; i++) {
            let started = performance.now();
            await receive.bareRequest(loopbackBody);
            if (i > 0) sdkSamples.push(performance.now() - started);
            started = performance.now();
            await transport.call({
                sessionId,
                projectRoot: h.env.workdir,
                method: "session.status",
                body: loopbackBody,
            });
            if (i > 0) adapterSamples.push(performance.now() - started);
        }
        console.log(
            `adapter-loopback bytes=${loopbackBody.length} tcp_echo_p50_ms=${(await measureLoopback(loopbackBody)).toFixed(3)} sdk_status_p50_ms=${median(sdkSamples).toFixed(3)} adapter_status_p50_ms=${median(adapterSamples).toFixed(3)}`,
        );
        expect(receive.sample().frames).toBe(42);
        expect(receive.sample().replyPages).toBe(1);
        let receiveSample = receive.sample();
        let replayReadMs = 0;
        const readReplay = persisted.getTrailingBlankDecisions;
        const replayProbe = spyOn(persisted, "getTrailingBlankDecisions").mockImplementation(
            (...args) => {
                const start = performance.now();
                try {
                    return readReplay(...args);
                } finally {
                    replayReadMs += performance.now() - start;
                }
            },
        );
        cleanups.push(() => {
            replayProbe.mockRestore();
        });
        let latestResponse: Record<string, unknown> = {};
        let requestObservedAtMs: unknown;
        const call = transport.call.bind(transport);
        transport.call = async (args) => {
            if (args.method === "transform") receive.reset();
            const response = await call(args);
            if (args.method === "transform") {
                receiveSample = receive.sample();
                latestResponse = response as Record<string, unknown>;
                requestObservedAtMs = (args.body as Record<string, unknown>).request_observed_at_ms;
            }
            return response;
        };
        const logs: string[] = [];
        const log = spyOn(logger, "sessionLog").mockImplementation((_session, ...args) => {
            logs.push(args.join(" "));
        });
        cleanups.push(() => {
            log.mockRestore();
        });
        const deps: TransformDeps = {
            tagger: {} as TransformDeps["tagger"],
            scheduler: {} as TransformDeps["scheduler"],
            contextUsageMap: new Map(),
            db,
            protectedTokens: 4,
            clearReasoningAge: 50,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            directory: h.env.workdir,
            projectPath: h.env.workdir,
            memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
            liveModelBySession: new Map([
                [sessionId, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }],
            ]),
            sessionDirectoryBySession: new Map(),
            transformMode: "rust",
            rustModeModuleClient: transport,
        };
        const transform = createRustModeTransform(deps, {
            moduleClient: transport,
            projectRoot: h.env.workdir,
        });
        cleanups.push(() => transform.clearSession(sessionId));
        const overheads: number[] = [];
        const hashes: string[] = [];
        let previousMessages: string[] = [];
        for (let pass = 0; pass < 5; pass++) {
            if (pass > 0) {
                const i = messages.length;
                const message = {
                    info: {
                        id: `msg_perf_${String(i).padStart(5, "0")}`,
                        role: "user",
                        sessionID: sessionId,
                        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
                    },
                    parts: [{ type: "text", text: `defer ${pass} ${"z".repeat(7200)}` }],
                };
                messages.push(message);
                rows.push({
                    id: message.info.id as string,
                    ordinal: i + 1,
                    role: "user",
                    parts: message.parts,
                    createdAt: i + 1,
                    timeCreated: i + 1,
                    contributesOrdinal: true,
                    hasValidInfo: true,
                });
            }
            const output: { messages: unknown[] } = { messages: [] };
            replayReadMs = 0;
            const start = performance.now();
            await transform.run(sessionId, messages, output, getOrCreateSessionMeta(db, sessionId));
            const elapsed = performance.now() - start;
            const line = [...logs].reverse().find((l) => l.startsWith("rust pass:"));
            console.log(
                `adapter-perf pass=${pass} wall_ms=${elapsed.toFixed(2)} sha256=${createHash("sha256").update(JSON.stringify(output.messages)).digest("hex")} ${line}`,
            );
            const moduleTimings = latestResponse.timings as Record<string, number>;
            if (pass > 0) {
                overheads.push(elapsed - moduleTimings.handler_total);
                hashes.push(
                    createHash("sha256").update(JSON.stringify(output.messages)).digest("hex"),
                );
                // This 1500-message response is larger than a unary frame. The
                // profiler counts decoded physical pages, not logical transforms.
                expect(receiveSample.replyPages).toBeGreaterThan(1);
                expect(receiveSample.frames).toBe(receiveSample.replyPages);
                expect(output.messages).toHaveLength(messages.length + 2);
                expect(
                    output.messages.slice(0, previousMessages.length).map((message) => JSON.stringify(message)),
                ).toEqual(previousMessages);
                expect(Number.isFinite(moduleTimings.handler_total)).toBe(true);
                expect(line).toContain("wire_messages:2");
            }
            console.log(
                `adapter-response pass=${pass} request_observed_at_ms=${requestObservedAtMs} handler_total=${moduleTimings?.handler_total} request_observed_to_handler=${moduleTimings?.request_observed_to_handler} replay_read_ms=${replayReadMs.toFixed(3)} receive=${JSON.stringify(receiveSample)}`,
            );
            if (!line?.includes("applied=true")) console.log(logs.join("\n"));
            expect(line).toContain("applied=true");
            if (pass > 0) expect(line).toContain("decision=SOFT+");
            previousMessages = output.messages.map((message) => JSON.stringify(message));
            await Bun.sleep(20);
        }
        console.log(
            `adapter-summary overhead_p50_ms=${median(overheads).toFixed(3)} hashes=${JSON.stringify(hashes)}`,
        );
        if (process.env.MC_PERF_GATE === "1") expect(median(overheads)).toBeLessThan(40);
        if (process.env.MC_ADAPTER_BASELINE_LOG) {
            const baseline = await Bun.file(process.env.MC_ADAPTER_BASELINE_LOG).text();
            const expected = [
                ...baseline.matchAll(/adapter-perf pass=[1-4] .*?sha256=([0-9a-f]{64})/g),
            ].map((match) => match[1]);
            expect(expected).toHaveLength(4);
            expect(hashes).toEqual(expected);
        }
    }, 600_000);
});
