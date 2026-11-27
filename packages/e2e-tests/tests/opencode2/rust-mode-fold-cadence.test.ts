/// <reference types="bun-types" />

/**
 * What a fold buys a Rust-mode session on OpenCode 2, measured on the real host.
 *
 * Two facts meet here. The host decides to compact from the usage reported for
 * the request Magic Context actually served, so a fold that shrinks the served
 * array is what takes the host back below its own trigger. And this host's
 * `compaction` hook must be ANSWERED: leaving `result` unset is not a polite
 * decline, it makes the host summarize with its own model and, when that answer
 * is not in the template it requires, record `compaction.failed` and end the
 * turn. So the checkpoint the host stores has to be Magic Context's own
 * baseline, on every request, or the session either stalls or starts carrying a
 * summary of history the module never served.
 *
 * The mock therefore reports usage proportional to the bytes it received, the
 * way a provider does. A fixed usage number would keep the host above its
 * trigger for ever and make the cadence below unmeasurable.
 *
 * Its own file on purpose: each scenario boots a hermetic daemon, a module and a
 * GA host, and two such stacks in one Bun process do not both come up. The rust
 * lane already runs one file per fresh process for the same reason.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { driveHistorian } from "../../src/opencode2-runner/conversion-lane";
import { isolation, spawnOpencode2 } from "../../src/opencode2-runner/spawn";
import {
    buildHermeticBinaries,
    detectRustModePrereqs,
    HermeticSubcStack,
} from "../../src/rust-runner/hermetic-subc";

const prereqs = detectRustModePrereqs();

function field(body: string, name: string): string {
    return new RegExp(`\\b${name}=([^\\s]+)`).exec(body)?.[1] ?? "";
}

function logLines(logPath: string, marker: string): string[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes(marker))
        .map((line) => line.slice(line.indexOf(marker) + marker.length));
}

/** `rust pass: decision=… served_from=… in=N …` — one line per module pass. */
function readPasses(logPath: string): Array<{ decision: string; servedFrom: string }> {
    return logLines(logPath, "rust pass: ").map((body) => ({
        decision: field(body, "decision"),
        servedFrom: field(body, "served_from"),
    }));
}

/** `rust input coverage: oc_input=N marker_at=… covered=N` — the array handed to the module. */
function readCoverage(logPath: string): Array<{ ocInput: number; markerAt: string }> {
    return logLines(logPath, "rust input coverage: ").map((body) => ({
        ocInput: Number(field(body, "oc_input") || "0"),
        markerAt: field(body, "marker_at"),
    }));
}

/**
 * `v2 compaction hook: fired answered=… source=…` — one line per host request.
 *
 * The host's request rate and what Magic Context answered with are separate
 * facts, and only reading both explains a session's checkpoint cadence.
 */
function readHookFires(logPath: string): Array<{ answered: boolean; source: string }> {
    return logLines(logPath, "v2 compaction hook: ").map((body) => ({
        answered: field(body, "answered") === "true",
        source: field(body, "source"),
    }));
}

/**
 * The plugin buffers its diagnostic log and the host finishes a turn after the
 * prompt call returns, so a read taken straight after a loop of prompts can miss
 * most of it. Wait for the passes those turns produce before reading anything.
 */
async function waitForCoverage(logPath: string, atLeast: number): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (readCoverage(logPath).length < atLeast && Date.now() < deadline) {
        await Bun.sleep(250);
    }
}

/** Host checkpoints, read from the store the host actually wrote. */
function compactionRows(
    dbPath: string,
    sessionId: string,
): Array<{ seq: number; status: string; summary: string; error: string }> {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        db.exec("PRAGMA busy_timeout = 5000");
        return (
            db
                .prepare(
                    `SELECT seq, data FROM session_message
                      WHERE session_id = ? AND type = 'compaction' ORDER BY seq ASC`,
                )
                .all(sessionId) as Array<{ seq: number; data: string }>
        ).map((row) => {
            const data = JSON.parse(row.data) as {
                status?: string;
                summary?: string;
                error?: { message?: string };
            };
            return {
                seq: row.seq,
                status: String(data.status ?? ""),
                summary: String(data.summary ?? "").slice(0, 80),
                error: String(data.error?.message ?? ""),
            };
        });
    } finally {
        db.close();
    }
}

