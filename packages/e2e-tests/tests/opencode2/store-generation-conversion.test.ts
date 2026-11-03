import { openTestDb } from "../../src/test-db";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OpenCode } from "@opencode/client";
import { readRawSessionMessagesFromDb } from "../../../plugin/src/hooks/magic-context/read-session-raw";
import { Database } from "../../../plugin/src/shared/sqlite";
import { rawMessages } from "../../../plugin/src/v2/hooks/store";
import { V2StoreReader } from "../../../plugin/src/v2/store-reader";
import { buildMockHistorianPayload } from "../../src/mock-historian";
import { MockProvider } from "../../src/mock-provider/server";
import { markerWorkerBundleFixture } from "../../src/marker-worker-bundle-fixture";
import {
    conversionFixture,
    type ConversionFixture,
    driveHistorian as drivePressureTurns,
    type PromptDriver,
    SHARED_MOCK_MODEL_ID,
    SHARED_MOCK_PROVIDER_ID,
    spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

/**
 * Issue 492 finding 1, conversion in the loop.
 *
 * The generation-keyed coordinate rebase is driven here by the two real hosts
 * rather than by rows captured from an earlier conversion: OpenCode 1.18.x writes
 * a session with the plugin loaded, OpenCode 2.0.5 opens the same data root and
 * converts the store, and 1.18.x then opens it again. Each flip is a live plugin
 * lifecycle — prompts, a historian publication, tool calls, an index and a queued
 * reduction — so the rebase runs against the projection a host actually serves.
 *
 * The fixture is arranged so the conversion's synthetic-split arm lands inside a
 * published compartment. A 1.x user turn that carries an ordinary text part AND a
 * synthetic one becomes two rows in the 2.x projection, which pushes every later
 * message up by one; a compartment that ends after that turn therefore has to be
 * re-derived from its endpoint id or it silently names the wrong message.
 */

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";
const REBASE_LOG_MARKER = "store-generation-rebase";
const CLI_ENTRY = resolve(import.meta.dir, "../../../cli/src/index.ts");

/** Every string value anywhere in a captured provider body, in traversal order. */
function allStrings(value: unknown, sink: string[] = []): string[] {
    if (typeof value === "string") sink.push(value);
    else if (Array.isArray(value)) for (const item of value) allStrings(item, sink);
    else if (value && typeof value === "object") {
        for (const item of Object.values(value)) allStrings(item, sink);
    }
    return sink;
}

/**
 * Historian requests are told apart by their own system prompt, not by model:
 * both generations route the historian at the same mock model the main agent
 * uses, and the two hosts carry the system prompt in different fields
 * (`system` on the 1.x Anthropic body, `instructions` on the 2.x OpenAI body).
 */
function isHistorianRequest(body: Record<string, unknown>): boolean {
    return allStrings(body.system).concat(allStrings(body.instructions)).some((text) =>
        text.includes(HISTORIAN_SYSTEM_MARKER),
    );
}

function historianOrdinalRange(
    body: Record<string, unknown>,
): { start: number; end: number } | null {
    for (const text of allStrings(body)) {
        if (!text.includes("<new_messages>")) continue;
        const ordinals = [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
        if (ordinals.length === 0) continue;
        return { start: Math.min(...ordinals), end: Math.max(...ordinals) };
    }
    return null;
}

/**
 * The injected head, m[0], as each host puts it on the wire: the first user
 * message's text on the 1.x Anthropic body, the first input item's text on the
 * 2.x OpenAI body.
 */
function headText(body: Record<string, unknown>): string {
    const container = Array.isArray(body.messages) ? body.messages : body.input;
    if (!Array.isArray(container) || container.length === 0) return "";
    const content = (container[0] as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((part) =>
            part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
        )
        .join("");
}

function systemText(body: Record<string, unknown>): string {
    return allStrings(body.system).concat(allStrings(body.instructions)).join("\n");
}

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface Evidence {
    fixture: ConversionFixture;
    sessionId: string;
    /** The 1.x user turn that carried both an ordinary and a synthetic text part. */
    splitMessageId: string;
    /** The row 2.0.5 derived from that turn; absent from the 1.x tables by construction. */
    syntheticRowId: string;
    v1MaxCompartmentSequence: number;
    longArmBaselineCompartmentSequence: number;
    postFlipCompartmentSequence: number;
    syntheticGapOrdinal: number;
    tailCacheCoveredFromOrdinal: number;
    tailCacheCoveredToOrdinalBeforePressure: number;
    longArmHistorianRequestCount: number;
    existingValidationFailureLines: string[];
    forward: FlipEvidence;
    /**
     * One entry per rebuild of the cached m[0]/m[1] head that the 2.x boot logged
     * through its fifth transform pass, in order. Two log lines count: the
     * OpenCode 2 compaction-fold owner's rebuild (`HARD reason=...`) and an
     * executed transform fold (`m[0] HARD fold decision: reason=... executed=true`).
     */
    forwardRebuilds: string[];
    back: FlipEvidence;
    doctorBetween: string;
    doctorAfter: string;
    expandRefusal: string;
    unresolvedHeading: string;
    resolvedHeading: string;
    servedHeadBack: string;
    markerBoundaryId: string;
    markerCreated: number;
    markerCompleted: number;
    /** The compartment whose start anchor is the marker boundary the conversion removes. */
    boundaryCompartmentSequence: number;
    convertedMarkerCount: number;
    firstConvertedInput: string;
    preBoundarySentinel: string;
    postBoundarySentinel: string;
}

interface FlipEvidence {
    rebaseLines: string[];
    generation: string | null;
    compartments: Array<{
        sequence: number;
        startMessage: number;
        endMessage: number;
        startMessageId: string | null;
        endMessageId: string | null;
        rebaseStatus: string;
    }>;
    projection: Array<{ id: string; ordinal: number }>;
    ftsRows: Array<{ ordinal: number; messageId: string }>;
    folds: Array<{ rematerialized: boolean; reason: string }>;
    pins: string[];
}

let evidence: Evidence;
const cleanup: Array<() => Promise<void>> = [];

function contextRows<T>(fixture: ConversionFixture, sql: string, ...params: unknown[]): T[] {
    const db = openTestDb(fixture.contextDbPath, { readonly: true, fileMustExist: true }, Database);
    try {
        return db.prepare(sql).all(...params) as T[];
    } finally {
        db.close();
    }
}

function rebaseLinesFor(fixture: ConversionFixture, label: string, sessionId: string): string[] {
    const path = fixture.logPath(label);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.includes(REBASE_LOG_MARKER) && line.includes(sessionId));
}

/** The plugin logger's timer flush interval (`FLUSH_INTERVAL_MS` in shared/logger.ts). */
const PLUGIN_LOG_FLUSH_INTERVAL_MS = 500;

/**
 * The rebase lines a boot logged during the turn that just returned.
 *
 * The plugin buffers log lines: the first buffered line arms a 500 ms flush
 * timer, and only 50 pending lines flush at once. The transform pass that runs
 * the rebase logs fewer than 50 lines after it, so the rebase line written
 * during the turn just awaited can still be in the host's buffer when the turn
 * returns, and reading the file once at that moment sees nothing. Waiting one
 * full flush interval past the end of the turn reads every line logged during
 * it, a second rebase included, so the exactly-one assertions still catch a
 * duplicate.
 */
async function settledRebaseLinesFor(
    fixture: ConversionFixture,
    label: string,
    sessionId: string,
): Promise<string[]> {
    const settledAt = Date.now() + PLUGIN_LOG_FLUSH_INTERVAL_MS + 100;
    // A busy host can fire its flush timer late; give up after a bounded wait
    // and let the assertions report what was found.
    const deadline = Date.now() + 5_000;
    for (;;) {
        const lines = rebaseLinesFor(fixture, label, sessionId);
        const now = Date.now();
        if ((lines.length > 0 && now >= settledAt) || now >= deadline) return lines;
        await Bun.sleep(100);
    }
}

function readCompartments(fixture: ConversionFixture, sessionId: string) {
    return contextRows<{
        sequence: number;
        startMessage: number;
        endMessage: number;
        startMessageId: string | null;
        endMessageId: string | null;
        rebaseStatus: string;
    }>(
        fixture,
        `SELECT sequence, start_message AS startMessage, end_message AS endMessage,
                start_message_id AS startMessageId, end_message_id AS endMessageId,
                rebase_status AS rebaseStatus
           FROM compartments WHERE session_id = ? ORDER BY sequence`,
        sessionId,
    );
}

function placeSyntheticSplitBetweenCompartments(
    fixture: ConversionFixture,
    sessionId: string,
    splitMessageId: string,
): void {
    const projection = v1Projection(fixture, sessionId);
    const split = projection.find((message) => message.id === splitMessageId);
    const next = projection.find((message) => message.ordinal === (split?.ordinal ?? 0) + 1);
    if (!split || !next) throw new Error("the synthetic split source has no following v1 message");

    const db = openTestDb(fixture.contextDbPath, undefined, Database);
    try {
        // The OpenCode 1 host is still running and writes tags and session state
        // to this database after each turn, so wait for its short write
        // transactions instead of failing on the first lock.
        db.exec("PRAGMA busy_timeout = 30000");
        const rows = db
            .prepare(
                `SELECT id, sequence, start_message, end_message
                   FROM compartments WHERE session_id = ? ORDER BY sequence`,
            )
            .all(sessionId) as Array<{
            id: number;
            sequence: number;
            start_message: number;
            end_message: number;
        }>;
        const existingIndex = rows.findIndex((row) => row.end_message === split.ordinal);
        if (existingIndex >= 0 && rows[existingIndex + 1]?.start_message === split.ordinal + 1) return;
        const source = rows.find(
            (row) => row.start_message <= split.ordinal && row.end_message > split.ordinal,
        );
        if (!source) throw new Error("no published compartment can be split at the synthetic turn");

        db.transaction(() => {
            db.prepare(
                "UPDATE compartments SET sequence = sequence + 1000 WHERE session_id = ? AND sequence > ?",
            ).run(sessionId, source.sequence);
            db.prepare(
                "UPDATE compartments SET sequence = sequence - 999 WHERE session_id = ? AND sequence > ?",
            ).run(sessionId, source.sequence + 1000);
            db.prepare(
                `INSERT INTO compartments
                    (session_id, sequence, start_message, end_message, start_message_id,
                     end_message_id, title, content, p1, p2, p3, p4, importance,
                     episode_type, legacy, created_at, harness, rebase_status)
                 SELECT session_id, ?, ?, end_message, ?, end_message_id, title, content,
                        p1, p2, p3, p4, importance, episode_type, legacy, created_at,
                        harness, rebase_status
                   FROM compartments WHERE id = ?`,
            ).run(source.sequence + 1, split.ordinal + 1, next.id, source.id);
            db.prepare(
                "UPDATE compartments SET end_message = ?, end_message_id = ? WHERE id = ?",
            ).run(split.ordinal, split.id, source.id);
        })();
    } finally {
        db.close();
    }
}

/**
 * Make the Magic Context marker's boundary message the start anchor of a
 * compartment, the shape issue 531 reported.
 *
 * The boundary is a user row inside the last published compartment. OpenCode 2's
 * conversion folds that row and its completed summary into one native
 * `compaction` record that the raw projection does not count, so after the flip
 * the new compartment's start anchor names a message the host no longer serves.
 * Its end anchor and the previous compartment's end anchor both survive.
 *
 * Returns the sequence of the compartment that now starts at the boundary.
 */
function startCompartmentAtMarkerBoundary(
    fixture: ConversionFixture,
    sessionId: string,
    boundaryId: string,
): number {
    const projection = v1Projection(fixture, sessionId);
    const boundary = projection.find((message) => message.id === boundaryId);
    const before = projection.find((message) => message.ordinal === (boundary?.ordinal ?? 0) - 1);
    if (!boundary || !before) throw new Error("the marker boundary has no preceding v1 message");

    const db = openTestDb(fixture.contextDbPath, undefined, Database);
    try {
        db.exec("PRAGMA busy_timeout = 30000");
        const rows = db
            .prepare(
                `SELECT id, sequence, start_message, end_message, start_message_id
                   FROM compartments WHERE session_id = ? ORDER BY sequence`,
            )
            .all(sessionId) as Array<{
            id: number;
            sequence: number;
            start_message: number;
            end_message: number;
            start_message_id: string | null;
        }>;
        const existing = rows.find((row) => row.start_message_id === boundaryId);
        if (existing) return existing.sequence;
        const source = rows.find(
            (row) => row.start_message < boundary.ordinal && row.end_message >= boundary.ordinal,
        );
        if (!source) throw new Error("no published compartment can be split at the marker boundary");

        db.transaction(() => {
            db.prepare(
                "UPDATE compartments SET sequence = sequence + 1000 WHERE session_id = ? AND sequence > ?",
            ).run(sessionId, source.sequence);
            db.prepare(
                "UPDATE compartments SET sequence = sequence - 999 WHERE session_id = ? AND sequence > ?",
            ).run(sessionId, source.sequence + 1000);
            db.prepare(
                `INSERT INTO compartments
                    (session_id, sequence, start_message, end_message, start_message_id,
                     end_message_id, title, content, p1, p2, p3, p4, importance,
                     episode_type, legacy, created_at, harness, rebase_status)
                 SELECT session_id, ?, ?, end_message, ?, end_message_id, title, content,
                        p1, p2, p3, p4, importance, episode_type, legacy, created_at,
                        harness, rebase_status
                   FROM compartments WHERE id = ?`,
            ).run(source.sequence + 1, boundary.ordinal, boundary.id, source.id);
            db.prepare(
                "UPDATE compartments SET end_message = ?, end_message_id = ? WHERE id = ?",
            ).run(before.ordinal, before.id, source.id);
        })();
        return source.sequence + 1;
    } finally {
        db.close();
    }
}

function readFtsRows(fixture: ConversionFixture, sessionId: string) {
    return contextRows<{ ordinal: number; messageId: string }>(
        fixture,
        "SELECT message_ordinal AS ordinal, message_id AS messageId FROM message_history_fts WHERE session_id = ? ORDER BY message_ordinal",
        sessionId,
    );
}

/**
 * One record per transform pass, in order, read from the boot's own plugin log.
 *
 * `transform_decisions` is deliberately sparse — it keeps cache-affecting passes
 * for cause attribution, not every pass — so it cannot answer "was pass 3 a fold
 * or a reuse". The log line is written on every pass and says which it was, and
 * each boot writes its own file, so the first five lines of a file are the first
 * five passes of that boot.
 */
function readFolds(
    fixture: ConversionFixture,
    label: string,
    sessionId: string,
): Array<{ rematerialized: boolean; reason: string }> {
    const path = fixture.logPath(label);
    if (!existsSync(path)) return [];
    const folds: Array<{ rematerialized: boolean; reason: string }> = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.includes(sessionId)) continue;
        const match = /injected m\[0\]\/m\[1\] \(rematerialized=(true|false), reason=([^)]*)\)/.exec(
            line,
        );
        if (match) folds.push({ rematerialized: match[1] === "true", reason: match[2]! });
    }
    return folds;
}

