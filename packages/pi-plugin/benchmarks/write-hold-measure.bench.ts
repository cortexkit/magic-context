// Run explicitly with bun test benchmarks/write-hold-measure.bench.ts.
// HOLD_PASSES controls the number of measured passes of each kind (default 200).
// HOLD_TAGS pads the seed with historical drops; HOLD_DROPS sets how many active
// tool tags are queued for dropping in each busting pass.
import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    getOrCreateSessionMeta,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { saveNativeToolInputs } from "@magic-context/core/features/magic-context/storage-native-replay";
import * as logger from "@magic-context/core/shared/logger";
import * as timing from "@magic-context/core/shared/write-transaction-timing";
import { measuredPassSchedule } from "../../../scripts/paired-write-hold-protocol";
import {
    clearContextHandlerSession,
    registerPiContextHandler,
    signalPiPendingMaterialization,
} from "../src/context-handler";
import { NATIVE_TOOL_REMOVAL_MARKER } from "../src/native-replay-pi";
import {
    createFakePi,
    createTestDb,
    fakeContext,
    toolResultMessage,
    userMessage,
} from "../src/test-utils.test";

const MODEL = {
    provider: "anthropic",
    id: "claude-opus-5-5",
    api: "anthropic-messages",
    contextWindow: 200_000,
    reasoning: true,
};
const TURNS = Number(process.env.HOLD_TURNS ?? 1300);
const DROPS = Number(process.env.HOLD_DROPS ?? 1);
const SEED_TAGS = Number(process.env.HOLD_TAGS ?? 0);

/**
 * Times every write-lock hold on this connection, independent of which code
 * instruments itself: each outermost BEGIN..COMMIT/ROLLBACK, and each write
 * statement run outside a transaction (it holds the lock for its own run).
 */
function lockClock(db: {
    exec: (...a: never[]) => unknown;
    run?: (...a: never[]) => unknown;
    prepare: (...a: never[]) => unknown;
    query?: (...a: never[]) => unknown;
    transaction: (...a: never[]) => unknown;
}) {
    const holds: number[] = [];
    const labels: string[] = [];
    const windows: { start: number; end: number }[] = [];
    let begun: number | undefined;
    let label = "";
    const push = (held: number, what: string) => {
        holds.push(held);
        labels.push(what);
        const end = Date.now();
        windows.push({ start: end - held, end });
    };
    const head = (sql: string) => sql.trimStart().slice(0, 16).toUpperCase();
    const write = (sql: string) =>
        /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|WITH)/.test(head(sql));
    const onSql = <T>(sql: string, run: () => T): T => {
        const h = head(sql);
        if (h.startsWith("BEGIN")) {
            const result = run();
            if (begun === undefined) {
                begun = performance.now();
                label = "";
            }
            return result;
        }
        if (
            h.startsWith("COMMIT") ||
            h.startsWith("END") ||
            h === "ROLLBACK" ||
            h.startsWith("ROLLBACK TRANS")
        ) {
            const result = run();
            if (begun !== undefined) push(performance.now() - begun, `tx:${label}`);
            begun = undefined;
            return result;
        }
        if (begun === undefined && write(sql)) {
            const started = performance.now();
            const result = run();
            push(performance.now() - started, `stmt:${sql.trim().slice(0, 50)}`);
            return result;
        }
        if (begun !== undefined && !label && write(sql)) label = sql.trim().slice(0, 50);
        return run();
    };
    const anyDb = db as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ["exec", "run"]) {
        const original = anyDb[name]?.bind(db);
        if (original)
            anyDb[name] = (sql: unknown, ...rest: unknown[]) =>
                onSql(String(sql), () => original(sql, ...rest));
    }
    for (const name of ["prepare", "query"]) {
        const original = anyDb[name]?.bind(db);
        if (!original) continue;
        anyDb[name] = (sql: unknown, ...rest: unknown[]) => {
            const statement = original(sql, ...rest) as Record<
                string,
                (...a: unknown[]) => unknown
            >;
            const text = String(sql);
            for (const method of ["run", "all", "get", "values"]) {
                const call = statement[method]?.bind(statement);
                if (call)
                    statement[method] = (...params: unknown[]) =>
                        onSql(text, () => call(...params));
            }
            return statement;
        };
    }
    const transaction = anyDb.transaction.bind(db);
    anyDb.transaction = (fn: unknown) => {
        const wrapped = transaction((...a: unknown[]) => {
            const outer = begun === undefined;
            if (outer) {
                begun = performance.now();
                label = "";
            }
            try {
                return (fn as (...b: unknown[]) => unknown)(...a);
            } finally {
                // Bun's transaction commits after the callback; the BEGIN/COMMIT
                // it issues internally may bypass the patched methods.
                if (outer) (wrapped as { __outer?: boolean }).__outer = true;
            }
        }) as Record<string, unknown>;
        for (const mode of ["deferred", "immediate", "exclusive"]) {
            const run = wrapped[mode] as ((...a: unknown[]) => unknown) | undefined;
            if (!run) continue;
            wrapped[mode] = (...a: unknown[]) => {
                const outer = begun === undefined;
                try {
                    return run(...a);
                } finally {
                    if (outer && begun !== undefined) {
                        push(performance.now() - begun, `tx:${label}`);
                        begun = undefined;
                    }
                }
            };
        }
        return wrapped;
    };
    return { holds, labels, windows };
}
const PASSES = Number(process.env.HOLD_PASSES ?? 200);

