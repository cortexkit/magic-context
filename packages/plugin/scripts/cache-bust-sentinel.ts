#!/usr/bin/env bun
import { Database } from "bun:sqlite";
/**
 * Read-only cache-bust detector for the OpenCode and Pi/OMP harnesses.
 *
 * Classification rule table (first matching rule wins):
 * | divergence_class | accounted | rule |
 * | --- | --- | --- |
 * | cache_scope_changed | yes | the model named in the request or the account changed, or the provider reports model_changed; the request reads a different cache, so it never wakes and is not a second rewrite |
 * | host_messages_removed | yes | the host logged message.removed for this session between requests; a user revert changes the prefix independently of Magic Context and never wakes, even after a reclaim |
 * | system_row_shift | yes | message[0]/system divergence rewrites less than 5% of the prompt |
 * | no_mc_pass_row | no | no MC pass record in [request - 30 s, request + 5 s] |
 * | accounted_ctx_flush | yes | matched pass records an explicit /ctx-flush |
 * | accounted_force_band | yes | matched pass records a forced emergency drop batch |
 * | accounted_hard_marker_drain | yes | matched HARD/m0 pass records marker_drain or a compaction-marker seam |
 * | accounted_hard_model_change | yes | matched HARD/m0 pass records materialize_reason=model_change |
 * | accounted_hard_system_hash | yes | matched HARD/m0 pass records system_hash, or a large system-prompt replacement |
 * | accounted_hard_epoch | yes | matched HARD/m0 pass records a project, render, or session epoch change |
 * | accounted_hard_pressure_refold | yes | matched HARD/m0 pass records materialize_reason=pressure_refold |
 * | accounted_hard_fold | yes | matched pass records another materialized HARD/m0 fold; tiny mid-history defer/first_render seams are excluded |
 * | accounted_tag_identity_repair | yes | matched pass records materialize_reason=tag_identity_repair (Pi kept the newest of two tag numbers for one call or message and rebuilt once) |
 * | accounted_ctx_reduce | yes | matched pass applies drops at an agent ctx_reduce landing |
 * | accounted_drop_applied | yes | matched pass records applied drops |
 * | accounted_soft_m1_execute | yes | matched canonical execute pass refreshes m1 |
 * | usage_missing | yes | provider cache read and direct input are both 0 or usage is absent; in-flight/unmetered pass is never a bust baseline |
 * | provider_full_miss | yes | provider cache read is exactly 0 with prevTotal ≥ 10,000; ordinary short reads stay unaccounted; show wire model prev → cur when it changes |
 * | accounted_lkg_frozen_release | yes | matched pass records why it stopped serving the frozen last-known-good request in materialize_reason |
 * | unaccounted_defer_pass | no | matched canonical defer pass, including a tiny mid-history first_render seam, diverges |
 * | accounted_provider_system_prompt_change | yes | matched non-defer pass has a user-visible provider change |
 * | unaccounted_double_bust | no | matched otherwise-unattributed pass repeats the previous divergence offset |
 * | unaccounted_tail_rewrite | no | matched otherwise-unattributed pass rewrites the previous request tail |
 * | unaccounted_rewrite | no | matched pass has no accounted attribution |
 * | provider_short_read_after_reclaim | no | overrides provider_short_read_identical_bytes right after a reclaim bust: the bytes extend the reclaim request, but the provider did not serve its prefix (provider-side; one crossing billed twice) |
 * | double_bust_after_reclaim | no | overrides any other accounted class right after a reclaim bust; the wake names the overridden class as cause |
 * | continuation_short_read | yes | messages are deltas and the full system/tools prefix is unchanged; never wakes, including right after a reclaim bust |
 * | thread_break_unchanged_client_bytes | conditional | earlier full body and sent client deltas match; wakes only when the window rewrites at least 20,000 tokens, otherwise persists a suppressed observation; only this class and full_body_no_baseline contribute tokens |
 * | full_body_no_baseline | conditional | no earlier full body is available for comparison; the same 20,000-thread-token window threshold applies |
 *
 * A reclaim bust is a rebuild Magic Context makes on purpose to drop or summarize
 * content: a fold, a flush or a batch of drops. A second rewrite right after one
 * means a single threshold crossing was billed twice.
 *
 * Wakes expire after 30 minutes: older findings cannot guide a live repair. A
 * resumed session starts no earlier than that wake-age horizon; unseen windows
 * outside it are neither read nor summarized. Discovered windows that expire
 * before delivery persist as stale observations instead of waking the operator.
 *
 * By default the process stays alive and scans every 60 seconds. Use --once from
 * launchd/cron or for a manual pass. Without --send, each new event is printed
 * as one JSON line and nothing is sent. With --send, the sentinel connects to
 * subc (the CortexKit module daemon) and asks the prefrontal-core module, which
 * delivers agent messages, to send each event as a high-urgency peer message.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type ManagedCallOptions, SubcClient } from "@cortexkit/subc-client";

import { loadPluginConfig } from "../src/config";
import { getDataDir, getMagicContextStorageDir } from "../src/shared/data-path";
import {
    setStoragePrivatePermissionEnforcement,
    writeStorageFileAtomicSync,
} from "../src/shared/storage-permissions";
import { resolveOpenCodeDbPath } from "../src/shared/opencode-db-path";
import { analyzeOpenCodeCacheBustSession, createOpenCodeDumpScanIndex } from "./analyze-cache-busts";
import type { DumpScanIndex, DumpScanMetrics } from "./cache-bust-dump-index";
import {
    type AnalyzedCacheRequest,
    type CacheBustDecisionAttribution,
    type CacheBustDivergenceClass,
    type CacheBustSessionAnalysis,
    classifyBustAfterReclaim,
    isUnaccountedCacheBustClass,
    isThresholdedThreadClass,
} from "./cache-bust-attribution";
import { type CacheBustScanProgress, parseScanCursor } from "./cache-bust-scan";
import { DEFAULT_RUNNER_DATA_DIR } from "./cache-bust-runner-sources";
import { AstrocyteRunnerMeterSource, type RunnerMeterSource } from "./cache-bust-runner-feed";
import { emptyRunnerState, headsWithoutMeter, loadRunnerHeads, parseRunnerMonitorState, pruneRunnerState, scanRunnerFeed, type RunnerHeads, type RunnerMonitorState, type RunnerRunSummary } from "./cache-bust-runner-monitor";

const STATE_VERSION = 1;
const BUST_WINDOW_MS = 120_000;
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LOOKBACK_MS = 5 * 60_000;
export const DEFAULT_MAX_WAKE_AGE_MS = 30 * 60_000;
const IDLE_SESSION_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_WAKE_MODULE_ID = "prefrontal-core";
const DEFAULT_WAKE_AGENT_ID = "agent_b613e5cf2ee55b8c";
const DEFAULT_WAKE_FROM_AGENT = "mc-cache-bust-sentinel";
const SENTINEL_FROM_SESSION_ID = "health-sentinel-mc";
const SENTINEL_FROM_HARNESS = "magic-context";
const AGENT_DELIVER_METHOD = "agent.deliver";
const PI_ANALYZER_MODULE = "../../pi-plugin/scripts/analyze-pi-cache-busts";

export type CacheBustHarness = "opencode" | "pi";

export interface CacheBustSentinelOptions {
    once: boolean;
    send: boolean;
    intervalMs: number;
    lookbackMs: number;
    maxWakeAgeMs?: number;
    maxRunMs?: number;
    stateFile: string;
    databasePath: string;
    rustStorePath: string;
    connectionFile: string;
    wakeModuleId: string;
    wakeAgentId: string;
    wakeFromAgent: string;
    mcLogPath?: string;
    anthropicDir?: string;
    openaiDir?: string;
    piDir?: string;
    ompDir?: string;
    ledgerDir?: string;
    bodiesDir?: string;
    runnerDataDir?: string;
}

interface SentinelScanOptions extends CacheBustSentinelOptions {
    scanCursor?: string;
    scanDeadlineMs?: number;
    scanNow?: () => number;
    scanMetrics?: DumpScanMetrics;
    scanIndex?: DumpScanIndex;
}

export interface ActiveCacheBustSession {
    sessionId: string;
    harness: CacheBustHarness;
    projectPath: string;
    activityMs: number;
    directory?: string;
}

export interface CacheBustEvent {
    source_module: "magic-context";
    kind: "cache_bust";
    vendor_event_id: string;
    supersedes?: string;
    session_id: string;
    directory: string;
    occurred_at_ms: number;
    urgency?: "normal" | "high";
    payload: {
        session: string;
        at: string;
        rewritten_tokens: number;
        divergence_class: string;
        first_divergence: string;
        analyzer_cmd: string;
        /** Render-identity components the matched pass changed, when it logged them. */
        identity_delta?: string[];
        /** For a bust right after a reclaim: the class the request had on its own. */
        cause?: string;
    };
}

export interface AgentDeliverRequest {
    agent_id: string;
    delivery_id: string;
    body: {
        kind: "peer_message";
        from_agent: string;
        from_session_id: "health-sentinel-mc";
        from_harness: "magic-context";
        content: string;
        /** The sender is a script with no session, so replies cannot reach it. */
        one_way: true;
    };
    urgency: "high" | "normal";
    expected_residence_epoch?: number;
}