/**
 * Returns one entry per rebuild of the cached m[0]/m[1] head that a boot logged
 * for the session, in order, through its `throughFold`-th transform pass:
 * `fold_owner:<reason>` for a rebuild by the OpenCode 2 compaction-fold owner
 * (v2/fold/owner.ts, logged as `HARD reason=...`) and `transform:<reason>` for
 * an executed transform fold. `readFolds` cannot show the first kind: that
 * rebuild renders the head before the transform runs, so the transform then
 * reports a cache hit on bytes rebuilt moments earlier on the same request.
 */
function readRebuilds(
    fixture: ConversionFixture,
    label: string,
    sessionId: string,
    throughFold: number,
): string[] {
    const path = fixture.logPath(label);
    if (!existsSync(path)) return [];
    const rebuilds: string[] = [];
    let folds = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.includes(sessionId)) continue;
        const ownerHard = /\] HARD reason=(\S+)/.exec(line);
        if (ownerHard) rebuilds.push(`fold_owner:${ownerHard[1]}`);
        const transformHard = /m\[0\] HARD fold decision: reason=(\S+) executed=true/.exec(line);
        if (transformHard) rebuilds.push(`transform:${transformHard[1]}`);
        if (/injected m\[0\]\/m\[1\] \(rematerialized=/.test(line) && ++folds >= throughFold) break;
    }
    return rebuilds;
}

