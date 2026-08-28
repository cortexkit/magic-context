import { afterEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";

import {
    casChannel2NudgeState,
    closeDatabase,
    getChannel2NudgeClaimedAt,
    getChannel2NudgeState,
    openDatabase,
    setChannel2NudgeState,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { Database } from "../../shared/sqlite";
import {
    rearmChannel2AfterCoverageAdvancingHardFold,
    rearmChannel2AfterMeasuredCollapse,
} from "./channel2-cycle";
import { maybeDeliverChannel2 } from "./channel2-delivery";
import { closeReadOnlySessionDb } from "./read-session-db";

const openCodeDbs: Database[] = [];
const originalTestDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;

function useTempDataHome(prefix: string): void {
    const { mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const dir = mkdtempSync(join(tmpdir(), prefix));
    process.env.XDG_DATA_HOME = dir;
    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = dir;
}

function createOpenCodeAssistantTail(sessionId: string, finish: string): Database {
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(process.env.XDG_DATA_HOME!, "opencode"), { recursive: true });
    const db = new Database(join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db"));
    db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run("assistant-report", sessionId, 100, 100, JSON.stringify({ role: "assistant", finish }));
    openCodeDbs.push(db);
    return db;
}

afterEach(() => {
    for (const db of openCodeDbs.splice(0)) {
        db.close();
    }
    closeReadOnlySessionDb();
    closeDatabase();
    mock.restore();
    if (originalTestDataDir === undefined) delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    else process.env.MAGIC_CONTEXT_TEST_DATA_DIR = originalTestDataDir;
});

/**
 * A minimal stand-in for the in-process client OpenCode hands the plugin
 * (`input.client`). `promptAsync` is the delivery primitive; `messages` backs
 * resolvePromptContext (empty by default).
 */
function fakeClient(
    promptAsync: (input: unknown) => Promise<unknown>,
    messages: () => Promise<unknown> = async () => ({ data: [] }),
) {
    return { session: { promptAsync, messages } };
}

function channel2Baseline(
    baselineU: number,
    baselineT: number,
    overrides: Partial<{
        turnDeltaU: number;
        turnDeltaT: number;
        usableWindow: number;
        evaluable: boolean;
        generationInvalidated: boolean;
    }> = {},
) {
    return {
        baselineU,
        baselineT,
        turnDeltaU: 0,
        turnDeltaT: 0,
        usableWindow: 128_000,
        evaluable: true,
        generationInvalidated: false,
        ...overrides,
    };
}

describe("maybeDeliverChannel2", () => {
    it("no-ops when no pending intent exists", async () => {
        useTempDataHome("ch2-noop-");
        const db = openDatabase()!;
        const delivered = await maybeDeliverChannel2("ses-noop", {
            db,
            client: fakeClient(async () => ({})),
        });
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-noop")).toBe("");
    });

    it("no-ops (keeps pending) when no client is wired", async () => {
        useTempDataHome("ch2-noclient-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-noclient", "pending");
        const delivered = await maybeDeliverChannel2("ses-noclient", {
            db,
            // No client (e.g. a context with no client available).
            baseline: channel2Baseline(75_000, 100_000),
        });
        expect(delivered).toBe(false);
        // Intent stays pending: delivery is simply unavailable, not consumed.
        expect(getChannel2NudgeState(db, "ses-noclient")).toBe("pending");
    });

    it("does NOT deliver and leaves pending when the baseline is unknown", async () => {
        useTempDataHome("ch2-unknown-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-unknown", "pending");
        const delivered = await maybeDeliverChannel2("ses-unknown", {
            db,
            client: fakeClient(async () => ({})),
            // No rendered-tail U/T measurement at this event.
        });
        // An unknown baseline must neither consume the cycle cap nor cancel the
        // intent; a later final-stop with a real measurement decides.
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-unknown")).toBe("pending");
    });

    it("cancels (re-armable) when the full trigger predicate no longer holds", async () => {
        useTempDataHome("ch2-stale-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-stale", "pending");
        // The absolute floor still holds, but severity is only 0.50. Revalidation
        // must apply the same fourth-band predicate that armed the intent.
        const delivered = await maybeDeliverChannel2("ses-stale", {
            db,
            client: fakeClient(async () => ({})),
            baseline: channel2Baseline(50_000, 100_000),
        });
        expect(delivered).toBe(false);
        // Cancelled to '' (re-armable), NOT 'delivered' — cap preserved.
        expect(getChannel2NudgeState(db, "ses-stale")).toBe("");
    });

    it("holds pending when the persisted baseline generation was invalidated", async () => {
        useTempDataHome("ch2-invalidated-");
        const db = openDatabase()!;
        const sessionId = "ses-invalidated";
        setChannel2NudgeState(db, sessionId, "pending");
        const promptAsync = mock(async () => ({}));

        const delivered = await maybeDeliverChannel2(sessionId, {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(70_000, 100_000, {
                evaluable: false,
                generationInvalidated: true,
            }),
        });

        expect(delivered).toBe(false);
        expect(promptAsync).not.toHaveBeenCalled();
        expect(getChannel2NudgeState(db, sessionId)).toBe("pending");
    });

    it("boot-reaps only ten-minute claimed leases, not fresh live claims", () => {
        useTempDataHome("ch2-ttl-heal-");
        let db = openDatabase()!;
        setChannel2NudgeState(db, "ses-fresh-claim", "claimed");
        setChannel2NudgeState(db, "ses-stale-claim", "claimed");
        const ageClaim = db.prepare(
            "UPDATE session_meta SET channel2_nudge_claimed_at = ? WHERE session_id = ?",
        );
        ageClaim.run(Date.now() - 9 * 60_000, "ses-fresh-claim");
        ageClaim.run(Date.now() - 11 * 60_000, "ses-stale-claim");

        closeDatabase();
        db = openDatabase()!;

        expect(getChannel2NudgeState(db, "ses-fresh-claim")).toBe("claimed");
        expect(getChannel2NudgeClaimedAt(db, "ses-fresh-claim")).toBeGreaterThan(0);
        expect(getChannel2NudgeState(db, "ses-stale-claim")).toBe("");
        expect(getChannel2NudgeClaimedAt(db, "ses-stale-claim")).toBe(0);
    });

    it("cache-hit openDatabase heals stale claimed leases for long-lived processes", () => {
        useTempDataHome("ch2-cache-heal-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-cache-heal", "claimed");
        db.prepare(
            "UPDATE session_meta SET channel2_nudge_claimed_at = ? WHERE session_id = ?",
        ).run(Date.now() - 11 * 60_000, "ses-cache-heal");

        const cached = openDatabase()!;

        expect(cached).toBe(db);
        expect(getChannel2NudgeState(db, "ses-cache-heal")).toBe("");
        expect(getChannel2NudgeClaimedAt(db, "ses-cache-heal")).toBe(0);
    });

    it("delivers to a subagent while its run is still active", async () => {
        useTempDataHome("ch2-subagent-active-");
        const db = openDatabase()!;
        const sessionId = "ses-subagent-active";
        createOpenCodeAssistantTail(sessionId, "tool-calls");
        updateSessionMeta(db, sessionId, { isSubagent: true });
        setChannel2NudgeState(db, sessionId, "pending");
        const promptAsync = mock(async () => ({}));

        const delivered = await maybeDeliverChannel2(sessionId, {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(delivered).toBe(true);
        expect(promptAsync).toHaveBeenCalledTimes(1);
        expect(getChannel2NudgeState(db, sessionId)).toBe("delivered");
    });

    it("does not wake a completed subagent or replace its final report", async () => {
        useTempDataHome("ch2-subagent-completed-");
        const db = openDatabase()!;
        const sessionId = "ses-subagent-completed";
        createOpenCodeAssistantTail(sessionId, "stop");
        updateSessionMeta(db, sessionId, { isSubagent: true });
        setChannel2NudgeState(db, sessionId, "pending");
        const messages = ["subagent report"];
        const promptAsync = mock(async () => {
            messages.push("unexpected synthetic turn");
        });

        const delivered = await maybeDeliverChannel2(sessionId, {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(delivered).toBe(false);
        expect(promptAsync).not.toHaveBeenCalled();
        expect(messages).toEqual(["subagent report"]);
        expect(getChannel2NudgeState(db, sessionId)).toBe("");
    });

    it("releases a claim when a subagent completes before the queued delivery", async () => {
        useTempDataHome("ch2-subagent-race-");
        const db = openDatabase()!;
        const sessionId = "ses-subagent-race";
        const openCodeDb = createOpenCodeAssistantTail(sessionId, "tool-calls");
        updateSessionMeta(db, sessionId, { isSubagent: true });
        setChannel2NudgeState(db, sessionId, "pending");
        const promptAsync = mock(async () => ({}));
        const client = fakeClient(promptAsync, async () => {
            // resolvePromptContext yields between claim and promptAsync. This
            // models the child writing its terminal report during that window.
            expect(getChannel2NudgeState(db, sessionId)).toBe("claimed");
            openCodeDb
                .prepare("UPDATE message SET data = ? WHERE id = ?")
                .run(JSON.stringify({ role: "assistant", finish: "stop" }), "assistant-report");
            return { data: [] };
        });

        const delivered = await maybeDeliverChannel2(sessionId, {
            db,
            client,
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(delivered).toBe(false);
        expect(promptAsync).not.toHaveBeenCalled();
        expect(getChannel2NudgeState(db, sessionId)).toBe("");
    });

    it("delivers via the in-process client and consumes the current cycle", async () => {
        useTempDataHome("ch2-deliver-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-go", "pending");

        const promptAsync = mock(async () => ({}));
        const delivered = await maybeDeliverChannel2("ses-go", {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(delivered).toBe(true);
        expect(promptAsync).toHaveBeenCalledTimes(1);
        const callArg = promptAsync.mock.calls[0]![0] as {
            path: { id: string };
            body: { noReply: boolean; parts: Array<{ text: string; synthetic?: boolean }> };
        };
        expect(callArg.path.id).toBe("ses-go");
        expect(callArg.body.noReply).toBe(false);
        expect(callArg.body.parts[0]!.text).toContain("<system-reminder>");
        expect(callArg.body.parts[0]!.text).toContain("ctx_reduce");
        // synthetic: true — skips OpenCode's queued-message wrapper (issue #129
        // flip-bust) + TUI render, while still driving the run loop + model. Must
        // NOT be ignored (that would strip it from the model).
        expect(callArg.body.parts[0]!.synthetic).toBe(true);
        expect((callArg.body.parts[0] as { ignored?: boolean }).ignored).not.toBe(true);
        // One-shot cap consumed.
        expect(getChannel2NudgeState(db, "ses-go")).toBe("delivered");
    });

    it("treats a lost post-send confirm CAS as unconfirmed without reverting to pending", async () => {
        useTempDataHome("ch2-confirm-lost-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-confirm-lost", "pending");

        const promptAsync = mock(async () => {
            // Simulate a sibling process consuming/cancelling the claim after the
            // send returns but before this process can confirm claimed→delivered.
            setChannel2NudgeState(db, "ses-confirm-lost", "");
        });
        const delivered = await maybeDeliverChannel2("ses-confirm-lost", {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(promptAsync).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, "ses-confirm-lost")).toBe("");
    });

    it("preserves a sibling's delivered claim when token confirmation is no longer ours", async () => {
        useTempDataHome("ch2-duplicate-window-");
        const db = openDatabase()!;
        const sessionId = "ses-duplicate-window";
        setChannel2NudgeState(db, sessionId, "pending");

        const sessionLog = mock(() => {});
        const promptAsync = mock(async () => {
            db.prepare(
                "UPDATE session_meta SET channel2_nudge_state = 'delivered', channel2_nudge_claimed_at = 0 WHERE session_id = ?",
            ).run(sessionId);
        });
        mock.module("../../shared/logger", () => ({ sessionLog }));

        const { maybeDeliverChannel2: deliver } = await import("./channel2-delivery");
        const delivered = await deliver(sessionId, {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(promptAsync).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("delivered");
        expect(
            sessionLog.mock.calls.some(
                (call) =>
                    call[0] === sessionId &&
                    typeof call[1] === "string" &&
                    call[1].includes("confirmation was not ours"),
            ),
        ).toBe(true);
    });

    it("does not stale-confirm when a healed mid-send claim is re-delivered elsewhere", async () => {
        useTempDataHome("ch2-healed-mid-send-");
        const db = openDatabase()!;
        const sessionId = "ses-healed-mid-send";
        setChannel2NudgeState(db, sessionId, "pending");

        const secondPromptAsync = mock(async () => ({}));
        const firstPromptAsync = mock(async () => {
            // Simulate boot healing a stale claim while the original promptAsync is
            // still in flight, then a sibling process delivering the rewound intent.
            db.prepare(
                "UPDATE session_meta SET channel2_nudge_state = 'pending', channel2_nudge_claimed_at = 0, channel2_nudge_claim_token = '' WHERE session_id = ?",
            ).run(sessionId);
            const secondDelivered = await maybeDeliverChannel2(sessionId, {
                db,
                client: fakeClient(secondPromptAsync),
                baseline: channel2Baseline(75_000, 100_000),
            });
            expect(secondDelivered).toBe(true);
        });

        const delivered = await maybeDeliverChannel2(sessionId, {
            db,
            client: fakeClient(firstPromptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(firstPromptAsync).toHaveBeenCalledTimes(1);
        expect(secondPromptAsync).toHaveBeenCalledTimes(1);
        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("delivered");
    });

    it("leaves a stale claim healable when claimed→pending CAS throws on send failure", async () => {
        useTempDataHome("ch2-revert-throw-");
        const db = openDatabase()!;
        const sessionId = "ses-revert-throw";
        setChannel2NudgeState(db, sessionId, "pending");

        const originalPrepare = db.prepare.bind(db);
        (db as unknown as { prepare: typeof db.prepare }).prepare = (sql: string) => {
            const statement = originalPrepare(sql);
            if (
                sql ===
                "UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = ? WHERE session_id = ? AND channel2_nudge_state = 'claimed' AND channel2_nudge_claim_token = ?"
            ) {
                return {
                    ...statement,
                    run: (...args: unknown[]) => {
                        if (
                            args[0] === "pending" &&
                            args[1] === 0 &&
                            args[2] === "" &&
                            args[3] === sessionId
                        ) {
                            throw new Error("SQLITE_BUSY: database is locked");
                        }
                        return statement.run(
                            ...(args as [unknown, unknown, unknown, unknown, unknown]),
                        );
                    },
                } as typeof statement;
            }
            return statement;
        };
        const promptAsync = mock(async () => {
            throw new Error("transient network failure");
        });

        const { maybeDeliverChannel2: deliver } = await import("./channel2-delivery");
        const delivered = await deliver(sessionId, {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(delivered).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("claimed");
        expect(getChannel2NudgeClaimedAt(db, sessionId)).toBeGreaterThan(0);

        db.prepare(
            "UPDATE session_meta SET channel2_nudge_claimed_at = ? WHERE session_id = ?",
        ).run(Date.now() - 11 * 60_000, sessionId);

        const cached = openDatabase()!;
        expect(cached).toBe(db);
        expect(getChannel2NudgeState(db, sessionId)).toBe("");
        expect(getChannel2NudgeClaimedAt(db, sessionId)).toBe(0);
    });

    it("reverts claimed→pending on send failure (cap not burned)", async () => {
        useTempDataHome("ch2-fail-");
        const db = openDatabase()!;
        setChannel2NudgeState(db, "ses-fail", "pending");

        const promptAsync = mock(async () => {
            throw new Error("transient network failure");
        });
        const delivered = await maybeDeliverChannel2("ses-fail", {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        });

        expect(delivered).toBe(false);
        // Reverted to pending so a later event retries — the single nudge isn't lost.
        expect(getChannel2NudgeState(db, "ses-fail")).toBe("pending");
    });

    it("re-arms only when a HARD fold advances m0 coverage", () => {
        useTempDataHome("ch2-fold-cycle-");
        const db = openDatabase()!;
        const sessionId = "ses-fold-cycle";
        setChannel2NudgeState(db, sessionId, "delivered");

        // A marker-only/SOFT coverage advance does not reset the delivered cap.
        expect(
            rearmChannel2AfterCoverageAdvancingHardFold({
                db,
                sessionId,
                foldExecuted: false,
                compactionOff: false,
                previousCoverage: 1,
                currentCoverage: 2,
            }),
        ).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("delivered");
        // A HARD pass with no new m0 coverage also leaves the cycle consumed.
        expect(
            rearmChannel2AfterCoverageAdvancingHardFold({
                db,
                sessionId,
                foldExecuted: true,
                compactionOff: false,
                previousCoverage: 2,
                currentCoverage: 2,
            }),
        ).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("delivered");
        expect(
            rearmChannel2AfterCoverageAdvancingHardFold({
                db,
                sessionId,
                foldExecuted: true,
                compactionOff: false,
                previousCoverage: 2,
                currentCoverage: 3,
            }),
        ).toBe(true);
        expect(getChannel2NudgeState(db, sessionId)).toBe("");

        setChannel2NudgeState(db, sessionId, "claimed");
        expect(
            rearmChannel2AfterCoverageAdvancingHardFold({
                db,
                sessionId,
                foldExecuted: true,
                compactionOff: false,
                previousCoverage: 3,
                currentCoverage: 4,
            }),
        ).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("claimed");
    });

    it("threshold crossings without a fold and SOFT passes do not re-arm", () => {
        useTempDataHome("ch2-no-fold-cycle-");
        const db = openDatabase()!;
        const sessionId = "ses-no-fold-cycle";
        setChannel2NudgeState(db, sessionId, "delivered");

        expect(casChannel2NudgeState(db, sessionId, "", "pending")).toBe(false);
        expect(
            rearmChannel2AfterCoverageAdvancingHardFold({
                db,
                sessionId,
                foldExecuted: false,
                compactionOff: false,
                previousCoverage: 3,
                currentCoverage: 3,
            }),
        ).toBe(false);
        expect(getChannel2NudgeState(db, sessionId)).toBe("delivered");
    });

    it("a hover fixture delivers exactly once", async () => {
        useTempDataHome("ch2-hover-");
        const db = openDatabase()!;
        const sessionId = "ses-hover";
        setChannel2NudgeState(db, sessionId, "pending");
        const promptAsync = mock(async () => ({}));
        const deps = {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        };

        expect(await maybeDeliverChannel2(sessionId, deps)).toBe(true);
        expect(casChannel2NudgeState(db, sessionId, "", "pending")).toBe(false);
        expect(await maybeDeliverChannel2(sessionId, deps)).toBe(false);
        expect(await maybeDeliverChannel2(sessionId, deps)).toBe(false);
        expect(promptAsync).toHaveBeenCalledTimes(1);
    });

    it("a two-cycle fixture delivers twice", async () => {
        useTempDataHome("ch2-two-cycle-");
        const db = openDatabase()!;
        const sessionId = "ses-two-cycle";
        setChannel2NudgeState(db, sessionId, "pending");
        const promptAsync = mock(async () => ({}));
        const deps = {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        };

        expect(await maybeDeliverChannel2(sessionId, deps)).toBe(true);
        expect(
            rearmChannel2AfterCoverageAdvancingHardFold({
                db,
                sessionId,
                foldExecuted: true,
                compactionOff: false,
                previousCoverage: 3,
                currentCoverage: 4,
            }),
        ).toBe(true);
        expect(casChannel2NudgeState(db, sessionId, "", "pending")).toBe(true);
        expect(await maybeDeliverChannel2(sessionId, deps)).toBe(true);
        expect(promptAsync).toHaveBeenCalledTimes(2);
    });

    it("a reduce-then-relapse fixture delivers twice", async () => {
        useTempDataHome("ch2-reduce-relapse-");
        const db = openDatabase()!;
        const sessionId = "ses-reduce-relapse";
        setChannel2NudgeState(db, sessionId, "pending");
        const promptAsync = mock(async () => ({}));
        const deps = {
            db,
            client: fakeClient(promptAsync),
            baseline: channel2Baseline(75_000, 100_000),
        };

        expect(await maybeDeliverChannel2(sessionId, deps)).toBe(true);
        expect(
            rearmChannel2AfterMeasuredCollapse({
                db,
                sessionId,
                baseline: channel2Baseline(24_999, 80_000),
            }),
        ).toBe(true);
        expect(casChannel2NudgeState(db, sessionId, "", "pending")).toBe(true);
        expect(await maybeDeliverChannel2(sessionId, deps)).toBe(true);
        expect(promptAsync).toHaveBeenCalledTimes(2);
    });
});