export interface AgentDeliverReply {
    disposition: "delivered" | "queued";
    committed_order: number;
}

export type AgentDeliverOutcome =
    | (AgentDeliverReply & { accepted: true; contractViolation?: true })
    | (AgentDeliverReply & { accepted: false; reason: "dedup" });

export interface CacheBustTransport {
    record(event: CacheBustEvent, timeoutMs?: number): Promise<unknown>;
    recordLag?(notice: { deliveryId: string; content: string }, timeoutMs?: number): Promise<unknown>;
    close?(): void | Promise<void>;
}

interface OpenBustWindowState {
    startMs: number;
    /** Stable delivery identity when backfill discovers an earlier window start. */
    eventStartMs?: number;
    lastBustMs: number;
    /**
     * Class of the newest bust in the window. A bust in the next run that
     * continues the window is judged against it, because that earlier row is no
     * longer among the rows the next run analyzes.
     */
    lastBustClass?: string;
    /** Only thresholded thread findings contribute to the carried window total. */
    threadRewrittenTokens?: number;
}

interface SessionWatermarkState {
    lastAnalyzedRequestTimestampMs: number;
    openWindow?: OpenBustWindowState;
    /** Earliest partial streak in a newest-first batch, used when backfilling its beginning. */
    backfillWindow?: OpenBustWindowState;
    scanCursor?: string;
    /** When a run last analyzed this session; orders sessions so none is starved. */
    lastScannedAtMs?: number;
    pendingFiles?: number;
    oldestPendingTimestampMs?: number;
}

interface SentWindowState {
    divergenceClass: string;
    lastEventId: string;
    eventIds: string[];
}

interface SentDeliveryState {
    disposition: AgentDeliverReply["disposition"];
    committedOrder: number;
}

export interface CacheBustSentinelState {
    version: 1;
    sessions: Record<string, SessionWatermarkState>;
    windows: Record<string, SentWindowState>;
    deliveries: Record<string, SentDeliveryState>;
    suppressedWindows: Record<string, { divergenceClass: string; rewrittenTokens: number; windowStartMs?: number; reason?: "stale" }>;
    lag?: { startedAtMs: number; consecutiveRuns: number; notified: boolean; lagMs: number; pendingFiles: number };
    runner?: RunnerMonitorState;
}

export interface BustWindow {
    sessionId: string;
    startMs: number;
    eventStartMs?: number;
    lastBustMs: number;
    rows: AnalyzedCacheRequest[];
    precedingThreadRewrittenTokens?: number;
}

export interface SentinelCounters {
    sessions: number;
    requests: number;
    bustWindows: number;
    accountedWindows: number;
    unaccountedWindows: number;
    skippedSeen: number;
    dryRun: number;
    accepted: number;
    dedup: number;
    sendRefused: number;
    filesExamined: number;
    bounded: boolean;
    runner?: RunnerRunSummary;
}

interface SentinelRunDeps {
    scanMetrics?: DumpScanMetrics;
    now?: () => number;
    listActiveSessions?: (
        state: CacheBustSentinelState,
        nowMs: number,
        options: CacheBustSentinelOptions,
    ) => ActiveCacheBustSession[];
    analyzeSession?: (
        session: ActiveCacheBustSession,
        sinceExclusiveMs: number,
        decisions: readonly CacheBustDecisionAttribution[],
        options: SentinelScanOptions,
    ) => Promise<CacheBustSessionAnalysis & CacheBustScanProgress>;
    loadDecisions?: (
        session: ActiveCacheBustSession,
        options: CacheBustSentinelOptions,
    ) => CacheBustDecisionAttribution[];
    transport?: CacheBustTransport;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    runnerSource?: RunnerMeterSource;
    runnerHeads?: RunnerHeads;
}

export class CacheBustSentinelInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CacheBustSentinelInputError";
    }
}

function defaultState(): CacheBustSentinelState {
    return { version: STATE_VERSION, sessions: {}, windows: {}, deliveries: {}, suppressedWindows: {} };
}

function maxWakeAgeMsFor(options: Pick<CacheBustSentinelOptions, "maxWakeAgeMs">): number {
    return options.maxWakeAgeMs ?? DEFAULT_MAX_WAKE_AGE_MS;
}

function pruneIdleSessionState(state: CacheBustSentinelState, runStartMs: number): void {
    // Keep delivery IDs and observations of suppressed cache-bust streaks even
    // after forgetting idle progress; rediscovering a session must not repeat
    // an agent notification.
    for (const [sessionId, session] of Object.entries(state.sessions)) {
        if (!session.scanCursor && !session.pendingFiles && !session.openWindow && !session.backfillWindow &&
            (session.lastScannedAtMs === undefined || session.lastScannedAtMs < runStartMs - IDLE_SESSION_RETENTION_MS)) {
            delete state.sessions[sessionId];
        }
    }
}

function finiteNonnegative(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function loadSentinelState(path: string): CacheBustSentinelState {
    if (!existsSync(path)) return defaultState();
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        throw new CacheBustSentinelInputError(`invalid sentinel state JSON at ${path}: ${error}`);
    }
    const root = recordValue(parsed);
    const sessions = recordValue(root?.sessions);
    const windows = recordValue(root?.windows);
    const deliveries = root?.deliveries === undefined ? {} : recordValue(root.deliveries);
    const suppressed = root?.suppressedWindows === undefined ? {} : recordValue(root.suppressedWindows);
    if (root?.version !== STATE_VERSION || !sessions || !windows || !deliveries || !suppressed) {
        throw new CacheBustSentinelInputError(`unsupported sentinel state at ${path}`);
    }

    const state = defaultState();
    for (const [sessionId, raw] of Object.entries(sessions)) {
        const row = recordValue(raw);
        const highWater = finiteNonnegative(row?.lastAnalyzedRequestTimestampMs);
        if (highWater === undefined) {
            throw new CacheBustSentinelInputError(
                `invalid high-water mark for session ${sessionId} in ${path}`,
            );
        }
        const open = recordValue(row?.openWindow);
        const startMs = finiteNonnegative(open?.startMs);
        const lastBustMs = finiteNonnegative(open?.lastBustMs);
        const lastBustClass =
            typeof open?.lastBustClass === "string" ? open.lastBustClass : undefined;
        const lastScannedAtMs = finiteNonnegative(row?.lastScannedAtMs);
        const backfill = recordValue(row?.backfillWindow);
        const backfillStart = finiteNonnegative(backfill?.startMs);
        const backfillEnd = finiteNonnegative(backfill?.lastBustMs);
        state.sessions[sessionId] = {
            lastAnalyzedRequestTimestampMs: highWater,
            ...(open && startMs !== undefined && lastBustMs !== undefined
                ? {
                      openWindow: {
                           startMs,
                           ...(finiteNonnegative(open.eventStartMs) !== undefined ? { eventStartMs: open.eventStartMs as number } : {}),
                          lastBustMs,
                          ...(lastBustClass ? { lastBustClass } : {}),
                           ...(finiteNonnegative(open.threadRewrittenTokens) !== undefined ? { threadRewrittenTokens: open.threadRewrittenTokens as number } : {}),
                      },
                  }
                : {}),
            ...(typeof row?.scanCursor === "string" ? { scanCursor: row.scanCursor } : {}),
            ...(lastScannedAtMs !== undefined ? { lastScannedAtMs } : {}),
            ...(backfillStart !== undefined && backfillEnd !== undefined ? { backfillWindow: {
                startMs: backfillStart, lastBustMs: backfillEnd,
                ...(finiteNonnegative(backfill?.eventStartMs) !== undefined ? { eventStartMs: backfill!.eventStartMs as number } : {}),
                ...(finiteNonnegative(backfill?.threadRewrittenTokens) !== undefined ? { threadRewrittenTokens: backfill!.threadRewrittenTokens as number } : {}),
            } } : {}),
            ...(finiteNonnegative(row?.pendingFiles) !== undefined ? { pendingFiles: row!.pendingFiles as number } : {}),
            ...(finiteNonnegative(row?.oldestPendingTimestampMs) !== undefined ? { oldestPendingTimestampMs: row!.oldestPendingTimestampMs as number } : {}),
        };
    }
    for (const [key, raw] of Object.entries(windows)) {
        const row = recordValue(raw);
        if (
            typeof row?.divergenceClass !== "string" ||
            typeof row.lastEventId !== "string" ||
            !Array.isArray(row.eventIds) ||
            !row.eventIds.every((id) => typeof id === "string")
        ) {
            throw new CacheBustSentinelInputError(`invalid window state ${key} in ${path}`);
        }
        state.windows[key] = {
            divergenceClass: row.divergenceClass,
            lastEventId: row.lastEventId,
            eventIds: [...row.eventIds],
        };
    }
    for (const [key, raw] of Object.entries(suppressed)) {
        const row = recordValue(raw);
        const rewrittenTokens = finiteNonnegative(row?.rewrittenTokens);
        const stale = row?.reason === "stale" && finiteNonnegative(row.windowStartMs) !== undefined;
        if (typeof row?.divergenceClass !== "string" || (!stale && !isThresholdedThreadClass(row.divergenceClass)) || rewrittenTokens === undefined) {
            throw new CacheBustSentinelInputError(`invalid suppressed window state ${key} in ${path}`);
        }
        state.suppressedWindows[key] = { divergenceClass: row.divergenceClass, rewrittenTokens,
            ...(stale ? { reason: "stale", windowStartMs: row.windowStartMs as number } as const : {}) };
    }
    if (root.lag !== undefined) {
        const lag = recordValue(root.lag);
        if (!lag || finiteNonnegative(lag.startedAtMs) === undefined || finiteNonnegative(lag.consecutiveRuns) === undefined ||
            typeof lag.notified !== "boolean" || finiteNonnegative(lag.lagMs) === undefined || finiteNonnegative(lag.pendingFiles) === undefined) {
            throw new CacheBustSentinelInputError(`invalid lag state in ${path}`);
        }
        state.lag = lag as unknown as NonNullable<CacheBustSentinelState["lag"]>;
    }
    if (root.runner !== undefined) state.runner = parseRunnerMonitorState(root.runner);
    for (const [deliveryId, raw] of Object.entries(deliveries)) {
        const row = recordValue(raw);
        const committedOrder = finiteNonnegative(row?.committedOrder);
        if (
            (row?.disposition !== "delivered" && row?.disposition !== "queued") ||
            committedOrder === undefined ||
            !Number.isSafeInteger(committedOrder)
        ) {
            throw new CacheBustSentinelInputError(
                `invalid delivery state ${deliveryId} in ${path}`,
            );
        }
        state.deliveries[deliveryId] = {
            disposition: row.disposition,
            committedOrder,
        };
    }
    return state;
}