function readGeneration(fixture: ConversionFixture, sessionId: string): string | null {
    const rows = contextRows<{ generation: string | null }>(
        fixture,
        "SELECT coordinate_generation AS generation FROM session_meta WHERE session_id = ?",
        sessionId,
    );
    return rows[0]?.generation ?? null;
}

function v2Projection(fixture: ConversionFixture, sessionId: string) {
    const reader = new V2StoreReader(fixture.openCodeDbPath);
    try {
        return rawMessages(reader.history(sessionId)).map((message) => ({
            id: message.id,
            ordinal: message.ordinal,
        }));
    } finally {
        reader.close();
    }
}

function v1Projection(fixture: ConversionFixture, sessionId: string) {
    const db = new Database(fixture.openCodeDbPath, { readonly: true, fileMustExist: true });
    try {
        return readRawSessionMessagesFromDb(db, sessionId).map((message) => ({
            id: message.id,
            ordinal: message.ordinal,
        }));
    } finally {
        db.close();
    }
}

/**
 * Hash the served content, not the served bytes verbatim.
 *
 * Every run gets a fresh throwaway root, a fresh session id and fresh message
 * ids, and all three appear verbatim in the served system prompt and injected
 * head. Redacting them the way `tool-definition-telemetry.test.ts` does makes the
 * pin a hash of what the model would actually read, which is the thing that must
 * not move between deferred passes.
 */
function servedPin(fixture: ConversionFixture, body: Record<string, unknown>): string {
    const redact = (value: string) =>
        value
            .split(fixture.root)
            .join("<ROOT>")
            .split(fixture.cwd)
            .join("<CWD>")
            .replace(/ses_[A-Za-z0-9]+/g, "<SES>")
            .replace(/msg_[A-Za-z0-9]+/g, "<MSG>");
    return sha({
        head: redact(headText(body)),
        instructions: redact(systemText(body)),
        tools: redact(JSON.stringify(body.tools ?? null)),
    });
}

/** Wait until `read` returns something truthy, or fail with the label. */
async function until<T>(
    read: () => T | null | undefined | false,
    label: string,
    timeoutMs = 60_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | null | undefined | false;
    while (Date.now() < deadline) {
        last = read();
        if (last) return last as T;
        await Bun.sleep(150);
    }
    throw new Error(`timed out waiting for ${label} (last value ${JSON.stringify(last)})`);
}

/**
 * Run the shipped `doctor` against the throwaway root.
 *
 * The OpenCode installation doctor detects is the 1.18.x binary on PATH, so the
 * projection it compares against is v1 — which is exactly the question an
 * operator asks between the two boots: how much would the next open re-anchor.
 */