/** Turns whose outcome the host recorded as failed — a stalled session's fingerprint. */
function failedTurns(dbPath: string, sessionId: string): number {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        db.exec("PRAGMA busy_timeout = 5000");
        const row = db
            .prepare(
                `SELECT COUNT(*) AS count FROM session_message
                  WHERE session_id = ? AND type = 'idle'
                    AND json_extract(data, '$.outcome') = 'failed'`,
            )
            .get(sessionId) as { count: number };
        return row.count;
    } finally {
        db.close();
    }
}

/**
 * Real prose mass, because the module measures true content rather than the
 * usage the mock reports. Repeated filler does not work — the tokenizer collapses
 * it, so a turn that looks large on the page carries almost no true-raw mass.
 */
const BALLAST_WORDS = [
    "boundary", "historian", "compartment", "schedule", "pressure", "tokens",
    "window", "publish", "transform", "session", "marker", "budget", "eligible",
    "protected", "ordinal", "snapshot", "replay", "decision", "threshold",
];

function ballast(tokens: number): string {
    const target = tokens * 4;
    const parts: string[] = [];
    let length = 0;
    for (let index = 0; length < target; index += 1) {
        const word = BALLAST_WORDS[index % BALLAST_WORDS.length]!;
        parts.push(index % 17 === 0 ? `${word}.` : word);
        length += word.length + 1;
    }
    return parts.join(" ");
}

/**
 * Report usage for the bytes this request actually carried.
 *
 * The OpenCode 2 lane's mock speaks the OpenAI Responses API, which carries the
 * conversation in `input`. Four characters per token is the same rough ratio the
 * ballast above is built on; the exact number does not matter, only that it
 * tracks what was sent, because that is what makes the host's own compaction
 * trigger respond to a fold instead of ignoring it.
 */
function usageForBody(body: Record<string, unknown>): number {
    const wire = body.input ?? body.messages ?? [];
    return Math.round(JSON.stringify(wire).length / 4);
}