export function saveSentinelState(path: string, state: CacheBustSentinelState): void {
    writeStorageFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function parsePositiveInteger(value: string | undefined, flag: string): number {
    const parsed = value === undefined ? Number.NaN : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new CacheBustSentinelInputError(`${flag} requires a positive integer`);
    }
    return parsed;
}

export function parseSentinelArgs(argv: string[]): CacheBustSentinelOptions {
    const args = argv.slice(2);
    const valueFlags = new Set([
        "--interval-ms",
        "--lookback-ms",
        "--max-wake-age-ms",
        "--max-run-ms",
        "--state-file",
        "--db",
        "--rust-store",
        "--connection-file",
        "--wake-module-id",
        "--wake-agent-id",
        "--wake-from-agent",
        "--anthropic-dir",
        "--mc-log",
        "--openai-dir",
        "--pi-dir",
        "--omp-dir",
        "--ledger-dir",
        "--bodies-dir",
        "--runner-data-dir",
    ]);
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--once" || arg === "--send") continue;
        if (!valueFlags.has(arg)) {
            throw new CacheBustSentinelInputError(`unknown argument: ${arg}`);
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
            throw new CacheBustSentinelInputError(`${arg} requires a value`);
        }
        values.set(arg, value);
        index += 1;
    }
    const storageDir = getMagicContextStorageDir();
    const intervalMs = values.has("--interval-ms")
        ? parsePositiveInteger(values.get("--interval-ms"), "--interval-ms")
        : DEFAULT_INTERVAL_MS;
    if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
        throw new CacheBustSentinelInputError(
            `--interval-ms must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`,
        );
    }
    const lookbackMs = values.has("--lookback-ms")
        ? parsePositiveInteger(values.get("--lookback-ms"), "--lookback-ms")
        : DEFAULT_LOOKBACK_MS;
    return {
        once: args.includes("--once"),
        send: args.includes("--send"),
        intervalMs,
        lookbackMs,
        maxWakeAgeMs: values.has("--max-wake-age-ms")
            ? parsePositiveInteger(values.get("--max-wake-age-ms"), "--max-wake-age-ms")
            : maxWakeAgeMsFor({}),
        maxRunMs: values.has("--max-run-ms")
            ? parsePositiveInteger(values.get("--max-run-ms"), "--max-run-ms")
            : 30_000,
        stateFile: values.get("--state-file") ?? join(storageDir, "cache-bust-sentinel-state.json"),
        databasePath: values.get("--db") ?? join(storageDir, "context.db"),
        rustStorePath: values.get("--rust-store") ?? join(storageDir, "store.db"),
        connectionFile:
            values.get("--connection-file") ??
            join(getDataDir(), "cortexkit", "run", "subc-connection.json"),
        wakeModuleId: values.get("--wake-module-id") ?? DEFAULT_WAKE_MODULE_ID,
        wakeAgentId: values.get("--wake-agent-id") ?? DEFAULT_WAKE_AGENT_ID,
        wakeFromAgent: values.get("--wake-from-agent") ?? DEFAULT_WAKE_FROM_AGENT,
        anthropicDir: values.get("--anthropic-dir"),
        mcLogPath: values.get("--mc-log"),
        openaiDir: values.get("--openai-dir"),
        piDir: values.get("--pi-dir"),
        ompDir: values.get("--omp-dir"),
        ledgerDir: values.get("--ledger-dir"),
        bodiesDir: values.get("--bodies-dir"),
        runnerDataDir: values.get("--runner-data-dir") ?? DEFAULT_RUNNER_DATA_DIR,
    };
}