function runDoctor(fixture: ConversionFixture): string {
    const probe = () => spawnSync(
        process.execPath,
        [CLI_ENTRY, "doctor", "--harness", "opencode"],
        {
            encoding: "utf8",
            timeout: 180_000,
            cwd: fixture.cwd,
            env: {
                PATH: process.env.PATH,
                HOME: fixture.env.HOME,
                XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME,
                XDG_DATA_HOME: fixture.env.XDG_DATA_HOME,
                XDG_STATE_HOME: fixture.env.XDG_STATE_HOME,
                XDG_CACHE_HOME: fixture.env.XDG_CACHE_HOME,
                XDG_RUNTIME_DIR: fixture.env.XDG_RUNTIME_DIR,
                OPENCODE_DB: "opencode2.db",
                MAGIC_CONTEXT_STORAGE_DIR: fixture.storageDir,
                MAGIC_CONTEXT_LOG_PATH: fixture.logPath("doctor"),
            },
        },
    );
    // A busy host can exceed doctor's short CLI version probe timeout. Re-probe
    // once so a transient unknown version cannot hide the rebase diagnosis.
    let result = probe();
    let output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (output.includes("OpenCode reported no version")) {
        result = probe();
        output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    }
    if (result.error) throw new Error(`doctor failed to run: ${String(result.error)}\n${output}`);
    return output;
}
beforeAll(async () => {
    const fixture = conversionFixture("issue-492-f1-conversion-e2e");
    const workerMissingBundle = markerWorkerBundleFixture();
    cleanup.push(async () => workerMissingBundle.dispose());
    const mock = new MockProvider();
    const provider = await mock.start();
    cleanup.push(() => mock.stop());

    // Both hosts share one mock. The historian answer is computed from the chunk
    // the request actually carries, so a publication covers whatever range the
    // running host offered rather than a hard-coded one.
    mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = historianOrdinalRange(body);
        if (!range) {
            return {
                text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                usage: { input_tokens: 500, output_tokens: 50 },
            };
        }
        return {
            text: buildMockHistorianPayload({
                start: range.start,
                end: range.end,
                title: `converted store chunk ${range.start}-${range.end}`,
                body: "Turns driven by the store-conversion e2e fixture, summarized so the compartment carries a real endpoint.",
            }),
            usage: { input_tokens: 500, output_tokens: 200 },
        };
    });
    const quiet = { text: "ok", usage: { input_tokens: 1_000, output_tokens: 20 } };
    // High enough to cross the force band of a 64k window, low enough that the 2.x
    // host's own auto-compaction (context − output − buffer) never triggers.
    const pressure = { text: "pressure", usage: { input_tokens: 54_000, output_tokens: 20 } };
    mock.setDefault(quiet);

    // The window has to be small enough that a session of a few dozen turns leaves
    // an eligible head in front of the protected tail, and at least MIN_SANE_LIMIT
    // (20k) or the plugin discards the host-reported limit as a placeholder and
    // falls back to its 200k default — which would protect the whole session and
    // the historian could never start.
    const CONTEXT_LIMIT = 64_000;
    const OUTPUT_LIMIT = 1_024;
    const magicContextConfig = {
        execute_threshold_percentage: 40,
        history_budget_percentage: 0.15,
        memory: { enabled: false },
        dreamer: { disable: true },
    };

    const words = [
        "boundary", "historian", "compartment", "schedule", "pressure", "tokens",
        "window", "publish", "transform", "session", "marker", "budget", "eligible",
        "protected", "ordinal", "snapshot", "replay", "decision", "threshold",
    ];
    /**
     * Real prose mass. The protected-tail boundary measures true content, not the
     * usage numbers the mock reports, so turns without real text leave the
     * historian with nothing to compact however much pressure is faked.
     */
    const ballast = (tokens: number) => {
        const target = tokens * 4;
        const parts: string[] = [];
        let length = 0;
        for (let index = 0; length < target; index += 1) {
            const word = words[index % words.length]!;
            parts.push(index % 17 === 0 ? `${word}.` : word);
            length += word.length + 1;
        }
        return parts.join(" ");
    };

    // ── 1.x, first boot: write a session the conversion will renumber ──────────
    const v1 = await spawnOpencode1({
        fixture,
        mock,
        mockBaseURL: provider.baseURL,
        magicContextConfig,
        modelContextLimit: CONTEXT_LIMIT,
        modelOutputLimit: OUTPUT_LIMIT,
        logLabel: "v1-forward",
    });
    let v1Stopped = false;
    cleanup.push(async () => {
        if (!v1Stopped) await v1.stop();
    });
    const sdk = await import("@opencode-ai/sdk");
    type V1Client = {
        session: {
            create: (opts: { query: { directory: string } }) => Promise<{ data?: { id: string } }>;
            prompt: (opts: {
                path: { id: string };
                body: {
                    model: { providerID: string; modelID: string };
                    parts: Array<Record<string, unknown>>;
                };
            }) => Promise<{ data?: { info?: { error?: unknown } }; error?: unknown }>;
        };
    };
    const v1Client = sdk.createOpencodeClient({ baseUrl: v1.url }) as unknown as V1Client;
    const created = await v1Client.session.create({ query: { directory: fixture.cwd } });
    const sessionId = created.data?.id;
    if (!sessionId) throw new Error("1.x session create returned no id");

    const promptOn = (client: V1Client): PromptDriver =>
        async (text, extraParts = []) => {
            const result = await client.session.prompt({
                path: { id: sessionId },
                body: {
                    model: { providerID: SHARED_MOCK_PROVIDER_ID, modelID: SHARED_MOCK_MODEL_ID },
                    parts: [{ type: "text", text }, ...extraParts],
                },
            });
            if (!result.data) {
                const logs = readdirSync(fixture.root, { recursive: true })
                    .filter((path) => String(path).endsWith(".log"))
                    .map((path) => `${path}:\n${readFileSync(join(fixture.root, String(path)), "utf8").slice(-30000)}`)
                    .join("\n");
                throw new Error(`1.x prompt failed: ${JSON.stringify(result.error)}\n${v1.stderr()}\n${logs}`);
            }
            if (result.data.info?.error) {
                throw new Error(`1.x assistant error: ${JSON.stringify(result.data.info.error)}`);
            }
        };
    const promptV1 = promptOn(v1Client);

    const driveHistorian = async (
        prompt: PromptDriver,
        label: string,
        satisfied: () => boolean,
        rounds = 12,
    ) => {
        await drivePressureTurns({ prompt, mock, pressure, quiet, label, satisfied, rounds });
    };

    const CONTENT_TURNS = 10;
    // Turn 1 is the split: one authored text part plus one synthetic part in the
    // same user turn. 2.0.5 converts that into a `user` row and a derived
    // `synthetic` row, which pushes every later ordinal up by one. Putting it
    // first guarantees it falls inside whatever the first compartment covers.
    await promptV1(`turn 1: open the conversion fixture. ${ballast(3_000)}`, [
        {
            type: "text",
            text: "<system-reminder>fixture environment note appended by the client</system-reminder>",
            synthetic: true,
        },
    ]);
    for (let turn = 2; turn <= CONTENT_TURNS; turn += 1) {
        await promptV1(`turn ${turn}: durable signal for chunk ${turn}. ${ballast(3_000)}`);
    }
    await driveHistorian(
        promptV1,
        "a 1.x compartment covering the split turn",
        () => {
            const compartments = readCompartments(fixture, sessionId);
            return (
                compartments.length > 0 &&
                compartments[compartments.length - 1]!.endMessage >= 2 * CONTENT_TURNS - 4
            );
        },
    );
    await promptV1("cooldown turn after the 1.x historian caught up.");

    // A real tool arc, so the flip carries tool tags and a tool-shaped message as
    // well as plain text.
    writeFileSync(join(fixture.cwd, "conversion-notes.txt"), `${ballast(200)}\n`);
    let readIssued = false;
    mock.addMatcher((body) => {
        if (isHistorianRequest(body) || readIssued) return null;
        readIssued = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: "toolu_conversion_read",
                    name: "read",
                    input: { filePath: join(fixture.cwd, "conversion-notes.txt") },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: { input_tokens: 1_000, output_tokens: 20 },
        };
    });
    await promptV1("read the conversion notes file.");
    await until(
        () =>
            contextRows<{ count: number }>(
                fixture,
                "SELECT COUNT(*) AS count FROM tags WHERE session_id = ? AND type = 'tool'",
                sessionId,
            )[0]!.count > 0,
        "a tool tag from the 1.x tool arc",
        30_000,
    );

    const syntheticParts = (() => {
        const db = new Database(fixture.openCodeDbPath, { readonly: true, fileMustExist: true });
        try {
            return db
                .prepare(
                    `SELECT DISTINCT message_id AS id FROM part
                      WHERE session_id = ? AND json_extract(data, '$.synthetic') = 1`,
                )
                .all(sessionId) as Array<{ id: string }>;
        } finally {
            db.close();
        }
    })();
    if (syntheticParts.length !== 1) {
        throw new Error(
            `expected exactly one 1.x turn carrying a synthetic part, found ${syntheticParts.length}`,
        );
    }
    const splitMessageId = syntheticParts[0]!.id;
    placeSyntheticSplitBetweenCompartments(fixture, sessionId, splitMessageId);
    const v1Compartments = readCompartments(fixture, sessionId);

    // A reduction driven through the real tool rather than inserted, because the
    // part-tag fold the rebase performs only has to respect drops the agent
    // actually asked for.
    const firstTag = contextRows<{ tagNumber: number }>(
        fixture,
        "SELECT tag_number AS tagNumber FROM tags WHERE session_id = ? AND type = 'message' ORDER BY tag_number LIMIT 1",
        sessionId,
    )[0];
    if (!firstTag) throw new Error("no message tag to reduce");
    let reduceIssued = false;
    mock.addMatcher((body) => {
        if (isHistorianRequest(body) || reduceIssued) return null;
        reduceIssued = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: "toolu_conversion_reduce",
                    name: "ctx_reduce",
                    input: { drop: String(firstTag.tagNumber) },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: { input_tokens: 1_000, output_tokens: 20 },
        };
    });
    await promptV1("reduce the oldest tag so the ledger carries a real reduction.");
    await until(
        () =>
            contextRows<{ status: string }>(
                fixture,
                "SELECT status FROM tags WHERE session_id = ? AND tag_number = ?",
                sessionId,
                firstTag.tagNumber,
            )[0]?.status === "dropped",
        "the ctx_reduce drop to reach the tag ledger",
        30_000,
    );

    const ftsBefore = readFtsRows(fixture, sessionId);
    if (ftsBefore.length === 0) throw new Error("the 1.x boot left no search index to rebuild");
    // Read last, after every 1.x turn has been written. A message id missing from
    // this projection is one the way back will still resolve, and leaving it out
    // would make the search below pick the wrong compartment as the 2.x-only one.
    const v1Before = v1Projection(fixture, sessionId);
    const markerEvidence = (() => {
        const db = new Database(fixture.openCodeDbPath, { readonly: true, fileMustExist: true });
        try {
            const marker = db
                .prepare(
                    `SELECT json_extract(data, '$.parentID') AS boundaryId,
                            json_extract(data, '$.time.created') AS created,
                            json_extract(data, '$.time.completed') AS completed
                       FROM message
                      WHERE session_id = ?
                        AND json_extract(data, '$.summary') = 1
                        AND json_extract(data, '$.providerID') = 'magic-context'
                      ORDER BY time_created DESC, id DESC
                      LIMIT 1`,
                )
                .get(sessionId) as
                | { boundaryId: string; created: number; completed: number }
                | undefined;
            if (!marker) throw new Error("the 1.x historian left no Magic Context marker");

            const userTextRows = db
                .prepare(
                    `SELECT p.message_id AS id, json_extract(p.data, '$.text') AS text
                       FROM part p
                       JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
                      WHERE p.session_id = ?
                        AND json_extract(m.data, '$.role') = 'user'
                        AND json_extract(p.data, '$.type') = 'text'
                      ORDER BY m.time_created, m.id, p.time_created, p.id`,
                )
                .all(sessionId) as Array<{ id: string; text: string }>;
            const projection = new Map(v1Before.map((message) => [message.id, message.ordinal]));
            const boundaryOrdinal = projection.get(marker.boundaryId);
            if (boundaryOrdinal === undefined) {
                throw new Error(`marker boundary ${marker.boundaryId} is absent from the v1 projection`);
            }
            const authored = userTextRows
                .map((row) => ({ ...row, ordinal: projection.get(row.id) }))
                .filter(
                    (row): row is { id: string; text: string; ordinal: number } =>
                        typeof row.ordinal === "number" && typeof row.text === "string",
                );
            const before = authored.find((row) => row.ordinal < boundaryOrdinal);
            const after = authored.findLast((row) => row.ordinal > boundaryOrdinal);
            if (!before || !after) {
                throw new Error(
                    `marker boundary ${marker.boundaryId} did not leave both a compacted prefix and a retained tail`,
                );
            }
            return {
                boundaryId: marker.boundaryId,
                created: marker.created,
                completed: marker.completed,
                preBoundarySentinel: before.text.slice(0, 96),
                postBoundarySentinel: after.text.slice(0, 96),
            };
        } finally {
            db.close();
        }
    })();
    // Done last on the 1.x host, after its final publication, so the marker
    // boundary read above is still inside the compartment being split.
    const boundaryCompartmentSequence = startCompartmentAtMarkerBoundary(
        fixture,
        sessionId,
        markerEvidence.boundaryId,
    );
    v1Stopped = true;
    await v1.stop();

    // ── 2.0.5: same data root, same session, real conversion ──────────────────
    fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2");
    const v2 = await spawnOpencode2({
        magicContextPlugin: workerMissingBundle.root,
        existingIsolation: fixture,
        existingMock: { mock, baseURL: provider.baseURL },
        magicContextConfig,
        modelContextLimit: CONTEXT_LIMIT,
        modelOutputLimit: OUTPUT_LIMIT,
    });
    let v2Stopped = false;
    cleanup.push(async () => {
        if (!v2Stopped) await v2.stopHost();
    });
    const v2Client = OpenCode.make({
        baseUrl: v2.url,
        headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` },
    });
    await waitForPluginActive(v2Client, fixture.cwd);
    const convertedMarkerCount = (() => {
        const db = new Database(fixture.openCodeDbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db
                .prepare(
                    "SELECT COUNT(*) AS count FROM session_message WHERE id = ? AND type = 'compaction'",
                )
                .get(markerEvidence.boundaryId) as { count: number };
            return row.count;
        } finally {
            db.close();
        }
    })();
    const promptV2: PromptDriver = async (text) => {
        await v2Client.session.prompt({ sessionID: sessionId, text });
        await v2Client.session.wait(
            { sessionID: sessionId },
            { signal: AbortSignal.timeout(120_000) },
        );
    };

    const forwardFirstRequest = mock.requests().length;
    await promptV2("first prompt on the converted store");
    const firstConvertedRequest = mock
        .requests()
        .slice(forwardFirstRequest)
        .find((request) => JSON.stringify(request.body.input ?? "").includes("first prompt on the converted store"));
    if (!firstConvertedRequest) throw new Error("the first converted prompt reached no v2 provider input");
    const firstConvertedInput = JSON.stringify(firstConvertedRequest.body.input);
    expect(existsSync(join(workerMissingBundle.root, "dist/v2/compaction-marker-candidates-worker.js"))).toBe(false);
    expect(readFileSync(fixture.logPath("v2"), "utf8")).not.toContain("compaction-marker-drain-failure");
    const forwardRebaseLines = await settledRebaseLinesFor(fixture, "v2", sessionId);
    const forwardCompartments = readCompartments(fixture, sessionId);
    const forwardProjection = v2Projection(fixture, sessionId);
    const forwardFts = readFtsRows(fixture, sessionId);
    const forwardGeneration = readGeneration(fixture, sessionId);
    // The row the conversion derived from the split turn, taken from the store's
    // own row type rather than guessed from the id shape.
    const syntheticRowId = (() => {
        const db = new Database(fixture.openCodeDbPath, { readonly: true, fileMustExist: true });
        try {
            const rows = db
                .prepare(
                    "SELECT id FROM session_message WHERE session_id = ? AND type = 'synthetic' ORDER BY seq",
                )
                .all(sessionId) as Array<{ id: string }>;
            if (rows.length !== 1) {
                throw new Error(`expected exactly one converted synthetic row, found ${rows.length}`);
            }
            return rows[0]!.id;
        } finally {
            db.close();
        }
    })();
    const forwardOrdinals = new Map(forwardProjection.map((message) => [message.id, message.ordinal]));
    const splitOrdinal = forwardOrdinals.get(splitMessageId);
    const syntheticGapOrdinal = forwardOrdinals.get(syntheticRowId);
    if (splitOrdinal === undefined || syntheticGapOrdinal !== splitOrdinal + 1) {
        throw new Error("the converted synthetic row did not immediately follow its source turn");
    }
    const healedGapCompartment = forwardCompartments.find(
        (compartment) => compartment.endMessage === syntheticGapOrdinal,
    );
    const followingGapCompartment = forwardCompartments.find(
        (compartment) => compartment.startMessage === syntheticGapOrdinal + 1,
    );
    if (!healedGapCompartment || !followingGapCompartment) {
        throw new Error("the forward rebase did not produce the expected healed split geometry");
    }

    // Model a session converted before synthetic-gap absorption was available:
    // session_meta records the v2 projection, but the converted synthetic row is
    // still between stored compartment ranges. The latest compartment end is the
    // tail cache's lower bound, and it sits above the synthetic row in this arm.
    const gapDb = openTestDb(fixture.contextDbPath, undefined, Database);
    try {
        gapDb.exec("PRAGMA busy_timeout = 30000");
        // Bun's run().changes includes the v93 history-trigger write as well as
        // the compartment update. RETURNING counts only matched compartments,
        // so a stale endpoint still fails the exactly-one-row assertion.
        const update = gapDb
            .prepare(
                "UPDATE compartments SET end_message = ? WHERE session_id = ? AND sequence = ? AND end_message = ? RETURNING sequence, end_message",
            )
            .all(
                splitOrdinal,
                sessionId,
                healedGapCompartment.sequence,
                syntheticGapOrdinal,
            );
        if (update.length !== 1) throw new Error("failed to recreate the stored synthetic gap");
        expect(update).toEqual([{ sequence: healedGapCompartment.sequence, end_message: splitOrdinal }]);
        expect(
            gapDb.prepare("SELECT end_message FROM compartments WHERE session_id = ? AND sequence = ?")
                .get(sessionId, healedGapCompartment.sequence),
        ).toEqual({ end_message: splitOrdinal });
    } finally {
        gapDb.close();
    }
    const longArmBaselineCompartments = readCompartments(fixture, sessionId);
    const tailCacheCoveredFromOrdinal = longArmBaselineCompartments.at(-1)?.endMessage;
    if (
        tailCacheCoveredFromOrdinal === undefined ||
        tailCacheCoveredFromOrdinal <= syntheticGapOrdinal
    ) {
        throw new Error("the long conversion arm did not place the synthetic gap below the tail cache");
    }
    const longArmBaselineCompartmentSequence = Math.max(
        ...longArmBaselineCompartments.map((row) => row.sequence),
    );

    for (const pass of [2, 3, 4, 5]) await promptV2(`defer pass ${pass} on the converted store`);
    const forwardFolds = await until(
        () => {
            const rows = readFolds(fixture, "v2", sessionId);
            return rows.length >= 5 ? rows : false;
        },
        "five recorded fold decisions on the converted store",
        30_000,
    );
    const forwardServed = mock
        .requests()
        .slice(forwardFirstRequest)
        .filter((request) => !isHistorianRequest(request.body));
    const forwardPins = forwardServed.slice(0, 5).map((request) => servedPin(fixture, request.body));
    const forwardRebuilds = readRebuilds(fixture, "v2", sessionId, 5);

    // Give the 2.x boot its own compartment, ending on a row the 1.x tables never
    // held, so the way back has a genuinely unresolvable endpoint to mark.
    const v1MessageIds = new Set(v1Before.map((message) => message.id));
    const tailOnlyCompartment = () =>
        readCompartments(fixture, sessionId).find(
            (compartment) =>
                compartment.endMessageId !== null && !v1MessageIds.has(compartment.endMessageId),
        );
    const longArmHistorianRequestsBefore = mock
        .requests()
        .filter((request) => isHistorianRequest(request.body)).length;
    for (let turn = 1; turn <= 8; turn += 1) {
        await promptV2(`2.x turn ${turn}: content only this host's store holds. ${ballast(3_000)}`);
    }
    const tailCacheCoveredToOrdinalBeforePressure = v2Projection(fixture, sessionId).at(-1)?.ordinal;
    if (tailCacheCoveredToOrdinalBeforePressure === undefined) {
        throw new Error("the long conversion arm has no raw-message tail");
    }
    await driveHistorian(
        promptV2,
        "a 2.x compartment whose endpoint the 1.x store never held",
        () => tailOnlyCompartment() !== undefined,
    );
    const tailCompartment = tailOnlyCompartment()!;
    const longArmHistorianRequestCount =
        mock.requests().filter((request) => isHistorianRequest(request.body)).length -
        longArmHistorianRequestsBefore;
    const existingValidationFailureLines = readFileSync(fixture.logPath("v2"), "utf8")
        .split("\n")
        .filter(
            (line) =>
                line.includes(sessionId) &&
                line.includes("historian failure: source=existing-validation"),
        );

    await promptV2("2.x tail turn one");
    await promptV2("2.x tail turn two");
    v2Stopped = true;
    await v2.stopHost();

    const doctorBetween = runDoctor(fixture);

    // ── 1.x again: the way back ───────────────────────────────────────────────
    const back = await spawnOpencode1({
        fixture,
        mock,
        mockBaseURL: provider.baseURL,
        magicContextConfig,
        modelContextLimit: CONTEXT_LIMIT,
        modelOutputLimit: OUTPUT_LIMIT,
        logLabel: "v1-back",
    });
    let backStopped = false;
    cleanup.push(async () => {
        if (!backStopped) await back.stop();
    });
    const backClient = sdk.createOpencodeClient({ baseUrl: back.url }) as unknown as V1Client;
    const promptBack = promptOn(backClient);

    const backFirstRequest = mock.requests().length;
    await promptBack("first prompt back on the old host");
    const backRebaseLines = await settledRebaseLinesFor(fixture, "v1-back", sessionId);
    const backCompartments = readCompartments(fixture, sessionId);
    const backProjection = v1Projection(fixture, sessionId);
    const backFts = readFtsRows(fixture, sessionId);
    const backGeneration = readGeneration(fixture, sessionId);

    for (const pass of [2, 3, 4, 5]) await promptBack(`defer pass ${pass} back on the old host`);
    const backFolds = await until(
        () => {
            const rows = readFolds(fixture, "v1-back", sessionId);
            return rows.length >= 5 ? rows : false;
        },
        "five recorded fold decisions back on the old host",
        30_000,
    );
    const backServed = mock
        .requests()
        .slice(backFirstRequest)
        .filter((request) => !isHistorianRequest(request.body));
    const backPins = backServed.slice(0, 5).map((request) => servedPin(fixture, request.body));
    const lastBackRequest = backServed.at(-1);
    if (!lastBackRequest) throw new Error("the way back served no provider request");
    const servedHeadBack = headText(lastBackRequest.body);

    // Range recovery for the unresolved compartment, asked for through the host's
    // own tool rather than by calling the implementation.
    const unresolved = backCompartments.find(
        (compartment) => compartment.sequence === tailCompartment.sequence,
    );
    if (!unresolved) throw new Error("the 2.x-only compartment disappeared on the way back");
    if (unresolved.rebaseStatus !== "unresolved") {
        throw new Error(
            `expected the 2.x-only compartment to be unresolved on the way back, got ${unresolved.rebaseStatus}`,
        );
    }
    let expandIssued = false;
    mock.addMatcher((body) => {
        if (isHistorianRequest(body) || expandIssued) return null;
        expandIssued = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: "toolu_conversion_expand",
                    name: "ctx_expand",
                    input: { start: unresolved.startMessage, end: unresolved.endMessage },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: { input_tokens: 1_000, output_tokens: 20 },
        };
    });
    const beforeExpand = mock.requests().length;
    await promptBack("recover the range the 2.x host compacted");
    const expandRefusal = mock
        .requests()
        .slice(beforeExpand)
        .flatMap((request) => allStrings(request.body))
        .filter((text) => text.includes("Range ") || text.includes("No messages found in range"))
        .join("\n");

    backStopped = true;
    await back.stop();
    const doctorAfter = runDoctor(fixture);

    const resolvedForHeading = backCompartments.find(
        (compartment) => compartment.rebaseStatus === "ok",
    );
    evidence = {
        fixture,
        sessionId,
        splitMessageId,
        syntheticRowId,
        v1MaxCompartmentSequence: Math.max(...v1Compartments.map((row) => row.sequence)),
        longArmBaselineCompartmentSequence,
        postFlipCompartmentSequence: tailCompartment.sequence,
        syntheticGapOrdinal,
        tailCacheCoveredFromOrdinal,
        tailCacheCoveredToOrdinalBeforePressure,
        longArmHistorianRequestCount,
        existingValidationFailureLines,
        forward: {
            rebaseLines: forwardRebaseLines,
            generation: forwardGeneration,
            compartments: forwardCompartments,
            projection: forwardProjection,
            ftsRows: forwardFts,
            folds: forwardFolds,
            pins: forwardPins,
        },
        forwardRebuilds,
        back: {
            rebaseLines: backRebaseLines,
            generation: backGeneration,
            compartments: backCompartments,
            projection: backProjection,
            ftsRows: backFts,
            folds: backFolds,
            pins: backPins,
        },
        doctorBetween,
        doctorAfter,
        expandRefusal,
        unresolvedHeading: `## ${unresolved.startMessage}-${unresolved.endMessage} `,
        resolvedHeading: resolvedForHeading
            ? `## ${resolvedForHeading.startMessage}-${resolvedForHeading.endMessage} `
            : "",
        servedHeadBack,
        markerBoundaryId: markerEvidence.boundaryId,
        markerCreated: markerEvidence.created,
        markerCompleted: markerEvidence.completed,
        boundaryCompartmentSequence,
        convertedMarkerCount,
        firstConvertedInput,
        preBoundarySentinel: markerEvidence.preBoundarySentinel,
        postBoundarySentinel: markerEvidence.postBoundarySentinel,
    };
    // Printed, not just asserted: the delivery record for this change quotes the
    // rebase lines, the served-byte pins and the doctor counts, and they can only
    // come from a real run.
    const doctorProjectionLines = (output: string) =>
        output
            .split("\n")
            .filter((line) => /re-anchored|already on v[12]|unresolved=|Store projection/.test(line))
            .join("\n");
    console.log(`[issue-492] root ${fixture.root}`);
    console.log(`[issue-492] forward rebase: ${forwardRebaseLines.join(" | ")}`);
    console.log(`[issue-492] back rebase: ${backRebaseLines.join(" | ")}`);
    console.log(`[issue-492] forward pins: ${JSON.stringify(forwardPins)}`);
    console.log(`[issue-492] forward folds: ${JSON.stringify(forwardFolds)}`);
    console.log(`[issue-492] forward rebuilds: ${JSON.stringify(forwardRebuilds)}`);
    console.log(`[issue-492] back folds: ${JSON.stringify(backFolds)}`);
    console.log(`[issue-492] back pins: ${JSON.stringify(backPins)}`);
    console.log(
        `[issue-492] long synthetic-gap arm: gap=${syntheticGapOrdinal} tail-cache=${tailCacheCoveredFromOrdinal}-${tailCacheCoveredToOrdinalBeforePressure} historian_requests=${longArmHistorianRequestCount} existing_validation_failures=${existingValidationFailureLines.length}`,
    );
    console.log(`[issue-492] served head (way back): ${servedHeadBack}`);
    console.log(`[issue-492] doctor (between):\n${doctorProjectionLines(doctorBetween)}`);
    console.log(`[issue-492] doctor (after):\n${doctorProjectionLines(doctorAfter)}`);
}, 1_800_000);