describe.skipIf(!prereqs.ok)(
    `rust mode on OpenCode 2: fold cadence${prereqs.ok ? "" : ` (skipped: ${prereqs.skipReason})`}`,
    () => {
        let host: Awaited<ReturnType<typeof spawnOpencode2>>;
        let subc: HermeticSubcStack;
        let logPath: string;
        let openCodeDbPath: string;
        /**
         * When set, the mock reports this usage whatever it was sent.
         *
         * That is how the second scenario holds the host above its own compaction
         * trigger: a provider's report normally falls when the served array does,
         * and a host that never falls back under its trigger is exactly the case
         * where the `compaction` hook has to answer on every request.
         */
        let forcedUsage: number | null = null;

        beforeAll(async () => {
            const fixture = isolation();
            logPath = join(fixture.env.XDG_DATA_HOME!, "magic-context-oc2-fold.log");
            fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
            openCodeDbPath = join(fixture.env.XDG_DATA_HOME!, "opencode", "opencode2.db");
            const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
            subc = await HermeticSubcStack.start({
                dataDir: fixture.env.XDG_DATA_HOME!,
                ckMcBin: binaries.ckMcBin,
                ckSubcBin: binaries.ckSubcBin,
                startProducer: true,
            });
            host = await spawnOpencode2({
                existingIsolation: fixture,
                // The fixed prompt plus protected 3k-turn tail estimates over 30k
                // even after a fold, so a 24k window can never admit this fixture's
                // boundary. Leave room for that floor without changing its pressure
                // trigger below. A 1k output also avoids a negative first-request ceiling.
                modelContextLimit: 40_000,
                modelOutputLimit: 1_024,
                // The historian gets its own 128k mock model: the 40k session window
                // cannot hold a historian prompt, and the module refuses one that
                // does not fit the historian model's window.
                historianModel: { id: "mock-historian", contextLimit: 128_000 },
                magicContextConfig: {
                    transform_mode: "rust",
                    subc: { connection_file: subc.connectionFile },
                    memory: { enabled: false },
                    dreamer: { disable: true },
                    // The historian model has to sit in the harness sub-block: the
                    // shared resolver reads `historian.<harness>`, and the v2 lane
                    // resolves with "opencode".
                    historian: { opencode: { model: "openai/mock-historian" } },
                    // About 9.4k usable tokens, matching the former 24k/40% trigger.
                    execute_threshold_percentage: 24,
                    history_budget_percentage: 0.15,
                },
            });
            host.mock.addMatcher((body) => ({
                text: "ok",
                usage: { input_tokens: forcedUsage ?? usageForBody(body), output_tokens: 20 },
            }));
        }, 900_000);

        afterAll(async () => {
            await host?.stop();
            await subc?.stop();
        });

        it("folds once and stops paying for the history it folded", async () => {
            const client = OpenCode.make({
                baseUrl: host.url,
                headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
            });
            const session = await client.session.create({
                location: { directory: host.cwd },
                model: { providerID: "openai", id: "mock-model" },
            });
            const prompt = async (text: string) => {
                await client.session.prompt({ sessionID: session.id, text });
                await client.session.wait(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(180_000) },
                );
            };
            const boundaryPublished = () =>
                readCoverage(logPath).some((entry) => entry.markerAt !== "none");

            // ── 1. drive real content until the module folds ─────────────────────
            // Each round is one ordinary turn carrying real prose; the loop just keeps
            // asking until the durable state the rest of this test depends on exists.
            const pressure = { text: "pressure", usage: { input_tokens: 20_000, output_tokens: 20 } };
            await driveHistorian({
                prompt,
                mock: host.mock,
                // The matcher registered in beforeAll answers first, so these two are
                // only the fallback; the usage on the wire stays proportional either way.
                pressure,
                quiet: pressure,
                label: "a module boundary",
                satisfied: boundaryPublished,
                rounds: 24,
                settleMs: 6_000,
                text: (round) =>
                    `turn ${round + 1}: durable signal for chunk ${round + 1}. ${ballast(3_000)}`,
            });
            expect(boundaryPublished()).toBe(true);

            const afterFold = compactionRows(openCodeDbPath, session.id);
            const foldFires = readHookFires(logPath).length;
            const foldCoverage = readCoverage(logPath).length;
            console.log(`after the fold: compaction rows=${JSON.stringify(afterFold)}`);
            // Whatever the host wrote is a completed checkpoint carrying Magic
            // Context's baseline. A request this hook failed to answer shows up here
            // as `status: failed` with "Compaction summary did not match the required
            // template", which is what this assertion exists to catch.
            expect(afterFold.filter((row) => row.status !== "completed")).toEqual([]);
            for (const row of afterFold) expect(row.summary).toContain("<session-history>");
            expect(failedTurns(openCodeDbPath, session.id)).toBe(0);

            // ── 2. keep the conversation going and watch the window, not the tail ──
            // Content turns, because the boundary only moves when the historian has
            // something to publish. What the trim claims is not that the array never
            // changes size, but that it is a WINDOW behind the boundary rather than
            // the whole conversation: a session that keeps talking keeps paying for
            // the tail, never again for the head.
            const boundariesSeen = () =>
                new Set(
                    readCoverage(logPath)
                        .map((entry) => entry.markerAt)
                        .filter((marker) => marker !== "none"),
                );
            await driveHistorian({
                prompt,
                mock: host.mock,
                pressure,
                quiet: pressure,
                label: "three module boundaries and eight more passes",
                satisfied: () =>
                    boundariesSeen().size >= 3 &&
                    readCoverage(logPath).length >= foldCoverage + 8,
                rounds: 20,
                settleMs: 6_000,
                text: (round) =>
                    `later turn ${round + 1}: durable signal for later chunk ${round + 1}. ${ballast(3_000)}`,
            });
            await waitForCoverage(logPath, foldCoverage + 1);

            const laterFires = readHookFires(logPath).slice(foldFires);
            const coverage = readCoverage(logPath);
            const afterLater = compactionRows(openCodeDbPath, session.id);
            console.log(
                `later phase: ${coverage.length - foldCoverage} module passes, ${laterFires.length} host compaction requests`,
            );
            console.log(
                `oc_input per pass: ${coverage.map((entry) => `${entry.ocInput}@${entry.markerAt.slice(-6)}`).join(" ")}`,
            );
            console.log(`compaction rows=${JSON.stringify(afterLater)}`);

            // The boundary advanced more than once, so what follows measures a moving
            // window rather than one stale id.
            expect(boundariesSeen().size).toBeGreaterThanOrEqual(3);
            // Each turn adds a user row and an assistant row, so an untrimmed array
            // would carry about two more on every pass. That is the number the trim
            // has to beat.
            const untrimmed = 2 * coverage.length - 1;
            const finalOcInput = coverage[coverage.length - 1]!.ocInput;
            console.log(`final oc_input ${finalOcInput} vs untrimmed equivalent ${untrimmed}`);
            expect(finalOcInput).toBeLessThan(untrimmed * 0.8);
            // The adapter's own trim is what produced it: this line is written only
            // when messages are actually dropped, so a smaller number reached some
            // other way cannot satisfy it.
            const dropped = logLines(logPath, "v2 boundary trim: dropped ").map((line) =>
                Number(line.split(" ")[0]),
            );
            console.log(`adapter trim drops: ${dropped.join(" ")}`);
            // The boundary is recorded during the pass that publishes it and read at
            // the START of a pass, so every pass after the first one that had a
            // boundary is a pass the trim ran on.
            const passesWithBoundary = coverage.filter((entry) => entry.markerAt !== "none").length;
            expect(dropped.length).toBeGreaterThanOrEqual(passesWithBoundary - 1);
            // …and it drops more as the boundary advances, which is the difference
            // between a live boundary and one recorded once and never moved.
            expect(Math.max(...dropped)).toBeGreaterThan(dropped[0]!);
            // Whatever the host wrote is still a completed checkpoint, and no turn
            // died on an unanswered request.
            expect(afterLater.filter((row) => row.status !== "completed")).toEqual([]);
            expect(failedTurns(openCodeDbPath, session.id)).toBe(0);
            // The module was serving throughout; a run that fell back to the
            // TypeScript transform would satisfy the counts above for free.
            expect(readPasses(logPath).some((pass) => pass.servedFrom === "transform")).toBe(true);
        }, 1_800_000);

        it("answers every host checkpoint request, so a session above the host's trigger keeps running", async () => {
            // A provider whose report never falls, plus turns big enough that the
            // next request would not fit under what it reported: the host compacts
            // before every one of them. This is the case that decides whether an
            // unanswered request is survivable, and on GA 2.0.5 it is not — the host
            // summarizes with its own model, rejects the answer as "Compaction
            // summary did not match the required template", and ends the turn with
            // idle outcome=failed.
            // Keep the same above-trigger report under the fixture's larger window.
            forcedUsage = 36_000;
            const client = OpenCode.make({
                baseUrl: host.url,
                headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
            });
            const session = await client.session.create({
                location: { directory: host.cwd },
                model: { providerID: "openai", id: "mock-model" },
            });
            const before = readHookFires(logPath).length;
            const beforeCoverage = readCoverage(logPath).length;
            for (let turn = 1; turn <= 8; turn += 1) {
                await client.session.prompt({
                    sessionID: session.id,
                    text: `pressured turn ${turn}. ${ballast(3_000)}`,
                });
                await client.session.wait(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(180_000) },
                );
            }
            await waitForCoverage(logPath, beforeCoverage + 8);

            const fires = readHookFires(logPath).slice(before);
            const rows = compactionRows(openCodeDbPath, session.id);
            console.log(
                `host asked ${fires.length} times; sources: ${fires.map((fire) => fire.source).join(" ")}`,
            );
            console.log(`checkpoint rows=${JSON.stringify(rows)}`);
            // The host really did ask. Without this the assertions below would hold
            // for a session the hook never ran on.
            expect(fires.length).toBeGreaterThan(2);
            expect(fires.filter((fire) => !fire.answered)).toEqual([]);
            // Answered from the module's own baseline, not a host-composed summary of
            // history the module never served.
            expect(fires.filter((fire) => fire.source === "module").length).toBeGreaterThan(1);
            expect(rows.filter((row) => row.status !== "completed")).toEqual([]);
            // Every turn completed: the session kept running under a host that never
            // stopped asking.
            expect(failedTurns(openCodeDbPath, session.id)).toBe(0);
        }, 1_800_000);
    },
);