function tableExists(db: Database, table: string): boolean {
    return Boolean(
        db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
}

export function enumerateActiveSessions(
    state: CacheBustSentinelState,
    nowMs: number,
    options: CacheBustSentinelOptions,
): ActiveCacheBustSession[] {
    if (!existsSync(options.databasePath)) return [];
    const wakeHorizonMs = nowMs - maxWakeAgeMsFor(options);
    const db = new Database(options.databasePath, { readonly: true });
    try {
        if (!tableExists(db, "session_projects") || !tableExists(db, "session_meta")) return [];
        const rows = db
            .query(
                `SELECT sp.session_id, sp.harness, sp.project_path, sp.updated_at,
                        sm.last_response_time
                   FROM session_projects sp
                   JOIN session_meta sm
                     ON sm.session_id = sp.session_id AND sm.harness = sp.harness
                  WHERE sp.harness IN ('opencode', 'pi')`,
            )
            .all() as Array<Record<string, unknown>>;
        return rows.flatMap((row) => {
            const sessionId = typeof row.session_id === "string" ? row.session_id : "";
            const harness = row.harness === "opencode" || row.harness === "pi" ? row.harness : null;
            const projectPath = typeof row.project_path === "string" ? row.project_path : "";
            const activityMs = Math.max(
                finiteNonnegative(row.updated_at) ?? 0,
                finiteNonnegative(row.last_response_time) ?? 0,
            );
            if (!sessionId || !harness || !projectPath) return [];
            const since =
                state.sessions[sessionId]?.lastAnalyzedRequestTimestampMs ??
                nowMs - options.lookbackMs;
            // A completed session's last activity can outlive its last request;
            // only recent activity or unfinished scans justify another batch.
            return activityMs > Math.max(since, wakeHorizonMs) || state.sessions[sessionId]?.scanCursor
                ? [{ sessionId, harness, projectPath, activityMs }] : [];
        });
    } finally {
        db.close(false);
    }
}

export function loadSessionDecisions(
    session: ActiveCacheBustSession,
    options: CacheBustSentinelOptions,
): CacheBustDecisionAttribution[] {
    const records: CacheBustDecisionAttribution[] = [];
    const stringField = (row: Record<string, unknown>, ...keys: string[]): string | undefined => {
        for (const key of keys) {
            if (typeof row[key] === "string" && row[key]) return row[key] as string;
        }
        return undefined;
    };
    const numberField = (row: Record<string, unknown>, ...keys: string[]): number | undefined => {
        for (const key of keys) {
            const value = finiteNonnegative(row[key]);
            if (value !== undefined) return value;
        }
        return undefined;
    };
    const booleanField = (row: Record<string, unknown>, ...keys: string[]): boolean =>
        keys.some((key) => row[key] === true || row[key] === 1 || row[key] === "true");
    const stringListField = (
        row: Record<string, unknown>,
        ...keys: string[]
    ): string[] | undefined => {
        for (const key of keys) {
            const value = row[key];
            if (Array.isArray(value)) {
                const strings = value.filter(
                    (entry): entry is string => typeof entry === "string" && entry.length > 0,
                );
                if (strings.length > 0) return strings;
            }
            if (typeof value !== "string" || value.length === 0) continue;
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) {
                    const strings = parsed.filter(
                        (entry): entry is string =>
                            typeof entry === "string" && entry.length > 0,
                    );
                    if (strings.length > 0) return strings;
                }
            } catch {
                const strings = value.split(",").filter(Boolean);
                if (strings.length > 0) return strings;
            }
        }
        return undefined;
    };
    const normalize = (
        row: Record<string, unknown>,
        source: string,
    ): CacheBustDecisionAttribution | undefined => {
        if (
            typeof row.harness === "string" &&
            row.harness !== session.harness &&
            !(
                session.harness === "pi" &&
                (row.harness === "omp" || row.harness === "opencode")
            )
        ) {
            return undefined;
        }
        const timestampMs = numberField(
            row,
            "pass_timestamp_ms",
            "timestamp_ms",
            "ts_ms",
            "last_received_at_ms",
        );
        if (timestampMs === undefined) return undefined;
        const persistedMaterializeReason = stringField(
            row,
            "materialize_reason",
            "materialization_reason",
            "fold_reason",
            "hard_reason",
        );
        const releaseMarkerPrefix = "lkg_frozen_release:";
        const releaseAndMaterializeReasons = persistedMaterializeReason?.startsWith(
            releaseMarkerPrefix,
        )
            ? persistedMaterializeReason.slice(releaseMarkerPrefix.length)
            : "";
        const hasLkgFrozenRelease = persistedMaterializeReason?.startsWith(
            releaseMarkerPrefix,
        ) ?? false;
        const materializeReasonSeparator = releaseAndMaterializeReasons.indexOf(
            ";materialize_reason=",
        );
        const lkgFrozenReleaseReason = hasLkgFrozenRelease
            ? (materializeReasonSeparator < 0
                  ? releaseAndMaterializeReasons
                  : releaseAndMaterializeReasons.slice(0, materializeReasonSeparator)) || undefined
            : undefined;
        const materializeReason = hasLkgFrozenRelease
            ? materializeReasonSeparator < 0
                ? null
                : releaseAndMaterializeReasons.slice(
                      materializeReasonSeparator + ";materialize_reason=".length,
                  ) || null
            : persistedMaterializeReason ?? null;
        const appliedDrops = numberField(
            row,
            "applied_drop_count",
            "applied_drops",
            "applied_supersession_count",
            "dropped_count",
        );
        return {
            timestampMs,
            requestObservedAtMs: numberField(row, "request_observed_at_ms", "request_observed_at"),
            messageId: stringField(row, "message_id", "assistant_message_id"),
            decision:
                stringField(row, "decision", "scheduler_decision", "canonical_decision") ??
                "unknown",
            canonicalDecision: stringField(row, "canonical_decision"),
            deferReason: stringField(row, "defer_reason") ?? null,
            appliedRide: stringField(row, "applied_ride", "reclaim_ride"),
            lkgFrozenReleaseReason,
            materialized:
                booleanField(row, "materialized", "m0_materialized", "fold_applied") ||
                materializeReason !== null,
            materializeReason,
            emergency: booleanField(row, "emergency", "drain_latch_active", "force_band"),
            droppedTokens: numberField(row, "dropped_tokens", "applied_drop_tokens") ?? 0,
            droppedCount: appliedDrops ?? 0,
            inputTokens: numberField(row, "input_tokens", "prompt_tokens") ?? 0,
            inputCount: numberField(row, "oc_input", "input_count"),
            externalEpoch: booleanField(
                row,
                "restart_epoch",
                "deploy_epoch",
                "config_epoch",
                "external_epoch",
            ),
            identityDelta: stringListField(row, "identity_delta", "render_identity_delta"),
            flush:
                booleanField(row, "flush", "flush_applied", "explicit_flush") ||
                materializeReason === "explicit_flush" || materializeReason === "user_flush",
            source,
        };
    };
    const addRows = (rows: readonly Record<string, unknown>[], source: string): void => {
        for (const row of rows) {
            const normalized = normalize(row, source);
            if (normalized) records.push(normalized);
        }
    };
    const readTable = (db: Database, table: string, source: string): void => {
        if (!tableExists(db, table)) return;
        const columns = new Set(
            (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>).flatMap(
                (row) => (typeof row.name === "string" ? [row.name] : []),
            ),
        );
        if (!columns.has("session_id")) return;
        addRows(
            db.query(`SELECT * FROM ${table} WHERE session_id = ?`).all(session.sessionId) as Array<
                Record<string, unknown>
            >,
            source,
        );
    };
    const readTraceHistory = (db: Database, source: string): void => {
        if (!tableExists(db, "mc_pass_trace")) return;
        const rows = db
            .query("SELECT * FROM mc_pass_trace WHERE session_id = ?")
            .all(session.sessionId) as Array<Record<string, unknown>>;
        addRows(rows, source);
        if (rows.length === 0) return;
        // Store migration 63 moved the histories into ring rows and dropped the array columns;
        // its read-only view rebuilds each session's arrays in sequence order. Older stores
        // still carry the columns on the trace row itself.
        const ringView = Boolean(
            db
                .query(
                    "SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'mc_pass_trace_history_arrays'",
                )
                .get(),
        );
        const histories = ringView
            ? (db
                  .query(
                      "SELECT scheduler_history, scheduler_interesting_history FROM mc_pass_trace_history_arrays WHERE session_id = ?",
                  )
                  .all(session.sessionId) as Array<Record<string, unknown>>)
            : rows.filter(
                  (row) =>
                      typeof row.scheduler_history === "string" ||
                      typeof row.scheduler_interesting_history === "string",
              );
        if (histories.length === 0) {
            // Reading zero decisions here would look like a quiet session, not a schema the
            // sentinel no longer understands.
            throw new CacheBustSentinelInputError(
                `${source} has a trace row for ${session.sessionId} but neither ring-row histories nor history columns`,
            );
        }
        for (const row of histories) {
            for (const column of ["scheduler_history", "scheduler_interesting_history"] as const) {
                if (typeof row[column] !== "string") continue;
                try {
                    const history = JSON.parse(row[column] as string);
                    if (Array.isArray(history)) {
                        addRows(
                            history.filter((entry): entry is Record<string, unknown> =>
                                Boolean(recordValue(entry)),
                            ),
                            `${source}.${column}`,
                        );
                    }
                } catch {
                    // A malformed diagnostic history is ignored; the mirrored table can still join.
                }
            }
        }
    };
    const readStore = (path: string, source: string, includeTrace: boolean): void => {
        if (!existsSync(path)) return;
        const db = new Database(path, { readonly: true });
        try {
            readTable(db, "transform_decisions", `${source}.transform_decisions`);
            readTable(db, "scheduler_history", `${source}.scheduler_history`);
            if (includeTrace) readTraceHistory(db, `${source}.mc_pass_trace`);
        } finally {
            db.close(false);
        }
    };

    readStore(options.databasePath, "context.db", false);
    if (options.rustStorePath !== options.databasePath) {
        readStore(options.rustStorePath, "store.db", true);
    }

    records.sort((left, right) => left.timestampMs - right.timestampMs);
    const merged: CacheBustDecisionAttribution[] = [];
    for (const record of records) {
        const prior = merged.at(-1);
        if (prior && Math.abs(prior.timestampMs - record.timestampMs) <= 500) {
            prior.requestObservedAtMs ??= record.requestObservedAtMs;
            prior.messageId ??= record.messageId;
            prior.canonicalDecision ??= record.canonicalDecision;
            prior.deferReason ??= record.deferReason;
            prior.appliedRide ??= record.appliedRide;
            prior.lkgFrozenReleaseReason ??= record.lkgFrozenReleaseReason;
            prior.materialized ||= record.materialized;
            prior.materializeReason ??= record.materializeReason;
            prior.emergency ||= record.emergency;
            prior.droppedTokens = Math.max(prior.droppedTokens, record.droppedTokens);
            prior.droppedCount = Math.max(prior.droppedCount, record.droppedCount);
            prior.inputTokens = Math.max(prior.inputTokens, record.inputTokens);
            prior.inputCount ??= record.inputCount;
            prior.externalEpoch ||= record.externalEpoch;
            prior.identityDelta ??= record.identityDelta;
            prior.flush ||= record.flush;
            prior.source = `${prior.source}+${record.source}`;
            continue;
        }
        merged.push({ ...record });
    }
    return merged;
}

function openCodeSessionDirectory(sessionId: string): string | undefined {
    const resolution = resolveOpenCodeDbPath();
    if (!existsSync(resolution.path)) return undefined;
    const db = new Database(resolution.path, { readonly: true });
    try {
        if (!tableExists(db, "session")) return undefined;
        const columns = new Set(
            (db.query("PRAGMA table_info(session)").all() as Array<{ name?: unknown }>).flatMap(
                (row) => (typeof row.name === "string" ? [row.name] : []),
            ),
        );
        if (columns.has("directory")) {
            const row = db
                .query("SELECT directory FROM session WHERE id = ?")
                .get(sessionId) as Record<string, unknown> | null;
            if (typeof row?.directory === "string" && row.directory) return row.directory;
        }
        if (columns.has("data")) {
            const row = db.query("SELECT data FROM session WHERE id = ?").get(sessionId) as Record<
                string,
                unknown
            > | null;
            if (typeof row?.data === "string") {
                const data = recordValue(JSON.parse(row.data));
                if (typeof data?.directory === "string" && data.directory) return data.directory;
            }
        }
        return undefined;
    } catch {
        return undefined;
    } finally {
        db.close(false);
    }
}