afterAll(async () => {
    for (const stop of cleanup.reverse()) await stop().catch(() => undefined);
});

test("OpenCode 2 converts the completed MC marker and serves only its retained tail", () => {
    expect(evidence.markerCompleted).toBe(evidence.markerCreated);
    expect(evidence.convertedMarkerCount).toBe(1);
    expect(evidence.markerBoundaryId).not.toBe("");
    expect(evidence.firstConvertedInput).toContain("first prompt on the converted store");
    expect(evidence.firstConvertedInput).toContain(evidence.postBoundarySentinel);
    expect(evidence.firstConvertedInput).not.toContain(evidence.preBoundarySentinel);
});

test("the conversion split is healed between compartments and the historian publishes afterward", () => {
    expect(evidence.syntheticRowId).not.toBe("");
    const projection = new Map(evidence.forward.projection.map((m) => [m.id, m.ordinal]));
    const splitOrdinal = projection.get(evidence.splitMessageId);
    const syntheticOrdinal = projection.get(evidence.syntheticRowId);
    expect(splitOrdinal).toBeDefined();
    expect(syntheticOrdinal).toBe(splitOrdinal! + 1);
    const healedPrevious = evidence.forward.compartments.find(
        (compartment) => compartment.endMessage === syntheticOrdinal,
    );
    const following = evidence.forward.compartments.find(
        (compartment) => compartment.startMessage === syntheticOrdinal! + 1,
    );
    expect(healedPrevious?.endMessageId).toBe(evidence.splitMessageId);
    expect(following).toBeDefined();

    expect(evidence.syntheticGapOrdinal).toBe(syntheticOrdinal!);
    expect(evidence.tailCacheCoveredFromOrdinal).toBeGreaterThan(evidence.syntheticGapOrdinal);
    expect(evidence.tailCacheCoveredToOrdinalBeforePressure).toBeGreaterThan(
        evidence.tailCacheCoveredFromOrdinal,
    );
    expect(evidence.longArmHistorianRequestCount).toBeGreaterThan(0);
    expect(evidence.postFlipCompartmentSequence).toBeGreaterThan(
        evidence.longArmBaselineCompartmentSequence,
    );
    expect(evidence.existingValidationFailureLines).toEqual([]);
});