it("pi write-lock hold per pass", async () => {
    const dir = mkdtempSync(join(process.env.HOLD_DIR ?? tmpdir(), "pi-hold-"));
    const db = createTestDb(join(dir, "context.db"));
    const lock = lockClock(db as never);
    const lockHolds = lock.holds;
    const sessionId = "pi-hold-bench";
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        cacheTtl: "59m",
        lastResponseTime: Date.now(),
    });
    const fake = createFakePi();
    let busted: boolean | undefined;
    registerPiContextHandler(
        fake.pi as never,
        {
            db,
            protectedTokens: 4000,
            signedThinkingHold: "on",
            ...(process.env.HOLD_INJECTION === "0"
                ? {}
                : {
                      injection: {
                          injectionBudgetTokens: 4000,
                          memoryEnabled: false,
                          injectDocs: false,
                      },
                  }),
            heuristics: { keepReasoningTokens: 1_000_000 },
            onPostprocess: (result: { bustedThisPass: boolean }) => {
                busted = result.bustedThisPass;
            },
        } as never,
    );
    const handler = fake.handlers.get("context") as (
        event: { messages: unknown[] },
        ctx: never,
    ) => Promise<{ messages: unknown[] } | undefined>;
    const messages: unknown[] = [];
    const ids: string[] = [];
    let n = 0;
    const assistant = (content: unknown[]) => {
        n++;
        messages.push({
            role: "assistant",
            content: [
                {
                    type: "thinking",
                    thinking: `Reasoning for step ${n}. ${"detail ".repeat(20)}`,
                    thinkingSignature: `sig-${n}`,
                },
                ...content,
            ],
            api: MODEL.api,
            provider: MODEL.provider,
            model: MODEL.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1000 + messages.length,
        });
        ids.push(`a-${n}`);
    };
    const tool = () => {
        const call = `call-${n + 1}`;
        assistant([
            {
                type: "toolCall",
                id: call,
                name: "Read",
                arguments: { path: `${n}.ts` },
            },
        ]);
        messages.push(
            toolResultMessage(call, `result ${n} ${"line ".repeat(60)}`, 1000 + messages.length),
        );
        ids.push(`r-${n}`);
    };
    const user = (text: string) => {
        messages.push(userMessage(text, 1000 + messages.length));
        ids.push(`u-${messages.length}`);
    };
    for (let t = 0; t < TURNS; t++) {
        user(`Task ${t}`);
        tool();
        assistant([{ type: "text", text: `Done with task ${t}.` }]);
    }
    user("Current task");
    const holds: { site: string; held: number; start: number; end: number }[] = [];
    const stages = new Map<string, number>();
    const stageLog = spyOn(logger, "sessionLog").mockImplementation(
        (_session: string, message: string) => {
            const match = /^transform stage: stage=(\S+) elapsed=([\d.]+)ms/.exec(String(message));
            if (match?.[1]) stages.set(match[1], (stages.get(match[1]) ?? 0) + Number(match[2]));
        },
    );
    const spy = spyOn(timing, "logSlowWriteTransaction").mockImplementation(
        (site: string, startedAt: number, _t?: number, completedAt?: number) => {
            const held = (completedAt ?? performance.now()) - startedAt;
            const end = Date.now();
            holds.push({
                site,
                held,
                start: end - held,
                end,
            });
        },
    );
    const rows: unknown[] = [];
    const bustingHolds: number[] = [];
    const pairedHolds: number[] = [];
    let seededTags = 0;
    const pass = async (kind: string) => {
        holds.length = 0;
        lockHolds.length = 0;
        stages.clear();
        lock.labels.length = 0;
        lock.windows.length = 0;
        busted = undefined;
        const source = structuredClone(messages);
        const ctx = {
            ...fakeContext(sessionId, process.cwd(), ids, source as never),
            model: MODEL,
            getContextUsage: () => ({
                tokens: 40_000,
                percent: 20,
                contextWindow: 200_000,
            }),
        };
        const start = Date.now();
        const started = performance.now();
        let failed = false;
        let failure: unknown;
        try {
            await handler({ messages: source }, ctx as never);
        } catch (error) {
            failed = true;
            failure = error;
        }
        const wall = performance.now() - started;
        const row = {
            kind,
            start,
            end: Date.now(),
            paired: holds.filter((hold) => hold.site === "paired_thinking_edit"),
            connectionHold: lock.windows[lockHolds.indexOf(Math.max(...lockHolds))],
            busted,
            wall,
            maxHeld: Math.max(0, ...holds.map((h) => h.held)),
            lockMax: Math.max(0, ...lockHolds),
            lockSum: lockHolds.reduce((sum, held) => sum + held, 0),
            lockCount: lockHolds.length,
            stages: Object.fromEntries(stages),
            lockMaxLabel: lock.labels[lockHolds.indexOf(Math.max(...lockHolds))] ?? "",
            sumHeld: holds.reduce((s, h) => s + h.held, 0),
            sites: holds.map((h) => `${h.site}:${h.held.toFixed(2)}`),
        };
        rows.push(row);
        if (kind === "busting") {
            bustingHolds.push(row.lockMax);
            pairedHolds.push(Math.max(0, ...row.paired.map((hold) => hold.held)));
        }
        if (failed) throw failure;
        if (busted === undefined) throw new Error("Benchmark pass did not reach postprocess");
        if (kind === "busting")
            expect(holds.some((hold) => hold.site === "paired_thinking_edit")).toBe(true);
        return row;
    };
    try {
        // Optional setup-only batching avoids thousands of fsyncs while seeding
        // this private database. Measured passes always use production boundaries.
        const warm = async () => {
            if (process.env.HOLD_BULK_WARM === "1") {
                db.exec("BEGIN IMMEDIATE");
                try {
                    await pass("warm");
                    db.exec("COMMIT");
                } catch (error) {
                    db.exec("ROLLBACK");
                    throw error;
                }
            } else await pass("warm");
            const tags = getTagsBySession(db, sessionId);
            if (SEED_TAGS > 0) {
                if (tags.length > SEED_TAGS) throw new Error("Seed exceeds HOLD_TAGS");
                const insert = db.prepare(`INSERT INTO tags
                    (session_id, tag_number, message_id, type, status, byte_size)
                    VALUES (?, ?, ?, 'tool', 'dropped', 4000)`);
                const native = new Map<string, string>();
                let number = Math.max(0, ...tags.map((tag) => tag.tagNumber));
                db.transaction(() => {
                    for (let index = tags.length; index < SEED_TAGS; index++) {
                        const id = `historical-call-${index}`;
                        insert.run(sessionId, ++number, id);
                        native.set(id, NATIVE_TOOL_REMOVAL_MARKER);
                    }
                    // Existing saved native tool inputs make repeated document merges expensive;
                    // the measured lane must append to a realistic session history.
                    saveNativeToolInputs(db, sessionId, native);
                }).immediate();
            }
            seededTags = getTagsBySession(db, sessionId).length;
            if (SEED_TAGS > 0) expect(seededTags).toBe(SEED_TAGS);
        };
        let turn = 0;
        await measuredPassSchedule({
            passes: PASSES,
            warm,
            defer: async () => {
                tool();
                return pass("defer");
            },
            busting: async () => {
                const i = turn++;
                assistant([{ type: "text", text: `Finished ${i}.` }]);
                user(`Next task ${i}`);
                const old = getTagsBySession(db, sessionId)
                    .filter((tag) => tag.type === "tool" && tag.status === "active")
                    .slice(0, DROPS);
                if (old.length !== DROPS)
                    throw new Error("Benchmark ran out of active tools to drop");
                db.transaction(() => {
                    for (const tag of old) queuePendingOp(db, sessionId, tag.tagNumber, "drop");
                }).immediate();
                signalPiPendingMaterialization(sessionId);
                const row = await pass("busting");
                const dropped = new Set(
                    getTagsBySession(db, sessionId)
                        .filter((tag) => tag.status === "dropped")
                        .map((tag) => tag.tagNumber),
                );
                expect(old.every((tag) => dropped.has(tag.tagNumber))).toBe(true);
                tool();
                return row;
            },
        });
    } finally {
        spy.mockRestore();
        stageLog.mockRestore();
        clearContextHandlerSession(sessionId);
        db.close();
        const out = process.env.HOLD_OUT ?? join(dir, "rows.json");
        const summary = (samples: number[]) => {
            const sorted = [...samples].sort((a, b) => a - b);
            return {
                max: Math.max(...sorted),
                p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
                p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
                samples: sorted.length,
            };
        };
        const measurement = {
            seededTags,
            dropsPerLane: DROPS,
            connectionHoldMs: summary(bustingHolds),
            pairedHoldMs: summary(pairedHolds),
        };
        writeFileSync(out, JSON.stringify({ ...measurement, messages: messages.length, rows }));
        console.log(`HOLD_SUMMARY ${JSON.stringify(measurement)}`);
        console.log(`HOLD_ROWS ${out} messages=${messages.length} rows=${rows.length}`);
    }
    expect(rows.length).toBe(1 + 2 * PASSES);
}, 1_800_000);