async function runPiAnalyzer(options: {
    sessionId: string;
    sinceExclusiveMs: number;
    untilInclusiveMs: number;
    piDir?: string;
    ompDir?: string;
    ledgerDir?: string;
    bodiesDir?: string;
    decisions: readonly CacheBustDecisionAttribution[];
}): Promise<CacheBustSessionAnalysis> {
    const module = (await import(PI_ANALYZER_MODULE)) as {
        analyzePiCacheBustSession(input: typeof options): Promise<CacheBustSessionAnalysis>;
    };
    return await module.analyzePiCacheBustSession(options);
}

async function analyzeActiveSession(
    session: ActiveCacheBustSession,
    sinceExclusiveMs: number,
    decisions: readonly CacheBustDecisionAttribution[],
    options: SentinelScanOptions,
): Promise<CacheBustSessionAnalysis & CacheBustScanProgress> {
    if (session.harness === "opencode") {
        const analysis = analyzeOpenCodeCacheBustSession({
            sessionId: session.sessionId,
            sinceExclusiveMs,
            untilInclusiveMs: Date.now(),
            scanCursor: options.scanCursor,
            scanDeadlineMs: options.scanDeadlineMs,
            scanNow: options.scanNow,
            scanMetrics: options.scanMetrics,
            scanIndex: options.scanIndex,
            anthropicDir: options.anthropicDir,
            mcLogPath: options.mcLogPath,
            openaiDir: options.openaiDir,
            decisions,
        });
        return {
            ...analysis,
            directory: session.directory ?? openCodeSessionDirectory(session.sessionId),
        };
    }
    return await runPiAnalyzer({
        sessionId: session.sessionId,
        sinceExclusiveMs,
        untilInclusiveMs: Date.now(),
        piDir: options.piDir,
        ompDir: options.ompDir,
        ledgerDir: options.ledgerDir,
        bodiesDir: options.bodiesDir,
        decisions,
    });
}

export function groupBustWindows(
    requests: readonly AnalyzedCacheRequest[],
    seed?: OpenBustWindowState,
    backfillSeed?: OpenBustWindowState,
): BustWindow[] {
    const ordered = [...requests].sort(
        (left, right) => left.timestampMs - right.timestampMs || left.at.localeCompare(right.at),
    );
    const windows: BustWindow[] = [];
    const forwardSeed = seed && ordered[0]?.timestampMs > seed.lastBustMs ? seed : undefined;
    let current: BustWindow | undefined = forwardSeed
        ? {
              sessionId: ordered[0]?.session ?? "",
              startMs: forwardSeed.startMs,
              ...(forwardSeed.eventStartMs !== undefined ? { eventStartMs: forwardSeed.eventStartMs } : {}),
              lastBustMs: forwardSeed.lastBustMs,
              rows: [],
              precedingThreadRewrittenTokens: forwardSeed.threadRewrittenTokens,
          }
        : undefined;
    let previousWasBust = Boolean(forwardSeed);
    let previousBustClass: string | undefined = forwardSeed?.lastBustClass;
    for (const original of ordered) {
        let request = original;
        if (request.divergenceClass === "usage_missing") {
            // When the newest request is still in flight, do not start or continue
            // a window; keep its watermark at the most recent request that reported usage.
            current = undefined;
            previousWasBust = false;
            continue;
        }
        if (request.verdict !== "BUST" && request.verdict !== "SHORT") {
            if (current?.rows.length) windows.push(current);
            current = undefined;
            previousWasBust = false;
            continue;
        }
        if (!request.divergenceClass) {
            throw new CacheBustSentinelInputError(
                `analyzer returned BUST without divergence_class for ${request.session} at ${request.at}`,
            );
        }
        if (
            current &&
            previousWasBust &&
            request.timestampMs - current.lastBustMs <= BUST_WINDOW_MS
        ) {
            // A bust right after a reclaim bust alerts even when its own class is
            // accounted: one threshold crossing must cost one bust. An analyzer
            // that already judged the pair returns the relabelled class, which
            // this leaves unchanged.
            const own = request.divergenceClass as CacheBustDivergenceClass;
            const relabelled = classifyBustAfterReclaim(previousBustClass, own);
            if (relabelled !== own) {
                request = { ...request, divergenceClass: relabelled, cause: request.cause ?? own };
            }
            current.rows.push(request);
            current.lastBustMs = request.timestampMs;
        } else {
            if (current?.rows.length) windows.push(current);
            current = {
                sessionId: request.session,
                startMs: request.timestampMs,
                lastBustMs: request.timestampMs,
                rows: [request],
            };
        }
        previousWasBust = true;
        previousBustClass = request.divergenceClass;
    }
    if (current?.rows.length) windows.push(current);
    const reverseSeeds = [seed && !forwardSeed ? seed : undefined, backfillSeed]
        .filter((value): value is OpenBustWindowState => value !== undefined);
    const mergedSeeds = new Set<number>();
    for (const reverseSeed of reverseSeeds) {
        const seed = reverseSeed;
        const identity = seed.eventStartMs ?? seed.startMs;
        if (mergedSeeds.has(identity)) continue;
        mergedSeeds.add(identity);
        // A newest-first scan can discover the beginning of an already observed
        // streak later. Keep its delivery identity instead of waking twice just
        // because backfill moved the start. A stable request still splits it.
        const joined = windows.find((window) => window.lastBustMs >= seed.startMs - BUST_WINDOW_MS &&
            window.startMs <= seed.lastBustMs + BUST_WINDOW_MS && !ordered.some((row) =>
                row.timestampMs >= Math.min(window.startMs, seed.startMs) &&
                row.timestampMs <= Math.max(window.lastBustMs, seed.lastBustMs) &&
                (row.divergenceClass === "usage_missing" || (row.verdict !== "BUST" && row.verdict !== "SHORT"))));
        if (joined) {
            joined.eventStartMs = seed.eventStartMs ?? seed.startMs;
            joined.startMs = Math.min(joined.startMs, seed.startMs);
            joined.lastBustMs = Math.max(joined.lastBustMs, seed.lastBustMs);
            joined.precedingThreadRewrittenTokens = seed.threadRewrittenTokens;
        }
    }
    return windows;
}

export function cacheBustWindowId(sessionId: string, startMs: number): string {
    return createHash("sha256").update(`${sessionId}|${startMs}`).digest("hex");
}

function revisedCacheBustWindowId(
    sessionId: string,
    startMs: number,
    divergenceClass: string,
): string {
    return createHash("sha256").update(`${sessionId}|${startMs}|${divergenceClass}`).digest("hex");
}

function windowKey(sessionId: string, startMs: number): string {
    return `${sessionId}|${startMs}`;
}

function windowRewrittenTokens(window: BustWindow): number {
    return (window.precedingThreadRewrittenTokens ?? 0) + window.rows.reduce((sum, row) =>
        sum + (isThresholdedThreadClass(row.divergenceClass ?? "") ? Math.max(0, row.rewrittenTokens ?? 0) : 0), 0);
}

export function eventForWindow(
    window: BustWindow,
    directory: string,
    state: CacheBustSentinelState,
): CacheBustEvent | null {
    const rewrittenTokens = windowRewrittenTokens(window);
    const eventStartMs = window.eventStartMs ?? window.startMs;
    const key = windowKey(window.sessionId, eventStartMs);
    for (const row of window.rows) {
        if (isThresholdedThreadClass(row.divergenceClass as string) && rewrittenTokens < 20_000) {
            // Observations are distinct from sent-event IDs, so an accumulating
            // window can cross the threshold later without being deduplicated.
            state.suppressedWindows[key] = { divergenceClass: row.divergenceClass as string, rewrittenTokens };
        }
    }
    const unaccounted = window.rows.filter((row) =>
        isUnaccountedCacheBustClass(row.divergenceClass as string, rewrittenTokens));
    if (unaccounted.length === 0) return null;
    // A second bust right after a reclaim is the more specific finding than the
    // reclaim it follows, so it speaks for the window and names its cause.
    const representative = unaccounted.find((row) => row.cause) ?? unaccounted[0];
    const divergenceClass = representative.divergenceClass as string;
    const prior = state.windows[key];
    if (prior?.divergenceClass === divergenceClass) return null;
    const baseId = cacheBustWindowId(window.sessionId, eventStartMs);
    const eventId = prior
        ? revisedCacheBustWindowId(window.sessionId, eventStartMs, divergenceClass)
        : baseId;
    if (prior?.eventIds.includes(eventId)) return null;
    const event: CacheBustEvent = {
        source_module: "magic-context",
        kind: "cache_bust",
        vendor_event_id: eventId,
        ...(prior ? { supersedes: prior.lastEventId } : {}),
        session_id: window.sessionId,
        directory,
        occurred_at_ms: window.startMs,
        payload: {
            session: window.sessionId,
            at: representative.at,
            rewritten_tokens: isThresholdedThreadClass(divergenceClass) ? rewrittenTokens : unaccounted.reduce(
                (total, row) => total + Math.max(0, row.rewrittenTokens ?? 0),
                0,
            ),
            divergence_class: divergenceClass,
            first_divergence: representative.firstDivergence,
            analyzer_cmd: representative.analyzerCmd,
            ...(representative.identityDelta?.length
                ? { identity_delta: representative.identityDelta }
                : {}),
            ...(representative.cause ? { cause: representative.cause } : {}),
        },
    };
    state.windows[key] = {
        divergenceClass,
        lastEventId: eventId,
        eventIds: [...(prior?.eventIds ?? []), eventId],
    };
    return event;
}