test("the forward flip logs exactly one rebase that rewrote at least one coordinate", () => {
    expect(evidence.forward.rebaseLines).toHaveLength(1);
    const line = evidence.forward.rebaseLines[0]!;
    expect(line).toContain("store-generation-rebase v1->v2");
    const rewritten = Number(/rows_rewritten=(\d+)/.exec(line)?.[1] ?? "0");
    expect(rewritten).toBeGreaterThanOrEqual(1);
});

test("the forward flip records the v2 projection on the session", () => {
    expect(evidence.forward.generation).toBe("v2");
});

test("every compartment endpoint resolves to the row its endpoint id names", () => {
    const projection = new Map(evidence.forward.projection.map((m) => [m.id, m.ordinal]));
    expect(evidence.forward.compartments.length).toBeGreaterThanOrEqual(1);
    for (const compartment of evidence.forward.compartments) {
        // Its start anchor is the removed marker boundary; the next test covers it.
        if (compartment.sequence === evidence.boundaryCompartmentSequence) continue;
        expect(compartment.rebaseStatus).toBe("ok");
        expect(compartment.endMessageId).toBeString();
        const endpointOrdinal = projection.get(compartment.endMessageId!);
        if (compartment.endMessageId === evidence.splitMessageId) {
            const syntheticOrdinal = projection.get(evidence.syntheticRowId);
            expect(endpointOrdinal).toBeDefined();
            expect(syntheticOrdinal).toBe(endpointOrdinal! + 1);
            expect(compartment.endMessage).toBe(syntheticOrdinal!);
        } else {
            expect(endpointOrdinal).toBe(compartment.endMessage);
        }
        expect(projection.get(compartment.startMessageId!)).toBe(compartment.startMessage);
    }
});

test("a compartment starting at the converted marker boundary is placed from its neighbour and the historian publishes after the flip", () => {
    const projection = new Map(evidence.forward.projection.map((m) => [m.id, m.ordinal]));
    // The conversion folded the boundary row into a native compaction record the
    // raw projection does not count, so this start anchor resolves nowhere.
    expect(projection.has(evidence.markerBoundaryId)).toBe(false);
    const compartments = evidence.forward.compartments;
    const index = compartments.findIndex(
        (compartment) => compartment.sequence === evidence.boundaryCompartmentSequence,
    );
    expect(index).toBeGreaterThan(0);
    const boundaryCompartment = compartments[index]!;
    const previous = compartments[index - 1]!;
    expect(boundaryCompartment.startMessageId).toBe(evidence.markerBoundaryId);
    expect(boundaryCompartment.rebaseStatus).toBe("ok");
    expect(previous.rebaseStatus).toBe("ok");
    expect(boundaryCompartment.startMessage).toBe(previous.endMessage + 1);
    expect(projection.get(boundaryCompartment.endMessageId!)).toBe(boundaryCompartment.endMessage);
    expect(evidence.forward.rebaseLines[0]).toMatch(/derived=[1-9]/);

    // The stored history still tiles, so the historian's pre-run check passes
    // and a compartment is published after the flip.
    expect(evidence.existingValidationFailureLines).toEqual([]);
    expect(evidence.postFlipCompartmentSequence).toBeGreaterThan(
        evidence.longArmBaselineCompartmentSequence,
    );
});