export function agentDeliverRequest(
    event: CacheBustEvent,
    agentId: string,
    fromAgent: string,
): AgentDeliverRequest {
    return {
        agent_id: agentId,
        delivery_id: event.vendor_event_id,
        body: {
            kind: "peer_message",
            from_agent: fromAgent,
            from_session_id: SENTINEL_FROM_SESSION_ID,
            from_harness: SENTINEL_FROM_HARNESS,
            content: `${event.session_id}: cache bust detected in directory ${event.directory} at ${event.payload.at}; rewritten_tokens=${event.payload.rewritten_tokens}; divergence_class=${event.payload.divergence_class}; first_divergence=${event.payload.first_divergence}${event.payload.identity_delta ? `; identity_delta=${event.payload.identity_delta.join(",")}` : ""}${event.payload.cause ? `; cause=${event.payload.cause}` : ""}; analyzer_cmd=${event.payload.analyzer_cmd}`,
            one_way: true,
        },
        urgency: event.urgency ?? "high",
    };
}

export function parseAgentDeliverReply(
    value: unknown,
    previous?: AgentDeliverReply,
): AgentDeliverOutcome {
    const envelope = recordValue(value);
    const result = recordValue(envelope?.result);
    if (result && envelope && Object.keys(envelope).length !== 1) {
        throw new CacheBustSentinelInputError(
            `malformed ${AGENT_DELIVER_METHOD} reply: ${JSON.stringify(value)}`,
        );
    }
    const row = result ?? envelope;
    const keys = row ? Object.keys(row).sort() : [];
    if (
        !row ||
        keys.length !== 2 ||
        keys[0] !== "committed_order" ||
        keys[1] !== "disposition" ||
        !Number.isSafeInteger(row.committed_order) ||
        (row.committed_order as number) < 0
    ) {
        throw new CacheBustSentinelInputError(
            `malformed ${AGENT_DELIVER_METHOD} reply: ${JSON.stringify(value)}`,
        );
    }
    if (row.disposition === "idempotency_conflict") {
        throw new CacheBustSentinelInputError(
            `${AGENT_DELIVER_METHOD} idempotency_conflict: a delivery id was reused with different content`,
        );
    }
    if (row.disposition !== "delivered" && row.disposition !== "queued") {
        throw new CacheBustSentinelInputError(
            `malformed ${AGENT_DELIVER_METHOD} reply: ${JSON.stringify(value)}`,
        );
    }
    const reply: AgentDeliverReply = {
        disposition: row.disposition,
        committed_order: row.committed_order as number,
    };
    if (!previous) return { ...reply, accepted: true };
    if (reply.committed_order < previous.committed_order) {
        throw new CacheBustSentinelInputError(
            `${AGENT_DELIVER_METHOD} committed_order regressed from ${previous.committed_order} to ${reply.committed_order}`,
        );
    }
    if (reply.committed_order === previous.committed_order) {
        return { ...reply, accepted: false, reason: "dedup" };
    }
    return { ...reply, accepted: true, contractViolation: true };
}

export interface SubcWakeClient {
    call(
        moduleId: string,
        method: string,
        params?: unknown,
        options?: ManagedCallOptions,
    ): Promise<unknown>;
    close(): void;
}

export type SubcWakeClientFactory = (options: {
    connectionFile: string;
    handshakeTimeoutMs: number;
}) => Promise<SubcWakeClient>;

const connectSubcWakeClient: SubcWakeClientFactory = async (options) =>
    await SubcClient.connect(options);