test("the search index matches the v2 projection with no duplicate ordinals", () => {
    const projection = new Map(evidence.forward.projection.map((m) => [m.id, m.ordinal]));
    expect(evidence.forward.ftsRows.length).toBeGreaterThan(0);
    for (const row of evidence.forward.ftsRows) {
        expect(projection.get(row.messageId)).toBe(row.ordinal);
    }
    const ordinals = evidence.forward.ftsRows.map((row) => row.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    const ids = evidence.forward.ftsRows.map((row) => row.messageId);
    expect(new Set(ids).size).toBe(ids.length);
});

// The conversion clears the cached m[0]/m[1] head (store-generation-rebase.ts),
// so the first 2.x request must rebuild it exactly once. The OpenCode 2
// compaction-fold owner does that rebuild (reason boot_recovery) because the
// converted store has no 2.x fold record yet, and it renders the head before
// the transform runs; the transform then serves those bytes as a cache hit.
// Before 0.49.11 that fold stored a system-prompt hash of the raw request draft,
// which never matched the hash the transform compares, so the same request
// rebuilt the head a second time with reason system_hash. Removing that extra
// rebuild after a compaction is a documented 0.49.11 fix.
test("the converted store rebuilds once and serves five byte-identical cache hits", () => {
    expect(evidence.forward.pins).toHaveLength(5);
    expect(new Set(evidence.forward.pins).size).toBe(1);
    expect(evidence.forwardRebuilds).toEqual(["fold_owner:boot_recovery"]);
    const folds = evidence.forward.folds.slice(0, 5);
    expect(folds).toHaveLength(5);
    expect(folds.map((fold) => fold.rematerialized)).toEqual([false, false, false, false, false]);
    expect(folds.map((fold) => fold.reason)).toEqual([
        "cache_hit",
        "cache_hit",
        "cache_hit",
        "cache_hit",
        "cache_hit",
    ]);
});

test("doctor reports the conversion state for its selected store host", () => {
    // With both generations installed, doctor deliberately checks the native
    // store host even when the OpenCode 1 binary is first on PATH.
    if (/Store and conversion checks below use OpenCode 2\./.test(evidence.doctorBetween)) {
        expect(evidence.doctorBetween).toContain("already anchored to this host's v2 store projection");
        expect(evidence.doctorBetween).not.toContain("would be re-anchored on next open");
        return;
    }
    expect(evidence.doctorBetween).toContain("would be re-anchored on next open");
    const pending = /(\d+) session\(s\) with compartments would be re-anchored/.exec(
        evidence.doctorBetween,
    );
    expect(pending).not.toBeNull();
    expect(Number(pending![1])).toBeGreaterThanOrEqual(1);
    expect(evidence.doctorBetween).toContain("1 recorded against the other projection");
});

test("the way back logs exactly one rebase and records the v1 projection", () => {
    expect(evidence.back.rebaseLines).toHaveLength(1);
    expect(evidence.back.rebaseLines[0]!).toContain("store-generation-rebase v2->v1");
    expect(evidence.back.generation).toBe("v1");
});

test("the 2.x-only tail is unresolved and everything else resolves by id", () => {
    const projection = new Map(evidence.back.projection.map((m) => [m.id, m.ordinal]));
    const unresolved = evidence.back.compartments.filter(
        (compartment) => compartment.rebaseStatus === "unresolved",
    );
    expect(unresolved.length).toBeGreaterThanOrEqual(1);
    for (const compartment of unresolved) {
        expect(projection.has(compartment.endMessageId!)).toBe(false);
    }
    for (const compartment of evidence.back.compartments) {
        if (compartment.rebaseStatus === "unresolved") continue;
        expect(projection.get(compartment.endMessageId!)).toBe(compartment.endMessage);
        expect(projection.get(compartment.startMessageId!)).toBe(compartment.startMessage);
    }
    // No compartment claims an end position occupied by some other message.
    const byOrdinal = new Map(evidence.back.projection.map((m) => [m.ordinal, m.id]));
    for (const compartment of evidence.back.compartments) {
        if (compartment.rebaseStatus === "unresolved") continue;
        expect(byOrdinal.get(compartment.endMessage)).toBe(compartment.endMessageId ?? undefined);
    }
});

/**
 * Range recovery for a compartment the way back could not re-anchor is refused,
 * the compartment that DID re-anchor reaches the wire at its re-derived
 * ordinals, and the unresolved one STILL renders into `<session-history>`: its
 * summary is the history and does not depend on the raw rows (a host prunes
 * those routinely, so on a real store most old compartments have no resolvable
 * anchor at all). Only its coordinates are stale, which the ctx_expand refusal
 * covers. An earlier version of this lane asserted the opposite and the
 * corresponding reader filter would have dropped most of a long session's
 * history at the flip.
 */
test("the unresolved range is refused by ctx_expand and both compartments are served", () => {
    expect(evidence.expandRefusal).toMatch(
        /entirely within the live tail|No messages found in range/,
    );
    // A refusal, not a recovery: no raw transcript came back for that range.
    expect(evidence.expandRefusal).not.toMatch(/\(\d+ messages, ~\d+ tokens\)/);
    expect(evidence.servedHeadBack).toContain("<session-history>");
    expect(evidence.resolvedHeading).not.toBe("");
    expect(evidence.unresolvedHeading).not.toBe(evidence.resolvedHeading);
    expect(evidence.servedHeadBack).toContain(evidence.resolvedHeading);
    expect(evidence.unresolvedHeading).not.toBe("");
    expect(evidence.servedHeadBack).toContain(evidence.unresolvedHeading);
});

test("the way back serves exactly one first-render HARD across the flip and follow-ups", () => {
    expect(evidence.back.pins).toHaveLength(5);
    expect(new Set(evidence.back.pins.slice(1)).size).toBe(1);
    const folds = evidence.back.folds.slice(0, 5);
    expect(folds).toHaveLength(5);
    expect(folds.map((fold) => fold.rematerialized)).toEqual([true, false, false, false, false]);
    const flipAndTwoFollowUps = folds.slice(0, 3);
    expect(flipAndTwoFollowUps.map((fold) => fold.reason)).toEqual([
        "first_render",
        "cache_hit",
        "cache_hit",
    ]);
    expect(
        flipAndTwoFollowUps.filter((fold) => fold.rematerialized).map((fold) => fold.reason),
    ).toEqual(["first_render"]);
});

test("doctor reports the compartments the way back could not re-anchor", () => {
    expect(evidence.doctorAfter).toMatch(
        /compartment\(s\) across \d+ session\(s\) could not be re-anchored/,
    );
    const unresolved = /(\d+) compartment\(s\) across/.exec(evidence.doctorAfter);
    expect(unresolved).not.toBeNull();
    expect(Number(unresolved![1])).toBeGreaterThanOrEqual(1);
    expect(evidence.doctorAfter).toContain(`session=${evidence.sessionId}`);
});