function errorCode(error: unknown): string | undefined {
    if (!error || typeof error !== "object" || !("code" in error)) return undefined;
    return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class SubcWakeEventTransport implements CacheBustTransport {
    private clientPromise: Promise<SubcWakeClient> | null = null;

    constructor(
        private readonly connectionFile: string,
        private readonly moduleId = DEFAULT_WAKE_MODULE_ID,
        private readonly agentId = DEFAULT_WAKE_AGENT_ID,
        private readonly fromAgent = DEFAULT_WAKE_FROM_AGENT,
        private readonly connect: SubcWakeClientFactory = connectSubcWakeClient,
    ) {}

    private client(): Promise<SubcWakeClient> {
        this.clientPromise ??= this.connect({
            connectionFile: this.connectionFile,
            handshakeTimeoutMs: 2_000,
        });
        return this.clientPromise;
    }

    runnerSource(): RunnerMeterSource {
        return new AstrocyteRunnerMeterSource(() => this.client());
    }

    async record(event: CacheBustEvent, timeoutMs = 15_000): Promise<unknown> {
        const client = await this.client();
        const projectRoot =
            isAbsolute(event.directory) && existsSync(event.directory)
                ? event.directory
                : process.cwd();
        try {
            return await client.call(
                this.moduleId,
                AGENT_DELIVER_METHOD,
                agentDeliverRequest(event, this.agentId, this.fromAgent),
                {
                    identity: {
                        project_root: projectRoot,
                        harness: "magic-context",
                        session: event.session_id,
                    },
                    consumerIdentity: null,
                    timeoutMs,
                },
            );
        } catch (error) {
            if (errorCode(error) === "idempotency_conflict") {
                throw new CacheBustSentinelInputError(
                    `${AGENT_DELIVER_METHOD} idempotency_conflict for delivery_id=${event.vendor_event_id}: the same cache-bust window produced different content`,
                );
            }
            throw error;
        }
    }

    async close(): Promise<void> {
        if (!this.clientPromise) return;
        const client = await this.clientPromise.catch(() => null);
        client?.close();
    }

    async recordLag(notice: { deliveryId: string; content: string }, timeoutMs = 15_000): Promise<unknown> {
        const client = await this.client();
        const request: AgentDeliverRequest = {
            agent_id: this.agentId, delivery_id: notice.deliveryId, urgency: "normal",
            body: { kind: "peer_message", from_agent: this.fromAgent, from_session_id: SENTINEL_FROM_SESSION_ID,
                from_harness: SENTINEL_FROM_HARNESS, content: notice.content, one_way: true },
        };
        return await client.call(this.moduleId, AGENT_DELIVER_METHOD, request, {
            identity: { project_root: process.cwd(), harness: SENTINEL_FROM_HARNESS, session: SENTINEL_FROM_SESSION_ID },
            consumerIdentity: null, timeoutMs,
        });
    }
}

function emptyCounters(): SentinelCounters {
    return {
        sessions: 0,
        requests: 0,
        bustWindows: 0,
        accountedWindows: 0,
        unaccountedWindows: 0,
        skippedSeen: 0,
        dryRun: 0,
        accepted: 0,
        dedup: 0,
        sendRefused: 0,
        filesExamined: 0,
        bounded: false,
    };
}

function recordReply(counters: SentinelCounters, reply: AgentDeliverOutcome): void {
    if (reply.accepted) counters.accepted += 1;
    else counters.dedup += 1;
}

function updateOpenWindowState(
    sessionState: SessionWatermarkState,
    requests: readonly AnalyzedCacheRequest[],
    windows: readonly BustWindow[],
): void {
    const latest = [...requests].sort((left, right) => right.timestampMs - left.timestampMs)[0];
    if (!latest) return;
    if (sessionState.openWindow && latest.timestampMs < sessionState.openWindow.lastBustMs) {
        const backfilled = windows.find((window) => window.eventStartMs ===
            (sessionState.openWindow!.eventStartMs ?? sessionState.openWindow!.startMs));
        if (backfilled) {
            sessionState.openWindow.startMs = backfilled.startMs;
            sessionState.openWindow.eventStartMs = backfilled.eventStartMs;
            sessionState.openWindow.threadRewrittenTokens = windowRewrittenTokens(backfilled);
        }
        return;
    }
    if (latest.verdict !== "BUST" && latest.verdict !== "SHORT") {
        delete sessionState.openWindow;
        return;
    }
    const window = [...windows]
        .reverse()
        .find((candidate) => candidate.rows.some((row) => row.timestampMs === latest.timestampMs));
    if (window) {
        const lastBustClass = window.rows.at(-1)?.divergenceClass;
        sessionState.openWindow = {
            startMs: window.startMs,
            ...(window.eventStartMs !== undefined ? { eventStartMs: window.eventStartMs } : {}),
            lastBustMs: window.lastBustMs,
            ...(lastBustClass ? { lastBustClass } : {}),
            threadRewrittenTokens: windowRewrittenTokens(window),
        };
    }
}

/**
 * Order a run's sessions so that the run budget cannot starve one of them.
 *
 * A run stops at its deadline, and one large Pi session can take the whole
 * budget. The database returns sessions in a fixed order, so in listed order
 * the same session would be scanned first on every run, and a session listed
 * after it could go unscanned indefinitely while its watermark never moved.
 * Sessions with activity since their last scan come first, then the one scanned
 * longest ago, then the most recently active.
 */
export function orderSessionsForScan(
    sessions: readonly ActiveCacheBustSession[],
    state: CacheBustSentinelState,
): ActiveCacheBustSession[] {
    const lastScanned = (session: ActiveCacheBustSession): number =>
        state.sessions[session.sessionId]?.lastScannedAtMs ?? 0;
    const hasNewActivity = (session: ActiveCacheBustSession): boolean =>
        session.activityMs > lastScanned(session);
    return [...sessions].sort(
        (left, right) =>
            Number(hasNewActivity(right)) - Number(hasNewActivity(left)) ||
            lastScanned(left) - lastScanned(right) ||
            right.activityMs - left.activityMs ||
            left.sessionId.localeCompare(right.sessionId),
    );
}

export async function runSentinelOnce(
    options: CacheBustSentinelOptions,
    deps: SentinelRunDeps = {},
): Promise<SentinelCounters> {
    const clock = deps.now ?? Date.now;
    const nowMs = clock();
    const maxWakeAgeMs = maxWakeAgeMsFor(options);
    const deadlineMs = nowMs + (options.maxRunMs ?? 30_000);
    // Dump scans run first and own two thirds of the shared budget. A slow
    // runner service therefore cannot consume the OpenCode 1 scan's slot.
    const legacyDeadlineMs = deps.runnerSource || existsSync(options.connectionFile)
        ? nowMs + (options.maxRunMs ?? 30_000) * 2 / 3 : deadlineMs;
    const stdout = deps.stdout ?? console.log;
    const stderr = deps.stderr ?? console.error;
    const state = loadSentinelState(options.stateFile);
    const listSessions = deps.listActiveSessions ?? enumerateActiveSessions;
    const sessions = orderSessionsForScan(listSessions(state, nowMs, options), state);
    const counters = emptyCounters();
    const scanIndex = createOpenCodeDumpScanIndex(deps.scanMetrics);
    counters.sessions = sessions.length;
    let staleBacklog = false;
    stderr(JSON.stringify({ kind: "cache_bust_sentinel_start", at: new Date(nowMs).toISOString() }));
    const transport = options.send
        ? (deps.transport ??
          new SubcWakeEventTransport(
              options.connectionFile,
              options.wakeModuleId,
              options.wakeAgentId,
              options.wakeFromAgent,
          ))
        : null;

    try {
        // Requeue unfinished sessions behind the rest of the pass so every
        // session's newest batch comes before another session's older backlog.
        const scanQueue = [...sessions];
        for (let batchIndex = 0; batchIndex < scanQueue.length; batchIndex += 1) {
            const batchNowMs = clock();
            if (batchNowMs >= legacyDeadlineMs) {
                counters.bounded = true;
                break;
            }
            const session = scanQueue[batchIndex];
            const priorSession = state.sessions[session.sessionId];
            const priorScanCursor = priorSession?.scanCursor;
            const sinceExclusiveMs =
                priorSession ? Math.max(priorSession.lastAnalyzedRequestTimestampMs, batchNowMs - maxWakeAgeMs)
                    : batchNowMs - options.lookbackMs;
            staleBacklog ||= Boolean(priorSession?.scanCursor && priorSession.oldestPendingTimestampMs !== undefined &&
                priorSession.oldestPendingTimestampMs < sinceExclusiveMs);
            const decisions = (deps.loadDecisions ?? loadSessionDecisions)(session, options);
            const analysis = await (deps.analyzeSession ?? analyzeActiveSession)(
                session,
                sinceExclusiveMs,
                decisions,
                { ...options, scanCursor: priorSession?.scanCursor, scanDeadlineMs: legacyDeadlineMs, scanNow: clock, scanMetrics: deps.scanMetrics, scanIndex },
            );
            counters.filesExamined += analysis.filesExamined ?? 0;
            const requests = analysis.requests.filter(
                (request) =>
                    request.session === session.sessionId &&
                    request.timestampMs > sinceExclusiveMs &&
                    request.timestampMs <= batchNowMs,
            );
            counters.requests += requests.length;
            const sessionState: SessionWatermarkState = priorSession ?? {
                lastAnalyzedRequestTimestampMs: sinceExclusiveMs,
            };
            sessionState.lastAnalyzedRequestTimestampMs = Math.max(sessionState.lastAnalyzedRequestTimestampMs, sinceExclusiveMs);
            sessionState.lastScannedAtMs = batchNowMs;
            const windows = groupBustWindows(requests, sessionState.openWindow, sessionState.backfillWindow);
            counters.bustWindows += windows.length;
            for (const window of windows) {
                for (const row of window.rows) {
                    if (row.divergenceClass !== "tail_shrink_no_rewrite") continue;
                    stderr(
                        JSON.stringify({
                            kind: "cache_bust_sentinel_observation",
                            session_id: row.session,
                            at: row.at,
                            divergence_class: row.divergenceClass,
                            rewritten_tokens: Math.max(0, row.rewrittenTokens ?? 0),
                            first_divergence: row.firstDivergence,
                        }),
                    );
                }
                const hasUnaccounted = window.rows.some((row) =>
                    isUnaccountedCacheBustClass(row.divergenceClass as string, windowRewrittenTokens(window)));
                if (hasUnaccounted) counters.unaccountedWindows += 1;
                else counters.accountedWindows += 1;
                if (clock() - window.lastBustMs > maxWakeAgeMs) {
                    const key = windowKey(window.sessionId, window.eventStartMs ?? window.startMs);
                    const unaccounted = window.rows.filter((row) => isUnaccountedCacheBustClass(row.divergenceClass ?? "", windowRewrittenTokens(window)));
                    const representative = unaccounted.find((row) => row.cause) ?? unaccounted[0] ?? window.rows[0];
                    const observation = { divergenceClass: representative.divergenceClass as string,
                        rewrittenTokens: isThresholdedThreadClass(representative.divergenceClass ?? "") ? windowRewrittenTokens(window)
                            : (unaccounted.length ? unaccounted : window.rows).reduce((sum, row) => sum + Math.max(0, row.rewrittenTokens ?? 0), 0),
                        windowStartMs: window.startMs, reason: "stale" as const };
                    if (state.suppressedWindows[key]?.reason !== "stale") {
                        state.suppressedWindows[key] = observation;
                        stderr(JSON.stringify({ kind: "cache_bust_sentinel_observation", session_id: session.sessionId, ...observation }));
                    }
                    staleBacklog ||= Boolean(priorSession?.scanCursor || analysis.scanBounded);
                    sessionState.lastAnalyzedRequestTimestampMs = Math.max(sessionState.lastAnalyzedRequestTimestampMs, window.lastBustMs);
                    continue;
                }
                if (!hasUnaccounted) {
                    eventForWindow(window, analysis.directory ?? session.directory ?? session.projectPath, state);
                    continue;
                }
                const event = eventForWindow(
                    window,
                    analysis.directory ?? session.directory ?? session.projectPath,
                    state,
                );
                if (!event) {
                    counters.skippedSeen += 1;
                    continue;
                }
                // Persist the event id before any I/O so an ambiguous transport outcome
                // cannot cause the same vendor_event_id to be emitted twice.
                saveSentinelState(options.stateFile, state);
                if (!transport) {
                    stdout(JSON.stringify(event));
                    counters.dryRun += 1;
                    continue;
                }
                let wireReply: unknown;
                try {
                    wireReply = await transport.record(event);
                } catch (error) {
                    const code = errorCode(error);
                    if (code !== "peer_delivery_refused") throw error;
                    counters.sendRefused += 1;
                    stderr(
                        JSON.stringify({
                            event_id: event.vendor_event_id,
                            outcome: `send_refused:${code}`,
                            error: errorMessage(error),
                            counters,
                        }),
                    );
                    continue;
                }
                const priorDelivery = state.deliveries[event.vendor_event_id];
                const reply = parseAgentDeliverReply(
                    wireReply,
                    priorDelivery
                        ? {
                              disposition: priorDelivery.disposition,
                              committed_order: priorDelivery.committedOrder,
                          }
                        : undefined,
                );
                recordReply(counters, reply);
                if (reply.accepted) {
                    state.deliveries[event.vendor_event_id] = {
                        disposition: reply.disposition,
                        committedOrder: reply.committed_order,
                    };
                    saveSentinelState(options.stateFile, state);
                }
                if (reply.accepted && reply.contractViolation) {
                    stderr(
                        JSON.stringify({
                            kind: "agent_deliver_contract_violation",
                            delivery_id: event.vendor_event_id,
                            previous_committed_order: priorDelivery?.committedOrder,
                            reply: wireReply,
                        }),
                    );
                }
                stderr(
                    JSON.stringify({
                        event_id: event.vendor_event_id,
                        reply: wireReply,
                        outcome: reply,
                        counters,
                    }),
                );
            }
            const highWater =
                analysis.highWaterMarkMs !== null && analysis.highWaterMarkMs <= batchNowMs
                    ? analysis.highWaterMarkMs
                    : requests.length > 0
                      ? Math.max(...requests.map((request) => request.timestampMs))
                      : null;
            if (analysis.scanCursor) sessionState.scanCursor = analysis.scanCursor;
            else delete sessionState.scanCursor;
            if (analysis.pendingFiles) sessionState.pendingFiles = analysis.pendingFiles;
            else delete sessionState.pendingFiles;
            if (analysis.oldestPendingTimestampMs !== undefined) sessionState.oldestPendingTimestampMs = analysis.oldestPendingTimestampMs;
            else delete sessionState.oldestPendingTimestampMs;
            if (!analysis.scanBounded && highWater !== null && highWater > sessionState.lastAnalyzedRequestTimestampMs) {
                sessionState.lastAnalyzedRequestTimestampMs = highWater;
            }
            updateOpenWindowState(sessionState, requests, windows);
            const earliest = windows[0];
            const movedBackfill = parseScanCursor(analysis.scanCursor)?.before !== parseScanCursor(priorScanCursor)?.before;
            if (analysis.scanBounded && movedBackfill && earliest && requests[0]?.timestampMs === earliest.rows[0]?.timestampMs) {
                sessionState.backfillWindow = { startMs: earliest.startMs, lastBustMs: earliest.lastBustMs,
                    eventStartMs: earliest.eventStartMs ?? earliest.startMs, threadRewrittenTokens: windowRewrittenTokens(earliest) };
            } else if (!analysis.scanBounded || movedBackfill) delete sessionState.backfillWindow;
            state.sessions[session.sessionId] = sessionState;
            if (analysis.scanBounded || analysis.pendingFiles) {
                // An unchanged, empty scan cannot drain its backlog. Leave it
                // for the next run instead of spinning until the deadline.
                if (analysis.scanCursor === priorScanCursor && analysis.requests.length === 0) {
                    counters.bounded = true;
                } else scanQueue.push(session);
            }
        }
        const pending = Object.values(state.sessions).filter((session) => session.pendingFiles);
        const pendingFiles = pending.reduce((sum, session) => sum + (session.pendingFiles ?? 0), 0);
        counters.bounded ||= pendingFiles > 0;
        const oldest = Math.min(...pending.map((session) => session.oldestPendingTimestampMs ?? nowMs));
        const lagMs = Math.max(0, clock() - oldest);
        const lagging = staleBacklog || (counters.bounded && lagMs > maxWakeAgeMs / 2);
        if (!counters.bounded && pendingFiles === 0) {
            if (staleBacklog) stderr(JSON.stringify({ kind: "cache_bust_sentinel_lag", caughtUp: true, pendingFiles: 0 }));
            delete state.lag;
        } else if (lagging) {
            state.lag = { startedAtMs: state.lag?.startedAtMs ?? nowMs,
                consecutiveRuns: (state.lag?.consecutiveRuns ?? 0) + 1,
                notified: state.lag?.notified ?? false, lagMs: Number.isFinite(lagMs) ? lagMs : maxWakeAgeMs, pendingFiles };
            stderr(JSON.stringify({ kind: "cache_bust_sentinel_lag", ...state.lag }));
            if (state.lag.consecutiveRuns >= 3 && !state.lag.notified) {
                const notice = { deliveryId: `cache-bust-sentinel-lag:${state.lag.startedAtMs}`,
                    content: `Cache-bust sentinel is behind by ${Math.ceil(state.lag.lagMs / 60_000)} minutes and ${pendingFiles} files.` };
                state.lag.notified = true;
                saveSentinelState(options.stateFile, state);
                if (transport) {
                    if (!transport.recordLag) throw new CacheBustSentinelInputError("transport does not support quiet lag notices");
                    try {
                        parseAgentDeliverReply(await transport.recordLag(notice));
                        stderr(JSON.stringify({ kind: "cache_bust_sentinel_lag_delivery", urgency: "normal" }));
                    } catch (error) {
                        stderr(JSON.stringify({ kind: "cache_bust_sentinel_lag_delivery_refused", error: errorMessage(error) }));
                    }
                } else stdout(JSON.stringify({ kind: "cache_bust_sentinel_lag_notice", ...notice }));
            }
        } else if (state.lag) state.lag.consecutiveRuns = 0;
        const runner = state.runner ??= emptyRunnerState();
        let runnerHeads = deps.runnerHeads ?? new Map();
        let runnerDeliveryFailed = false;
        const feedTransport = transport instanceof SubcWakeEventTransport ? transport : new SubcWakeEventTransport(
            options.connectionFile, options.wakeModuleId, options.wakeAgentId, options.wakeFromAgent);
        const runnerNotice = async (content: string, suffix: string): Promise<void> => {
            const notice = { deliveryId: `cache-bust-runner:${runner.blindSince}:${suffix}`, content };
            if (transport?.recordLag) {
                try { parseAgentDeliverReply(await transport.recordLag(notice, Math.max(1, Math.min(15_000, deadlineMs - clock())))); }
                catch (error) { stderr(JSON.stringify({ kind: "runner_notice_refused", error: errorMessage(error) })); }
            } else stdout(JSON.stringify({ kind: "cache_bust_sentinel_lag_notice", ...notice }));
        };
        try {
            if (clock() < deadlineMs) {
                const root = options.runnerDataDir ?? dirname(options.databasePath);
                runnerHeads = deps.runnerHeads ?? loadRunnerHeads(root, nowMs, options.mcLogPath, clock, deadlineMs);
                counters.runner = await scanRunnerFeed({ state: runner, source: deps.runnerSource ?? feedTransport.runnerSource(),
                    heads: runnerHeads,
                    root, now: nowMs, clock, deadline: deadlineMs, wakeAge: maxWakeAgeMs,
                    log: stderr,
                    emit: async (alert) => {
                        const event: CacheBustEvent = { source_module: "magic-context", kind: "cache_bust", vendor_event_id: alert.id,
                            session_id: alert.session, directory: root, occurred_at_ms: alert.at, urgency: alert.urgency,
                            payload: { session: alert.session, at: new Date(alert.at).toISOString(), rewritten_tokens: alert.rewrittenTokens,
                                divergence_class: alert.class, first_divergence: alert.detail, analyzer_cmd: alert.analyzer } };
                        saveSentinelState(options.stateFile, state);
                        if (!transport) { stdout(JSON.stringify(event)); counters.dryRun++; return; }
                        try {
                            const reply = parseAgentDeliverReply(await transport.record(event, Math.max(1, Math.min(15_000, deadlineMs - clock()))));
                            recordReply(counters, reply);
                            if (reply.accepted) state.deliveries[event.vendor_event_id] = { disposition: reply.disposition, committedOrder: reply.committed_order };
                        } catch (error) {
                            if (errorCode(error) !== "peer_delivery_refused") { runnerDeliveryFailed = true; throw error; }
                            counters.sendRefused++;
                        }
                    } });
                if (runner.blindNotified) await runnerNotice("Runner cache-bust lane recovered; usage.steps.read is readable again.", "recovered");
                runner.failures = 0; delete runner.blindSince; delete runner.blindNotified;
            }
        } catch (error) {
            if (runnerDeliveryFailed) throw error;
            runner.failures++; runner.blindSince ??= nowMs;
            counters.runner = { judged: 0, not_metered: 0, skipped: 0, bounded: false, gaps: 0, failure: errorMessage(error), heads_without_meter: headsWithoutMeter(runner, runnerHeads, nowMs), late_revisions: 0, late_token_revisions: 0 };
            if (runner.failures >= 5 && !runner.blindNotified) {
                runner.blindNotified = true;
                saveSentinelState(options.stateFile, state);
                await runnerNotice(`Runner cache-bust lane is blind after ${runner.failures} failed runs: ${errorMessage(error)}. Existing dump/session lanes still run.`, "blind");
            }
        } finally {
            counters.runner ??= { judged: 0, not_metered: 0, skipped: 0, bounded: true, gaps: 0,
                heads_without_meter: headsWithoutMeter(runner, runnerHeads, nowMs), late_revisions: 0, late_token_revisions: 0 };
            pruneRunnerState(runner, nowMs);
            if (feedTransport !== transport) await feedTransport.close();
        }
    } finally {
        // Keep batch progress in memory until the end of the run: rewriting the
        // complete state after each batch would multiply I/O while draining a
        // backlog. Alert sends still save IDs before and outcomes after sending.
        // Saving here also keeps the progress of a run that throws. An abrupt exit can lose
        // watermark updates or an in-flight delivery outcome; the next run then
        // re-reads those requests, but it never emits the same event id again,
        // because each event id is saved before it is sent.
        pruneIdleSessionState(state, nowMs);
        saveSentinelState(options.stateFile, state);
        await transport?.close?.();
    }
    stderr(JSON.stringify({ kind: "cache_bust_sentinel_summary", at: new Date(clock()).toISOString(), elapsedMs: clock() - nowMs, counters }));
    return counters;
}

async function main(): Promise<void> {
    setStoragePrivatePermissionEnforcement(
        loadPluginConfig(process.cwd()).storage.enforce_private_permissions,
    );
    const options = parseSentinelArgs(process.argv);
    await runSentinelOnce(options);
    while (!options.once) {
        await Bun.sleep(options.intervalMs);
        await runSentinelOnce(options);
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

export const __test = {
    bustWindowMs: BUST_WINDOW_MS,
    defaultState,
    revisedCacheBustWindowId,
};
