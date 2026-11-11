#!/usr/bin/env bun
/**
 * analyze-cache-busts.ts — walk a session's authentication-plugin request
 * dumps and attribute prompt changes using the provider's usage meter.
 *
 * anthropic-auth bodies use `system` + `messages[]` and explicit cache-control
 * breakpoints. openai-auth bodies are OpenAI Responses requests: `instructions`
 * + `input[]`, where message, function-call, and function-output items share an
 * implicit prefix cache. WebSocket openai-auth captures may omit response files.
 * Both shapes are normalized to role + part type/length/text-prefix messages so
 * attribution and --show-diff have the same output on either lane.
 * Anthropic thread continuations carry only new messages. Their system/tools
 * remain comparable, but their message deltas never compare as full histories.
 * A later full body compares with the last full body and every intervening
 * client delta; undumped assistant replies cannot prove a client rewrite.
 * SHORT means the meter read short without a demonstrated byte rewrite.
 * A changed wire model/account or a provider model_changed diagnostic reads a
 * different cache: cache_scope_changed accounts for that miss before all other
 * attribution. Other provider diagnostic types are printed without interpreting them.
 *
 * Usage fields and the meter, per provider:
 *   Anthropic  `input_tokens` are the uncached tokens after the last cache
 *              breakpoint; `cache_read_input_tokens` were served from cache and
 *              `cache_creation_input_tokens` were written to it
 *              (https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#tracking-cache-performance).
 *              A request is cache-healthy when its read covers what the previous
 *              request read or wrote: read >= previous read + previous write - 64.
 *              Uncached input never counts as reuse. Counting it ("read + input")
 *              let a request with no breakpoint after the head, which read 47k and
 *              billed ~475k as input, pass as a warm hit. A short read that wrote
 *              nothing while >= 1,024 tokens went uncached is
 *              `missing_breakpoint_after_read` and always a BUST: the request's own
 *              shape caused it, whatever its bytes. A short read with a large write
 *              is a rewrite and goes through the shared classifier.
 *   OpenAI     `prompt_tokens`/`input_tokens` include `cached_tokens`; there are no
 *              breakpoints or write meter, because every prompt prefix is cached
 *              implicitly (https://platform.openai.com/docs/guides/prompt-caching).
 *              The read is `cached_tokens` alone; the uncached part never counts.
 *   Gemini     `promptTokenCount` includes `cachedContentTokenCount`; implicit
 *              caching has no write meter either
 *              (https://ai.google.dev/gemini-api/docs/caching, "Implicit caching").
 *   For OpenAI and Gemini the previous request's uncached tail may not be cached
 *   yet when the next request arrives, so the floor is the previous read, not the
 *   previous prompt.
 * Any request kind, including a continuation: a short read after the cache lifetime
 * is `idle_cache_expiry`. --cache-ttl overrides the previous same-route body's
 * longest stated cache_control TTL. Without a stated TTL, the fallback is 1h for
 * runners and 5m for plugin-host dumps. Unstated breakpoint TTLs do not override
 * those defaults. The clock starts when the prefix was last read in full or written.
 *
 * Usage:
 *   bun scripts/analyze-cache-busts.ts <sessionIdPrefix> [options]
 *   bun scripts/analyze-cache-busts.ts --session <sessionIdPrefix> [options]
 * Options:
 *   --session <id>   session id or prefix (positional form is also supported)
 *   --dir <path>     inspect only one explicit dump dir (legacy override)
 *   --anthropic-dir  anthropic-auth dir (env: OPENCODE_ANTHROPIC_AUTH_DUMP_DIR)
 *   --openai-dir     openai-auth dir (env: OPENCODE_OPENAI_AUTH_DUMP_DIR)
 *   --since <time>   created at/after ISO time or duration ago (for example 30m)
 *   --until <time>   created at/before ISO time or duration ago
 *   --limit <N>      only the last N requests in range
 *   --cache-ttl <d>  override prior same-route body's stated breakpoint TTL
 *                    (fallback: 1h for runners, 5m for plugin-host dumps)
 *   --source <kind> auto (default), dumps (OC1/Broca), oc2, pi, or astrocyte (24h feed)
 *   --dump-dir <p>  override the runner's dump directory
 *   --runner-data-dir <p> override the CortexKit data root (for offline fixtures)
 *   --show-diff      print before/after snippet of the first-diverging segment
 *   --all-busts      list every diverging segment, not just the first
 *   --all-rows       also print STABLE and UNMETERED rows
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AnalyzedCacheRequest,
    type CacheBustAttributionInput,
    type CacheBustDecisionAttribution,
    type CacheBustDivergenceClass,
    type CacheBustSessionAnalysis,
    type ProviderCacheMissReason,
    CACHE_READ_EPSILON_TOKENS,
    cachedPrefixFloor,
    classifyCacheBust,
    createCacheBustDecisionJoiner,
    DEFAULT_CACHE_TTL_MS,
    isIdleCacheExpiry,
    isMissingBreakpointAfterRead,
    parseCacheTtl,
    refreshesCachedPrefix,
} from "./cache-bust-attribution";
import {
    type BodyProvider,
    describeNormalizedMessage,
    type NormalizedMessage,
    normalizeRequestBody,
} from "./cache-bust-body-sources";

import { withSchedulerLogFallback } from "./cache-bust-scheduler-log";
import { DumpScanIndex, type DumpScanMetrics, listDumpFiles } from "./cache-bust-dump-index";
import { type CacheBustScanProgress, selectScanBatch } from "./cache-bust-scan";
import { DEFAULT_RUNNER_DATA_DIR, loadRunnerSession, runnerDumpDirectory, runnerMeter, type RunnerRequest, type RunnerSession } from "./cache-bust-runner-sources";
import { joinRequestsToViews, loadRunnerEvidence, runnerDecisionsBetween, type RunnerDecision, type RunnerEvidence } from "./cache-bust-runner-log";
import { classifyRunnerStep, formatRunnerStepTiming, type RunnerStepClassification } from "./cache-bust-runner-classification";
import { analyzeRunnerFeed, printRunnerFeedAnalysis } from "./cache-bust-runner-analyzer";
import { AstrocyteRunnerMeterSource } from "./cache-bust-runner-feed";
import { loadRunnerHeads } from "./cache-bust-runner-monitor";
import { SubcClient } from "@cortexkit/subc-client";
import { getDataDir } from "../src/shared/data-path";

type Json = Record<string, unknown>;
type ByteVerdict = "BUST" | "STABLE";
type MeterVerdict = ByteVerdict | "SHORT" | "LATENCY" | "UNMETERED" | "EXPIRED" | "VIEW" | "UNEXPLAINED (no bytes)" | "PLAN_CHANGED" | "PROVIDER_FORGOT" | "SCOPE_CHANGED";
type MeterVsBytes = "AGREE" | "BYTES-ONLY" | "LATENCY" | "UNMETERED" | "N/A";

interface Segment extends NormalizedMessage {
    id: string;
}

interface DumpSource {
    provider: BodyProvider;
    dir: string;
    label: string;
}

interface Args {
    sessionPrefix: string;
    sources: DumpSource[];
    /** Read every request with this meter, overriding the dump's wire family. */
    meter?: BodyProvider;
    since?: string;
    until?: string;
    limit?: number;
    cacheTtl?: string;
    showDiff: boolean;
    allBusts: boolean;
    allRows: boolean;
    help: boolean;
    mcLogPath?: string;
    source: "auto" | "dumps" | "oc2" | "pi" | "astrocyte";
    connectionFile?: string;
    runnerDataDir: string;
    dumpDir?: string;
    excludeKeepWarm?: boolean;
    scanMetrics?: DumpScanMetrics;
    scanIndex?: DumpScanIndex;
}

interface MeterUsage {
    cacheRead: number;
    cacheCreation?: number;
    input: number;
    total: number;
    /** Generated tokens; only the Gemini meter records it (candidates + thoughts). */
    output?: number;
    source: string;
    provider: BodyProvider;
    rule: string;
}

interface Snapshot {
    file: string;
    bodyPath: string;
    bodyBytes: number;
    createdAt: string;
    requestTimestampMs: number;
    session: string;
    messagesCount: number;
    provider: BodyProvider;
    wireModel?: string;
    sourceDir: string;
    segments: Segment[];
    usage?: MeterUsage;
    orderCreatedAt: string;
    sequence: number;
    /** `wire_family` from the dump's meta.json (Broca cache-dump exports write it). */
    wireFamily?: string;
    /** Meter the usage was read with; undefined when the wire family has no meter here. */
    meter?: BodyProvider;
    meterForced?: boolean;
    /** The runner meter remains usable when its rolling dump window has no body. */
    runnerRequest?: RunnerRequest;
    bytesMissing?: boolean;
    threadType?: "create" | "continue";
    tools?: Segment;
    statedCacheTtlMs?: number;
    /** Account routing identity; it does not change which bytes are compared or how lifetime is tracked. */
    route?: string;
    providerCacheMissReason?: ProviderCacheMissReason;
}

/**
 * Broca's cache-dump exporter names the wire grammar of every request in
 * meta.json. That name decides both the body shape and the usage meter, because
 * the directory a dump sits in says nothing about which provider produced it.
 * Families absent here (openai_chat, bedrock_converse) get no meter: the
 * analyzer refuses them instead of reading a meter they do not carry.
 */
const WIRE_FAMILY_PROVIDERS: Readonly<Record<string, BodyProvider>> = {
    anthropic_messages: "anthropic",
    openai_responses: "openai",
    openai_responses_chatgpt: "openai",
    gemini: "gemini",
    google_codeassist: "gemini",
};

const METER_RULES: Readonly<Record<BodyProvider, string>> = {
    anthropic: "Anthropic explicit cache: cache_read_input_tokens/cache_creation_input_tokens",
    openai: "OpenAI implicit-prefix cache: prompt_tokens_details.cached_tokens; no write premium",
    gemini: "Gemini implicit-prefix cache: usageMetadata.cachedContentTokenCount inside promptTokenCount; no write premium",
};

const METER_FIELDS: Readonly<Record<BodyProvider, string>> = {
    anthropic: "input_tokens/cache_read_input_tokens",
    openai: "prompt_tokens|input_tokens + cached_tokens",
    gemini: "promptTokenCount/cachedContentTokenCount",
};

/** OpenAI and Gemini cache any byte-identical prompt prefix; there are no breakpoints. */
function isImplicitPrefixCache(provider: BodyProvider): boolean {
    return provider === "openai" || provider === "gemini";
}

function finiteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

export interface AnalysisRow {
    current: Snapshot;
    previous?: Snapshot;
    divergenceIndex: number;
    byteVerdict?: ByteVerdict;
    verdict: MeterVerdict | "BASE";
    meterVsBytes?: MeterVsBytes;
    prevTotal?: number;
    /** Set when the meter floor came from an earlier request than `previous`. */
    meterReference?: Snapshot;
    epsilon?: number;
    meterFloor?: number;
    comparableRead?: number;
    shortRead?: boolean;
    /** Time since the cached prefix was last read in full or written. */
    idleGapMs?: number;
    rewrittenTokens?: number;
    divergenceClass?: CacheBustDivergenceClass;
    decision?: CacheBustDecisionAttribution;
    runnerDecisions?: RunnerDecision[];
    runnerClassification?: RunnerStepClassification;
    renderedView?: number | null;
    viewJoin?: "time" | "unmatched";
    comparisonNote?: string;
    prefixDivergence?: Segment;
    providerCacheMissReason?: ProviderCacheMissReason;
}

export interface OpenCodeCacheBustAnalysisOptions {
    sessionId: string;
    sinceExclusiveMs?: number;
    untilInclusiveMs?: number;
    anthropicDir?: string;
    openaiDir?: string;
    decisions?: readonly CacheBustDecisionAttribution[];
    /** Use scheduler lines when a pass has no DB row; null disables this additional evidence source. */
    mcLogPath?: string | null;
    scanCursor?: string;
    scanDeadlineMs?: number;
    scanNow?: () => number;
    scanMetrics?: DumpScanMetrics;
    /** Share only names and small metadata across batches of one sentinel run. */
    scanIndex?: DumpScanIndex;
    /**
     * Overrides the cache lifetime the previous same-route request stated. When
     * that request states none, the fallback is five minutes for plugin-host
     * dumps and one hour for runner sessions.
     */
    cacheTtlMs?: number;
}

interface DumpCandidate {
    source: DumpSource;
    session: string;
    latestMtimeMs: number;
    totalBytes: number;
    dumpCount: number;
}

interface SnapshotSelection {
    snapshots: Snapshot[];
    selected?: DumpCandidate;
    candidates: DumpCandidate[];
}

function parseArgs(argv: string[]): Args {
    const args = argv.slice(2);
    const getOpt = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
    };
    const valueOptions = new Set([
        "--session",
        "--mc-log",
        "--dir",
        "--anthropic-dir",
        "--openai-dir",
        "--since",
        "--until",
        "--limit",
        "--meter",
        "--cache-ttl",
        "--source",
        "--runner-data-dir",
        "--dump-dir",
        "--connection-file",
    ]);
    let positionalSession = "";
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (valueOptions.has(arg)) {
            index += 1;
            continue;
        }
        if (!arg.startsWith("--")) {
            positionalSession = arg;
            break;
        }
    }
    const limitRaw = getOpt("--limit");
    const singleDir = getOpt("--dir");
    const sources: DumpSource[] = singleDir
        ? [{ provider: "anthropic", dir: singleDir, label: "explicit --dir" }]
        : [
              {
                  provider: "anthropic",
                  dir:
                      getOpt("--anthropic-dir") ??
                      process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR ??
                      join(tmpdir(), "opencode-anthropic-auth-dumps"),
                  label: "anthropic-auth",
              },
              {
                  provider: "openai",
                  dir:
                      getOpt("--openai-dir") ??
                      process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR ??
                      join(tmpdir(), "opencode-openai-auth-dumps"),
                  label: "openai-auth",
              },
          ];
    const meterRaw = getOpt("--meter");
    if (meterRaw !== undefined && !(meterRaw in METER_RULES)) {
        throw new Error(`Invalid --meter ${meterRaw}; expected anthropic, openai, or gemini`);
    }
    const source = getOpt("--source") ?? (singleDir ? "dumps" : "auto");
    if (!["auto", "dumps", "oc2", "pi", "astrocyte"].includes(source)) throw new Error(`Invalid --source ${source}`);
    return {
        sessionPrefix: getOpt("--session") ?? positionalSession,
        mcLogPath: getOpt("--mc-log"),
        sources,
        meter: meterRaw as BodyProvider | undefined,
        since: getOpt("--since"),
        until: getOpt("--until"),
        limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
        cacheTtl: getOpt("--cache-ttl"),
        showDiff: args.includes("--show-diff"),
        allBusts: args.includes("--all-busts"),
        allRows: args.includes("--all-rows"),
        help: args.includes("--help") || args.includes("-h"),
        source: source as Args["source"],
        runnerDataDir: getOpt("--runner-data-dir") ?? DEFAULT_RUNNER_DATA_DIR,
        dumpDir: getOpt("--dump-dir"),
        connectionFile: getOpt("--connection-file"),
    };
}

function resolveTimeBound(value: string | undefined, nowMs = Date.now()): string | undefined {
    if (!value) return undefined;
    const duration = /^(\d+)(ms|s|m|h|d)$/.exec(value);
    if (duration) {
        const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
            duration[2] as "ms" | "s" | "m" | "h" | "d"
        ];
        return new Date(nowMs - Number.parseInt(duration[1], 10) * unitMs).toISOString();
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid time bound: ${value}`);
    return new Date(parsed).toISOString();
}

function parseDumpFilename(file: string): {
    createdAt: string;
    sequence: number;
    session: string;
} | null {
    const timestamp = /(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(file);
    const session = /(?:^|-)(ses_[A-Za-z0-9]+|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?=-|\.meta\.json$)/i.exec(file);
    if (!timestamp || !session) return null;
    const rest = file.slice(timestamp.index + timestamp[0].length);
    const sequence = /^-(\d+)-/.exec(rest);
    return {
        createdAt: `${timestamp[1]}:${timestamp[2]}:${timestamp[3]}.${timestamp[4]}Z`,
        sequence: sequence ? Number.parseInt(sequence[1], 10) : 0,
        session: session[1],
    };
}

function sessionMatches(candidate: string, prefix: string): boolean {
    const visibleHead = candidate.replace(/[….]+$/, "");
    return candidate.startsWith(prefix) || prefix.startsWith(visibleHead);
}

export function createOpenCodeDumpScanIndex(metrics?: DumpScanMetrics): DumpScanIndex {
    return new DumpScanIndex(parseDumpFilename, metrics);
}

function buildSegments(
    body: Json,
    provider?: BodyProvider,
): { provider: BodyProvider; segments: Segment[] } {
    const normalized = normalizeRequestBody(body, provider);
    return {
        provider: normalized.provider,
        segments: normalized.messages.map((message, index) => ({
            ...message,
            id: `message[${index}] ${describeNormalizedMessage(message)}`,
        })),
    };
}

function wireModel(body: Json): string | undefined {
    return typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;
}

function threadType(body: Json, meta: Json): Snapshot["threadType"] {
    const type = asJson(body.thread ?? asJson(meta.body)?.thread)?.type;
    return type === "continue" || type === "create" ? type : undefined;
}

/** Read TTLs before normalization removes cache_control from comparable bytes. */
function requestCacheTtlMs(body: Json): number | undefined {
    let longest = 0;
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const child of value) visit(child);
            return;
        }
        const object = asJson(value);
        if (!object) return;
        const control = asJson(object.cache_control);
        if (control?.type === "ephemeral") {
            if (control.ttl === "1h") longest = Math.max(longest, 3_600_000);
            else if (control.ttl === "5m") longest = Math.max(longest, DEFAULT_CACHE_TTL_MS);
        }
        for (const child of Object.values(object)) visit(child);
    };
    visit(body);
    return longest || undefined;
}

function sameRoute(left: Snapshot, right: Snapshot): boolean {
    return left.session === right.session && left.provider === right.provider && left.sourceDir === right.sourceDir;
}

/** Runner requests with no body and no recognized meter cannot prove a wire-model change. */
function scopeWireModel(snapshot?: Snapshot): string | undefined {
    return snapshot?.runnerRequest && snapshot.bytesMissing && !snapshot.meter
        ? undefined : snapshot?.wireModel;
}

function cacheScopeChange(current: Snapshot, previous?: Snapshot): string | undefined {
    const changes: string[] = [];
    const previousModel = scopeWireModel(previous);
    const currentModel = scopeWireModel(current);
    if (previousModel && currentModel && previousModel !== currentModel) {
        changes.push(`model ${previousModel} → ${currentModel}`);
    }
    if (previous?.route && current.route && previous.route !== current.route) {
        const account = (route: string) => route.split(":").at(-1) ?? route;
        changes.push(`account ${account(previous.route)} → ${account(current.route)}`);
    }
    if (changes.length === 0 && current.providerCacheMissReason?.type === "model_changed") {
        changes.push("provider reports model_changed");
    }
    return changes.length ? changes.join("; ") : undefined;
}

/** A full body after deltas needs its full baseline and every sent delta in between. */
function withThreadContext(snapshots: Snapshot[], args: Args): Snapshot[] {
    const extra: Snapshot[] = [];
    const starts = snapshots.filter((snapshot, index) =>
        snapshot.threadType !== undefined &&
        (snapshot.threadType === "create" || snapshots.slice(index + 1).some((later) =>
            sameRoute(later, snapshot) && later.threadType !== "continue")) &&
        !snapshots.slice(0, index).some((earlier) => sameRoute(earlier, snapshot)),
    );
    for (const first of starts) {
        const candidate: DumpCandidate = {
            source: { provider: first.provider, dir: first.sourceDir, label: "thread context" },
            session: first.session,
            latestMtimeMs: 0,
            totalBytes: 0,
            dumpCount: 0,
        };
        const files = (args.scanIndex?.contextFiles(first.sourceDir, first.session) ?? listDumpFiles(first.sourceDir, args.scanMetrics))
            .filter((file) => file.endsWith(".meta.json"))
            .flatMap((file) => {
                const name = parseDumpFilename(file);
                if (name && name.session !== first.session) return [];
                try {
                    const meta = readDumpMetadata(first.sourceDir, file, args);
                    if (!name && String(meta.session ?? "") !== first.session) return [];
                    return [{
                        file,
                        createdAt: name?.createdAt ?? String(meta.createdAt ?? ""),
                        sequence: name?.sequence ?? (finiteNumber(meta.step) ? meta.step : 0),
                    }];
                } catch {
                    // A request's metadata file may still be being written while this scan runs.
                    return [];
                }
            })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) ||
                b.sequence - a.sequence || b.file.localeCompare(a.file));
        for (const entry of files) {
            if (entry.createdAt > first.orderCreatedAt ||
                (entry.createdAt === first.orderCreatedAt &&
                    (entry.sequence > first.sequence ||
                        (entry.sequence === first.sequence && entry.file >= first.file)))) continue;
            const snapshot = loadCandidateSnapshots(
                candidate,
                { ...args, since: undefined, until: undefined, limit: undefined },
                [entry.file],
            )[0];
            if (!snapshot || !sameRoute(snapshot, first)) continue;
            extra.push(snapshot);
            if (snapshot.threadType !== "continue") break;
        }
    }
    return [...extra, ...snapshots].sort((a, b) =>
        a.orderCreatedAt.localeCompare(b.orderCreatedAt) ||
        a.sequence - b.sequence || a.file.localeCompare(b.file));
}

function asJson(value: unknown): Json | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Json)
        : undefined;
}

function meterUsage(
    value: unknown,
    source: string,
    provider: BodyProvider,
): MeterUsage | undefined {
    const usage = asJson(value);
    if (!usage) return undefined;
    if (provider === "gemini") {
        // Broca's exporter documents promptTokenCount as fresh input PLUS cached
        // content (the Gemini wire semantics), so the cached tokens are already
        // inside the total and are subtracted, never added, for the direct input.
        // Google omits zero-valued counts, so an absent cachedContentTokenCount next
        // to a prompt count is a zero read. Without a prompt count there is no total
        // to compare against, so the request is unmetered.
        const promptTokens = usage.promptTokenCount;
        const cachedTokens = usage.cachedContentTokenCount ?? 0;
        if (!finiteNumber(promptTokens) || !finiteNumber(cachedTokens)) return undefined;
        const candidates = usage.candidatesTokenCount;
        const thoughts = usage.thoughtsTokenCount;
        const output =
            finiteNumber(candidates) || finiteNumber(thoughts)
                ? (finiteNumber(candidates) ? candidates : 0) +
                  (finiteNumber(thoughts) ? thoughts : 0)
                : undefined;
        return {
            cacheRead: cachedTokens,
            cacheCreation: undefined,
            input: Math.max(0, promptTokens - cachedTokens),
            total: promptTokens,
            output,
            source,
            provider,
            rule: METER_RULES.gemini,
        };
    }
    if (provider === "openai") {
        const promptTokens = usage.prompt_tokens ?? usage.input_tokens;
        const details = asJson(usage.prompt_tokens_details) ?? asJson(usage.input_tokens_details);
        const cachedTokens = details?.cached_tokens ?? 0;
        if (
            typeof promptTokens !== "number" ||
            !Number.isFinite(promptTokens) ||
            typeof cachedTokens !== "number" ||
            !Number.isFinite(cachedTokens)
        ) {
            return undefined;
        }
        return {
            cacheRead: cachedTokens,
            cacheCreation: undefined,
            input: Math.max(0, promptTokens - cachedTokens),
            total: promptTokens,
            source,
            provider,
            rule: "OpenAI implicit-prefix cache: prompt_tokens_details.cached_tokens; no write premium",
        };
    }
    if (typeof usage.input_tokens !== "number" || !Number.isFinite(usage.input_tokens)) {
        return undefined;
    }
    const cacheRead = usage.cache_read_input_tokens;
    const cacheCreation = usage.cache_creation_input_tokens;
    if (
        (cacheRead !== undefined &&
            (typeof cacheRead !== "number" || !Number.isFinite(cacheRead))) ||
        (cacheCreation !== undefined &&
            (typeof cacheCreation !== "number" || !Number.isFinite(cacheCreation)))
    ) {
        return undefined;
    }
    return {
        cacheRead: cacheRead ?? 0,
        cacheCreation,
        input: usage.input_tokens,
        total: (cacheRead ?? 0) + (cacheCreation ?? 0) + usage.input_tokens,
        source,
        provider,
        rule: "Anthropic explicit cache: cache_read_input_tokens versus prior read + write; uncached input_tokens never count as reuse",
    };
}

/** Collect usage from completed JSON responses and from message_start/message_delta stream events. */
function collectUsageCandidates(
    value: unknown,
    source: string,
    provider: BodyProvider,
    candidates: MeterUsage[],
): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            collectUsageCandidates(entry, `${source}[${index}]`, provider, candidates);
        });
        return;
    }
    const object = asJson(value);
    if (!object) return;

    const eventType = typeof object.type === "string" ? object.type : source;
    const direct = meterUsage(object.usage, `${eventType}.usage`, provider);
    if (direct) candidates.push(direct);
    // Raw Gemini and Code Assist responses name the meter `usageMetadata`
    // (Code Assist nests it under `response`, which the recursion below reaches).
    if (provider === "gemini") {
        const metadata = meterUsage(object.usageMetadata, `${eventType}.usageMetadata`, provider);
        if (metadata) candidates.push(metadata);
    }
    const message = asJson(object.message);
    const messageUsage = meterUsage(message?.usage, `${eventType}.message.usage`, provider);
    if (messageUsage) candidates.push(messageUsage);

    for (const [key, child] of Object.entries(object)) {
        if (key === "usage" || key === "message") continue;
        if (provider === "gemini" && key === "usageMetadata") continue;
        if (typeof child === "string" && key === "data") {
            try {
                collectUsageCandidates(JSON.parse(child), `${source}.data`, provider, candidates);
            } catch {
                // A non-JSON SSE data line cannot contain the usage meter.
            }
        } else if (child && typeof child === "object") {
            collectUsageCandidates(child, `${source}.${key}`, provider, candidates);
        }
    }
}

function parseResponsePayloads(raw: string): unknown[] {
    try {
        return [JSON.parse(raw)];
    } catch {
        const payloads: unknown[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const data = line.startsWith("data:") ? line.slice("data:".length).trim() : line.trim();
            if (!data || data === "[DONE]") continue;
            try {
                payloads.push(JSON.parse(data));
            } catch {
                // Ignore SSE event labels and incomplete/non-JSON lines.
            }
        }
        return payloads;
    }
}

function loadMeterUsage(
    responsePath: string | undefined,
    provider: BodyProvider = "anthropic",
): MeterUsage | undefined {
    return loadResponseEvidence(responsePath, provider).usage;
}

function loadResponseEvidence(responsePath: string | undefined, provider?: BodyProvider): {
    usage?: MeterUsage;
    providerCacheMissReason?: ProviderCacheMissReason;
} {
    if (!responsePath || !existsSync(responsePath)) return {};
    try {
        const candidates: MeterUsage[] = [];
        let providerCacheMissReason: ProviderCacheMissReason | undefined;
        for (const payload of parseResponsePayloads(readFileSync(responsePath, "utf8"))) {
            if (provider) collectUsageCandidates(payload, "response", provider, candidates);
            const reason = asJson(asJson(asJson(payload)?.diagnostics)?.cache_miss_reason);
            if (typeof reason?.type !== "string") continue;
            const missed = reason.cache_missed_input_tokens;
            providerCacheMissReason = {
                type: reason.type,
                ...(finiteNumber(missed) && missed >= 0 ? { cacheMissedInputTokens: missed } : {}),
            };
        }
        return { usage: candidates.at(-1), ...(providerCacheMissReason ? { providerCacheMissReason } : {}) };
    } catch {
        return {};
    }
}

function artifactPaths(
    source: DumpSource,
    metaFile: string,
    meta: Json,
): {
    bodyPath?: string;
    responsePath?: string;
} {
    const files = asJson(meta.files);
    const referencedBodyPath = typeof files?.body === "string" ? files.body : undefined;
    const adjacentBodyPath = join(source.dir, metaFile.replace(/\.meta\.json$/, ".body.json"));
    const bodyPath =
        referencedBodyPath && existsSync(referencedBodyPath)
            ? referencedBodyPath
            : existsSync(adjacentBodyPath)
              ? adjacentBodyPath
              : undefined;
    const referencedResponsePath = typeof files?.response === "string" ? files.response : undefined;
    const adjacentResponsePath = join(
        source.dir,
        metaFile.replace(/\.meta\.json$/, ".response.json"),
    );
    const responsePath =
        referencedResponsePath && existsSync(referencedResponsePath)
            ? referencedResponsePath
            : existsSync(adjacentResponsePath)
              ? adjacentResponsePath
              : undefined;
    return { bodyPath, responsePath };
}

function readDumpMetadata(directory: string, file: string, opts: Args): Json {
    const read = (): Json => {
        if (opts.scanMetrics) opts.scanMetrics.metaReads += 1;
        const meta = JSON.parse(readFileSync(join(directory, file), "utf8")) as Json;
        if (!opts.scanIndex) return meta;
        // Retain only fields the analyzer uses, not exporter previews of the body.
        const files = asJson(meta.files);
        const thread = asJson(asJson(meta.body)?.thread)?.type;
        return {
            session: String(meta.session ?? ""), createdAt: String(meta.createdAt ?? ""),
            step: finiteNumber(meta.step) ? meta.step : undefined,
            wire_family: typeof meta.wire_family === "string" ? meta.wire_family : undefined,
            route: typeof meta.route === "string" ? meta.route : undefined,
            files: { body: typeof files?.body === "string" ? files.body : undefined,
                response: typeof files?.response === "string" ? files.response : undefined },
            body: { thread: { type: thread === "create" || thread === "continue" ? thread : undefined } },
        };
    };
    return opts.scanIndex ? opts.scanIndex.metadata(directory, file, read) : read();
}

function discoverDumpCandidates(opts: Args): DumpCandidate[] {
    const candidates = new Map<string, DumpCandidate>();
    const since = resolveTimeBound(opts.since);
    const until = resolveTimeBound(opts.until);
    for (const source of opts.sources) {
        if (!existsSync(source.dir)) continue;
        for (const metaFile of listDumpFiles(source.dir, opts.scanMetrics).filter((file) =>
            file.endsWith(".meta.json"),
        )) {
            const parsedName = parseDumpFilename(metaFile);
            let meta: Json;
            try {
                meta = readDumpMetadata(source.dir, metaFile, opts);
            } catch {
                continue;
            }
            const metadataSession = String(meta.session ?? "");
            const session = parsedName?.session ?? metadataSession;
            if (!session || !sessionMatches(session, opts.sessionPrefix)) continue;
            const createdAt = parsedName?.createdAt ?? String(meta.createdAt ?? "");
            if (since && createdAt < since) continue;
            if (until && createdAt > until) continue;
            const { bodyPath } = artifactPaths(source, metaFile, meta);
            if (!bodyPath) continue;
            let bodyStat: ReturnType<typeof statSync>;
            try {
                if (opts.scanMetrics) opts.scanMetrics.fileStats += 1;
                bodyStat = statSync(bodyPath);
            } catch {
                continue;
            }
            const key = `${source.dir}\0${session}`;
            const existing = candidates.get(key) ?? {
                source,
                session,
                latestMtimeMs: 0,
                totalBytes: 0,
                dumpCount: 0,
            };
            existing.latestMtimeMs = Math.max(existing.latestMtimeMs, bodyStat.mtimeMs);
            existing.totalBytes += bodyStat.size;
            existing.dumpCount += 1;
            candidates.set(key, existing);
        }
    }
    return [...candidates.values()].sort(
        (left, right) =>
            right.latestMtimeMs - left.latestMtimeMs ||
            right.totalBytes - left.totalBytes ||
            left.session.localeCompare(right.session),
    );
}

function loadCandidateSnapshots(candidate: DumpCandidate, opts: Args, selectedFiles?: readonly string[]): Snapshot[] {
    const since = resolveTimeBound(opts.since);
    const until = resolveTimeBound(opts.until);
    const snapshots: Snapshot[] = [];
    for (const metaFile of selectedFiles ?? listDumpFiles(candidate.source.dir, opts.scanMetrics).filter((file) =>
        file.endsWith(".meta.json"),
    )) {
        if (opts.excludeKeepWarm && metaFile.includes("prewarm-cachekeep")) continue;
        const dumpName = parseDumpFilename(metaFile);
        if (dumpName && dumpName.session !== candidate.session) continue;
        let meta: Json;
        try {
            meta = readDumpMetadata(candidate.source.dir, metaFile, opts);
        } catch {
            continue;
        }
        const metadataSession = String(meta.session ?? "");
        if (!dumpName && metadataSession !== candidate.session) continue;
        const createdAt = dumpName?.createdAt ?? String(meta.createdAt ?? "");
        if (since && createdAt < since) continue;
        if (until && createdAt > until) continue;
        const { bodyPath, responsePath } = artifactPaths(candidate.source, metaFile, meta);
        if (!bodyPath) continue;
        // A recorded wire family decides the body shape and the meter; the
        // directory or filename only decides them when the dump does not say.
        const wireFamily =
            typeof meta.wire_family === "string" && meta.wire_family.length > 0
                ? meta.wire_family
                : undefined;
        const familyProvider = wireFamily ? WIRE_FAMILY_PROVIDERS[wireFamily] : undefined;
        try {
            if (opts.scanMetrics) opts.scanMetrics.bodyReads += 1;
            const rawBody = readFileSync(bodyPath);
            const body = JSON.parse(rawBody.toString("utf8")) as Json;
            const normalized = buildSegments(
                body,
                familyProvider ??
                    (candidate.source.label === "explicit --dir"
                        ? undefined
                        : candidate.source.provider),
            );
            // An unsupported family has no meter unless --meter forces one.
            const meter = opts.meter ?? (wireFamily ? familyProvider : normalized.provider);
            snapshots.push({
                file: metaFile,
                bodyPath,
                bodyBytes: rawBody.byteLength,
                createdAt,
                requestTimestampMs: Date.parse(dumpName?.createdAt ?? createdAt),
                session: candidate.session,
                messagesCount: normalized.segments.length,
                provider: normalized.provider,
                wireModel: wireModel(body),
                sourceDir: candidate.source.dir,
                segments: normalized.segments,
                statedCacheTtlMs: normalized.provider === "anthropic" ? requestCacheTtlMs(body) : undefined,
                threadType: normalized.provider === "anthropic" ? threadType(body, meta) : undefined,
                tools: normalized.provider === "anthropic" && body.tools !== undefined
                    ? { ...buildSegments({ system: body.tools }, "anthropic").segments[0], id: "tools role=system" }
                    : undefined,
                route: typeof meta.route === "string" && meta.route.length > 0 ? meta.route : undefined,
                ...loadResponseEvidence(responsePath, meter),
                orderCreatedAt: dumpName?.createdAt ?? createdAt,
                // Broca exports name files by run and step, not by time and
                // sequence; meta.step keeps same-millisecond steps in order.
                sequence: dumpName?.sequence ?? (finiteNumber(meta.step) ? meta.step : 0),
                ...(wireFamily ? { wireFamily } : {}),
                meter,
                ...(opts.meter ? { meterForced: true } : {}),
            });
        } catch {
            // Ignore malformed or partially written request bodies.
        }
    }
    snapshots.sort(
        (left, right) =>
            left.orderCreatedAt.localeCompare(right.orderCreatedAt) ||
            left.sequence - right.sequence ||
            left.file.localeCompare(right.file),
    );
    return opts.limit && snapshots.length > opts.limit
        ? snapshots.slice(snapshots.length - opts.limit)
        : snapshots;
}

/** Index small metadata first; normalize only the window and its comparison context. */
function loadWindowDumpSnapshots(
    args: Args,
    options: OpenCodeCacheBustAnalysisOptions,
    precedingRequestTimestampsMs: number[],
): Snapshot[] {
    const indexed: { candidate: DumpCandidate; file: string; createdAt: string; sequence: number }[] = [];
    for (const candidate of discoverDumpCandidates(args).filter((entry) => entry.session === options.sessionId)) {
        for (const file of listDumpFiles(candidate.source.dir, args.scanMetrics)) {
            if (!file.endsWith(".meta.json")) continue;
            const name = parseDumpFilename(file);
            if (name && name.session !== options.sessionId) continue;
            try {
                const meta = readDumpMetadata(candidate.source.dir, file, args);
                if (!name && String(meta.session ?? "") !== options.sessionId) continue;
                const createdAt = name?.createdAt ?? String(meta.createdAt ?? "");
                const timestamp = Date.parse(createdAt);
                if (!Number.isFinite(timestamp) || timestamp > (options.untilInclusiveMs ?? Infinity)) continue;
                indexed.push({ candidate, file, createdAt, sequence: name?.sequence ?? (finiteNumber(meta.step) ? meta.step : 0) });
            } catch {
                // Incomplete metadata cannot produce a request snapshot.
            }
        }
    }
    indexed.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sequence - right.sequence || left.file.localeCompare(right.file));
    const inWindow = (entry: typeof indexed[number]) => options.scanCursor
        ? `${String(Date.parse(entry.createdAt)).padStart(16, "0")}:${String(entry.sequence).padStart(8, "0")}:${entry.file}:${entry.candidate.source.provider}` > options.scanCursor
        : Date.parse(entry.createdAt) > (options.sinceExclusiveMs ?? -Infinity);
    const first = indexed.findIndex(inWindow);
    if (first < 0) return [];
    const load = (entry: typeof indexed[number]) => loadCandidateSnapshots(entry.candidate, args, [entry.file])[0];
    const loadedEntries = indexed.slice(first).flatMap((entry) => {
        const snapshot = load(entry);
        return snapshot ? [{ entry, snapshot }] : [];
    });
    if (!loadedEntries.some(({ entry }) => inWindow(entry))) return [];
    const loaded = loadedEntries.map(({ snapshot }) => snapshot);
    const context: Snapshot[] = [];
    let before = first;
    while (before > 0 && (context.length < 2 || options.sinceExclusiveMs === undefined)) {
        before -= 1;
        const snapshot = load(indexed[before]);
        if (snapshot) context.unshift(snapshot);
    }
    const selected = [...context, ...loaded];
    // Each request is joined to at most one transform-pass decision from Magic
    // Context's log (execute or defer), and a later request may not take a decision
    // an earlier one already took. So bodies before the window but within the cache
    // TTL of it are read only for their request times: those times claim their
    // decisions first without adding the requests to the result. Older requests can't
    // claim a decision this window could use, and an unreadable body claims none.
    const cutoff = selected.reduce((earliest, snapshot) => Math.min(earliest, snapshot.requestTimestampMs), Infinity) - DEFAULT_CACHE_TTL_MS;
    for (const entry of indexed.slice(0, before)) {
        if (Date.parse(entry.createdAt) < cutoff) continue;
        const snapshot = load(entry);
        if (snapshot) precedingRequestTimestampsMs.push(snapshot.requestTimestampMs);
    }
    return selected;
}

function loadSnapshotSelection(opts: Args): SnapshotSelection {
    const candidates = discoverDumpCandidates(opts);
    const selected = candidates[0];
    return {
        candidates,
        selected,
        snapshots: selected ? withThreadContext(loadCandidateSnapshots(selected, opts), opts) : [],
    };
}

function loadSnapshots(opts: Args): Snapshot[] {
    return loadSnapshotSelection(opts).snapshots;
}

function runnerSnapshots(runner: RunnerSession, dumps: readonly Snapshot[], forcedMeter?: BodyProvider): Snapshot[] {
    const unused = new Set(dumps);
    return runner.requests.map((request): Snapshot => {
        // Dump timestamps and meter creation times are separate clocks. Never
        // reuse one body for two steps or match across a long request gap.
        const dump = [...unused].filter((item) => Math.abs(item.requestTimestampMs - request.at) <= 60_000 &&
            !runner.requests.some((other) => Math.abs(item.requestTimestampMs - other.at) < Math.abs(item.requestTimestampMs - request.at)))
            .sort((a, b) => Math.abs(a.requestTimestampMs - request.at) - Math.abs(b.requestTimestampMs - request.at))[0];
        if (dump) unused.delete(dump);
        const meter = forcedMeter ?? runnerMeter(request);
        const reading = request.usage;
        const createdAt = new Date(request.at).toISOString();
        return {
            ...(dump ?? { file: request.id, bodyPath: "", bodyBytes: 0, messagesCount: 0, segments: [], sourceDir: "" }),
            session: runner.session, createdAt, orderCreatedAt: createdAt,
            requestTimestampMs: request.at, sequence: request.sequence,
            provider: meter ?? dump?.provider ?? "anthropic", meter,
            ...(forcedMeter ? { meterForced: true } : {}),
            wireModel: dump?.wireModel ?? request.model, runnerRequest: request, bytesMissing: !dump,
            usage: reading && meter ? {
                cacheRead: reading.cacheRead, cacheCreation: reading.cacheWrite, input: reading.input,
                output: reading.output, total: reading.input + reading.cacheRead + reading.cacheWrite,
                source: `${runner.kind} meter`, provider: meter, rule: METER_RULES[meter],
            } : undefined,
        };
    });
}

function keepWarmTouches(sources: readonly DumpSource[], session: string): { at: number; file: string }[] {
    return sources.flatMap((source) => !existsSync(source.dir) ? [] : listDumpFiles(source.dir).flatMap((file) => {
        if (!file.includes("prewarm-cachekeep") || !file.endsWith(".meta.json")) return [];
        const parsed = parseDumpFilename(file);
        const path = join(source.dir, file);
        try {
            const meta = JSON.parse(readFileSync(path, "utf8")) as Json;
            if ((parsed?.session ?? meta.session) !== session) return [];
            const at = Date.parse(parsed?.createdAt ?? String(meta.createdAt));
            return Number.isFinite(at) ? [{ at, file: path }] : [];
        } catch { return []; }
    }));
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function openCodeAnalyzerCommand(
    row: AnalysisRow,
    options: OpenCodeCacheBustAnalysisOptions,
): string {
    const args = [
        "cd packages/plugin && bun scripts/analyze-cache-busts.ts",
        "--session",
        shellQuote(options.sessionId),
        "--since",
        shellQuote(row.previous?.createdAt ?? row.current.createdAt),
        "--until",
        shellQuote(row.current.createdAt),
        "--show-diff",
        "--all-rows",
    ];
    if (options.mcLogPath) args.push("--mc-log", shellQuote(options.mcLogPath));
    if (options.anthropicDir) {
        args.push("--anthropic-dir", shellQuote(options.anthropicDir));
    }
    if (options.openaiDir) {
        args.push("--openai-dir", shellQuote(options.openaiDir));
    }
    return args.join(" ");
}

/** Analyze one exact OpenCode session without printing or mutating any source store. */
export function analyzeOpenCodeCacheBustSession(
    options: OpenCodeCacheBustAnalysisOptions,
): CacheBustSessionAnalysis & CacheBustScanProgress {
    const sources: DumpSource[] = [
        {
            provider: "anthropic",
            dir:
                options.anthropicDir ??
                process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR ??
                join(tmpdir(), "opencode-anthropic-auth-dumps"),
            label: "anthropic-auth",
        },
        {
            provider: "openai",
            dir:
                options.openaiDir ??
                process.env.OPENCODE_OPENAI_AUTH_DUMP_DIR ??
                join(tmpdir(), "opencode-openai-auth-dumps"),
            label: "openai-auth",
        },
    ];
    const args: Args = {
        sessionPrefix: options.sessionId,
        sources,
        source: "dumps",
        runnerDataDir: DEFAULT_RUNNER_DATA_DIR,
        showDiff: false,
        allBusts: false,
        allRows: true,
        help: false,
        scanMetrics: options.scanMetrics,
        scanIndex: options.scanIndex,
    };
    const scanNow = options.scanNow ?? Date.now;
    if (options.scanIndex) {
        for (const dir of new Set(sources.map((source) => source.dir))) options.scanIndex.refresh(dir, scanNow());
    }
    let filesExamined = 0;
    let nextCursor: string | undefined;
    let scanBounded = false;
    let pendingFiles = 0;
    let oldestPendingTimestampMs: number | undefined;
    let chosenKeys: Set<string> | undefined;
    let cursor: ReturnType<typeof selectScanBatch>["cursor"];
    let priorHighWaterMarkMs: number | null = null;
    const snapshotKey = (snapshot: Snapshot) => `${String(Date.parse(snapshot.createdAt)).padStart(16, "0")}:${String(snapshot.sequence).padStart(8, "0")}:${snapshot.file}:${sources.find((source) => source.dir === snapshot.sourceDir)?.provider}`;
    const precedingRequestTimestampsMs: number[] = [];
    const snapshots = options.scanDeadlineMs === undefined
        ? options.sinceExclusiveMs !== undefined || options.untilInclusiveMs !== undefined || options.scanCursor !== undefined
            ? loadWindowDumpSnapshots(args, options, precedingRequestTimestampsMs)
            : discoverDumpCandidates(args)
            .filter((candidate) => candidate.session === options.sessionId)
            .flatMap((candidate) => loadCandidateSnapshots(candidate, args))
        : (() => {
            // Read the newest request group first, preserving chronological pairs
            // within each group. New arrivals must not wait behind an old backlog.
            const indexed = sources.flatMap((source) => options.scanIndex
                ? options.scanIndex.entries(source.dir, options.sessionId).map((entry) => ({ ...entry, source }))
                : existsSync(source.dir)
                ? listDumpFiles(source.dir, options.scanMetrics).flatMap((file) => {
                    if (!file.endsWith(".meta.json")) return [];
                    const parsed = parseDumpFilename(file);
                    if (!parsed || parsed.session !== options.sessionId) return [];
                    return [{ source, file, timestamp: Date.parse(parsed.createdAt), sequence: parsed.sequence }];
                }) : []);
            indexed.sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence ||
                a.file.localeCompare(b.file) || a.source.provider.localeCompare(b.source.provider));
            const key = (entry: typeof indexed[number]) => `${String(entry.timestamp).padStart(16, "0")}:${String(entry.sequence).padStart(8, "0")}:${entry.file}:${entry.source.provider}`;
            const batch = selectScanBatch(indexed, key, { ...options, scanDeadlineMs: options.scanDeadlineMs!, scanNow });
            const { selected } = batch;
            chosenKeys = batch.chosenKeys;
            cursor = batch.cursor;
            priorHighWaterMarkMs = cursor?.highWaterMarkMs ?? null;
            filesExamined = batch.chosen.length;
            pendingFiles = batch.remaining.length;
            oldestPendingTimestampMs = batch.remaining[0]?.timestamp;
            scanBounded = pendingFiles > 0;
            // Earlier dump filenames reserve their passes without reopening old bodies.
            // Otherwise a bounded scan could reuse a pass claimed in a previous batch.
            precedingRequestTimestampsMs.push(
                ...indexed.filter((entry) => !selected.includes(entry))
                    .map((entry) => entry.timestamp),
            );
            return sources.flatMap((source) => loadCandidateSnapshots(
                { source, session: options.sessionId, latestMtimeMs: 0, totalBytes: 0, dumpCount: 0 },
                args, selected.filter((entry) => entry.source === source).map((entry) => entry.file),
            ));
        })();
    const contextualSnapshots = withThreadContext(snapshots, args);
    const inWindow = (snapshot: Snapshot): boolean =>
        (chosenKeys ? chosenKeys.has(snapshotKey(snapshot)) : options.scanCursor
            ? snapshotKey(snapshot) > options.scanCursor
            : options.sinceExclusiveMs === undefined || Date.parse(snapshot.createdAt) > options.sinceExclusiveMs) &&
        (options.untilInclusiveMs === undefined || Date.parse(snapshot.createdAt) <= options.untilInclusiveMs);
    const boundedSnapshots = contextualSnapshots.filter((snapshot) => {
        const timestampMs = Date.parse(snapshot.createdAt);
        return (
            Number.isFinite(timestampMs) &&
            (options.untilInclusiveMs === undefined || timestampMs <= options.untilInclusiveMs)
        );
    });
    const firstNewIndex = boundedSnapshots.findIndex((snapshot) =>
        inWindow(snapshot),
    );
    const analysisStart = options.sinceExclusiveMs === undefined || contextualSnapshots.some((snapshot) => snapshot.threadType !== undefined) ? 0 : Math.max(0, firstNewIndex - 2);
    const analysisSnapshots = firstNewIndex < 0 ? [] : boundedSnapshots.slice(analysisStart);
    precedingRequestTimestampsMs.push(
        ...boundedSnapshots.slice(0, analysisStart).map((snapshot) => snapshot.requestTimestampMs),
    );
    const rows = analyzeSnapshots(
        analysisSnapshots,
        withSchedulerLogFallback(options.decisions ?? [], options.sessionId, options.mcLogPath),
        { cacheTtlMs: options.cacheTtlMs, precedingRequestTimestampsMs: precedingRequestTimestampsMs.filter((at) => !analysisSnapshots.some((snapshot) => snapshot.requestTimestampMs === at)) },
    );
    const requests: AnalyzedCacheRequest[] = rows.flatMap((row) => {
        const timestampMs = Date.parse(row.current.createdAt);
            if (!Number.isFinite(timestampMs) || !inWindow(row.current)) return [];
        // This sentinel API reads dump pairs only, not runner meter-only rows.
        if (row.verdict === "PLAN_CHANGED" || row.verdict === "PROVIDER_FORGOT" || row.verdict === "SCOPE_CHANGED" || row.verdict === "EXPIRED" || row.verdict === "VIEW" || row.verdict === "UNEXPLAINED (no bytes)") {
            throw new Error("Runner-only verdict in OpenCode dump analysis");
        }
        const segment =
            row.divergenceIndex < 0
                ? undefined
                : (row.current.segments[row.divergenceIndex] ??
                  row.previous?.segments[row.divergenceIndex]);
        return [
            {
                session: row.current.session,
                at: row.current.createdAt,
                timestampMs,
                verdict: row.verdict,
                rewrittenTokens: row.rewrittenTokens,
                divergenceClass: row.divergenceClass,
                ...(row.providerCacheMissReason ? { providerCacheMissReason: row.providerCacheMissReason } : {}),
                firstDivergence:
                    row.verdict === "BASE"
                        ? "(first request)"
                        : (row.prefixDivergence?.id ?? row.comparisonNote ?? segment?.id ?? "(identical normalized prefix)"),
                analyzerCmd: openCodeAnalyzerCommand(row, options),
                ...(row.decision?.identityDelta
                    ? { identityDelta: row.decision.identityDelta }
                    : {}),
            },
        ];
    });
    const analyzedRequestTimestamps = boundedSnapshots
        .filter((snapshot) => !isUsageMissing(snapshot))
        .filter(inWindow)
        .map((snapshot) => Date.parse(snapshot.createdAt));
    const highWaterMarkMs = analyzedRequestTimestamps.length > 0
        ? Math.max(priorHighWaterMarkMs ?? -Infinity, ...analyzedRequestTimestamps) : priorHighWaterMarkMs;
    if (scanBounded && cursor) nextCursor = JSON.stringify({ ...cursor, highWaterMarkMs });
    return {
        requests,
        highWaterMarkMs,
        filesExamined,
        scanBounded,
        scanCursor: scanBounded ? nextCursor : undefined,
        pendingFiles,
        oldestPendingTimestampMs,
    };
}

function isUsageMissing(snapshot: Snapshot): boolean {
    const usage = snapshot.usage;
    return usage === undefined || (usage.cacheRead === 0 && usage.input === 0);
}

/** First wire-order segment index where prev/cur diverge (added/removed/changed). */
function firstDivergence(prev: Segment[], cur: Segment[]): number {
    const n = Math.min(prev.length, cur.length);
    for (let index = 0; index < n; index += 1) {
        if (prev[index].hash !== cur[index].hash || prev[index].id !== cur[index].id) return index;
    }
    return prev.length === cur.length ? -1 : n;
}

interface ByteComparison {
    previous: Snapshot;
    divergenceIndex: number;
    byteVerdict?: ByteVerdict;
    specialClass?: CacheBustAttributionInput["threadEvidence"];
    comparisonNote?: string;
    prefixDivergence?: Segment;
}

function compareClientBytes(current: Snapshot, previous: Snapshot, history: readonly Snapshot[]): ByteComparison {
    const route = history.filter((snapshot) => sameRoute(snapshot, current) && !snapshot.bytesMissing);
    const latest = route.at(-1);
    const continuation = current.threadType === "continue";
    const afterChain = !continuation && latest?.threadType === "continue";
    if (!continuation && !afterChain) {
        const divergenceIndex = firstDivergence(previous.segments, current.segments);
        return { previous, divergenceIndex, byteVerdict: bustsReusablePrefix(previous, current, divergenceIndex) ? "BUST" : "STABLE" };
    }
    // The provider keeps prior conversation bytes on a continuation. Only the
    // fully transmitted prefix can be compared with the preceding request.
    const prefixPrevious = latest ?? previous;
    const toolsChanged = prefixPrevious.tools?.hash !== current.tools?.hash;
    const previousSystem = prefixPrevious.segments.find((segment) => segment.role === "system");
    const currentSystem = current.segments.find((segment) => segment.role === "system");
    const systemChanged = previousSystem?.hash !== currentSystem?.hash;
    if (toolsChanged || systemChanged) {
        return { previous: prefixPrevious, divergenceIndex: 0, byteVerdict: "BUST", prefixDivergence: toolsChanged ? current.tools ?? prefixPrevious.tools : currentSystem ?? previousSystem };
    }
    if (continuation) return { previous: prefixPrevious, divergenceIndex: -1, specialClass: "continuation_short_read", comparisonNote: "(continuation; message bytes not comparable)" };

    let fullIndex = route.length - 1;
    while (fullIndex >= 0 && route[fullIndex].threadType === "continue") fullIndex -= 1;
    if (fullIndex < 0) return { previous, divergenceIndex: -1, specialClass: "full_body_no_baseline", comparisonNote: "(no earlier full body found; client bytes not comparable)" };
    const full = route[fullIndex];
    const first = firstDivergence(full.segments, current.segments);
    if (first >= 0 && first < full.segments.length) return { previous: full, divergenceIndex: first, byteVerdict: bustsReusablePrefix(full, current, first) ? "BUST" : "STABLE" };

    // Reply content is absent from response dumps. Skip those assistant slots,
    // but compare every sent client message in order, including repeated text.
    const expected = [...full.segments];
    let cursor = full.segments.length;
    let matched = full.segments.filter((segment) => segment.role !== "system").length;
    for (const delta of route.slice(fullIndex + 1)) {
        for (const segment of delta.segments.filter((item) => item.role !== "system")) {
            while (current.segments[cursor]?.role === "assistant") {
                expected[cursor] = current.segments[cursor];
                cursor += 1;
            }
            expected[cursor] = { ...segment, id: `message[${cursor}] ${describeNormalizedMessage(segment)}` };
            if (current.segments[cursor]?.hash !== segment.hash) {
                return { previous: { ...full, segments: expected }, divergenceIndex: cursor, byteVerdict: "BUST" };
            }
            cursor += 1;
            matched += 1;
        }
    }
    return { previous: full, divergenceIndex: -1, byteVerdict: "STABLE", specialClass: "thread_break_unchanged_client_bytes", comparisonNote: `(${matched} client messages compared and matched; reply bytes not dumped)` };
}

function isTailShrink(previous: Snapshot, current: Snapshot, divergenceIndex: number): boolean {
    if (divergenceIndex < 0) return false;
    const previousTail = previous.segments[divergenceIndex];
    const currentTail = current.segments[divergenceIndex];
    if (!previousTail) return false;
    if (!currentTail) return divergenceIndex === current.segments.length;
    if (
        divergenceIndex !== current.segments.length - 1 ||
        divergenceIndex < Math.max(0, previous.segments.length - 2)
    ) {
        return false;
    }
    if (
        currentTail.role !== previousTail.role ||
        currentTail.bytes >= previousTail.bytes ||
        currentTail.parts.length !== previousTail.parts.length
    ) {
        return false;
    }
    let shortenedPart = false;
    for (let index = 0; index < currentTail.parts.length; index += 1) {
        const currentPart = currentTail.parts[index];
        const previousPart = previousTail.parts[index];
        if (
            !currentPart ||
            !previousPart ||
            currentPart.type !== previousPart.type ||
            currentPart.length > previousPart.length ||
            !previousPart.comparePrefix.startsWith(currentPart.comparePrefix)
        ) {
            return false;
        }
        shortenedPart ||= currentPart.length < previousPart.length;
    }
    return shortenedPart;
}

/** Effective cached prefix = bytes up to the last breakpoint strictly before divergence. */
function cachedPrefixBytes(segs: Segment[], divergeIdx: number): { bytes: number; at: string } {
    let bytes = 0;
    let lastBreakpointBytes = 0;
    let lastBreakpointId = "(none)";
    const limit = divergeIdx < 0 ? segs.length : divergeIdx;
    for (let index = 0; index < segs.length; index += 1) {
        if (index < limit && segs[index].breakpoint) {
            lastBreakpointBytes = bytes + segs[index].bytes;
            lastBreakpointId = segs[index].id;
        }
        bytes += segs[index].bytes;
    }
    return { bytes: lastBreakpointBytes, at: lastBreakpointId };
}

function lastBreakpointIndex(segs: Segment[]): number {
    let last = -1;
    for (let index = 0; index < segs.length; index += 1) {
        if (segs[index].breakpoint) last = index;
    }
    return last;
}

/**
 * Does the divergence land inside the prefix the previous request left cached?
 *
 * Anthropic writes the cache at the breakpoints of the request that was sent, so
 * the reusable prefix ends at the PREVIOUS request's last breakpoint. Measuring
 * against the CURRENT request's last breakpoint instead made every appended
 * message look like a bust: this client moves its tail cache_control marker onto
 * the newest message, so the marker always sat at or after the append and the
 * append always looked like it fell inside a cached prefix that did not yet
 * exist. OpenAI has no breakpoints — its prefix cache is implicit, so only an
 * in-place change or removal inside the previous prompt busts it.
 */
function bustsReusablePrefix(
    previous: Snapshot,
    current: Snapshot,
    divergenceIndex: number,
): boolean {
    if (divergenceIndex < 0) return false;
    return isImplicitPrefixCache(current.provider)
        ? divergenceIndex < previous.segments.length
        : divergenceIndex <= lastBreakpointIndex(previous.segments);
}

export function analyzeSnapshots(
    snaps: readonly Snapshot[],
    decisionsAndMarkers: readonly CacheBustDecisionAttribution[] = [],
    options: { cacheTtlMs?: number; precedingRequestTimestampsMs?: readonly number[]; runnerEvidence?: RunnerEvidence; cacheTouches?: readonly number[] } = {},
): AnalysisRow[] {
    const previousRequestByRoute = new Map<string, Snapshot>();
    const previousRequestBySession = new Map<string, Snapshot>();
    const renders = joinRequestsToViews(snaps.map((snapshot) => snapshot.requestTimestampMs), options.runnerEvidence?.renders ?? []);
    // When the reusable prefix was last read in full or written; see
    // refreshesCachedPrefix for which requests move it.
    let prefixRefreshedAtMs: number | undefined;
    // Disruption markers explain a following epoch HARD but never serve a request, so
    // they stay out of every request join.
    const decisions = decisionsAndMarkers.filter((record) => record.disruption === undefined);
    const joinDecision = createCacheBustDecisionJoiner(decisions);
    const reservations = [...(options.precedingRequestTimestampsMs ?? [])].sort((a, b) => a - b);
    let reservationIndex = 0;
    const disruptions = decisionsAndMarkers.filter(
        (record) =>
            record.disruption !== undefined ||
            ["error", "need_full_sync", "parked"].includes(record.decision.toLowerCase()),
    );
    // Only an adapter log that recorded this session's passes can show that nothing
    // disrupted it; without one the disruption question stays unanswered.
    const disruptionEvidence = decisionsAndMarkers.some(
        (record) => record.source === "rust pass log",
    );
    const precedingDisruption = (
        pass: CacheBustDecisionAttribution | undefined,
    ): string | null | undefined => {
        if (!pass || !disruptionEvidence) return undefined;
        const latest = disruptions
            .filter(
                (record) =>
                    record.timestampMs <= pass.timestampMs &&
                    pass.timestampMs - record.timestampMs <= 60_000,
            )
            .sort((left, right) => left.timestampMs - right.timestampMs)
            .at(-1);
        return latest ? (latest.disruption ?? latest.decision.toLowerCase()) : null;
    };
    let previousShortRead = false;
    let previousBustDivergenceIndex: number | undefined;
    let previousMetered: Snapshot | undefined;
    let previousMeteredDecision: CacheBustDecisionAttribution | undefined;
    // Last metered request before the current run of LATENCY rows (Gemini only).
    let latencyReference: Snapshot | undefined;
    const rows: AnalysisRow[] = [];
    for (let index = 0; index < snaps.length; index += 1) {
        const current = snaps[index];
        const previousSessionRequest = previousRequestBySession.get(current.session);
        previousRequestBySession.set(current.session, current);
        const scopeChange = cacheScopeChange(current, previousSessionRequest);
        const routeKey = JSON.stringify([current.session, current.provider, current.sourceDir]);
        const previousRouteRequest = previousRequestByRoute.get(routeKey);
        previousRequestByRoute.set(routeKey, current);
        const cacheTtlMs = options.cacheTtlMs ??
            (previousRouteRequest?.bytesMissing ? undefined : previousRouteRequest?.statedCacheTtlMs) ??
            (current.runnerRequest ? 3_600_000 : DEFAULT_CACHE_TTL_MS);
        const render = renders[index];
        const joinedAt = render?.at ?? current.requestTimestampMs;
        const previousAt = renders[index - 1]?.at ?? snaps[index - 1]?.requestTimestampMs ?? joinedAt;
        const runnerDecisions = options.runnerEvidence
            ? runnerDecisionsBetween(options.runnerEvidence, previousAt, joinedAt, render?.view)
            : undefined;
        const requestFields = {
            runnerClassification: undefined as RunnerStepClassification | undefined,
            ...(current.runnerRequest ? {
                runnerDecisions: runnerDecisions?.all, renderedView: render?.view,
                viewJoin: render ? "time" as const : "unmatched" as const,
            } : {}),
            ...(current.providerCacheMissReason ? { providerCacheMissReason: current.providerCacheMissReason } : {}),
        };
        // BASE, STABLE, and unmetered requests claim passes too, not just busts.
        while (reservationIndex < reservations.length && reservations[reservationIndex] < current.requestTimestampMs) {
            joinDecision(reservations[reservationIndex++]);
        }
        const decision = joinDecision(current.requestTimestampMs);
        if (isUsageMissing(current)) {
            const previous = previousMetered;
            const comparison = previous ? compareClientBytes(current, previous, snaps.slice(0, index)) : undefined;
            const divergenceIndex = comparison?.divergenceIndex ?? -1;
            const byteVerdict = previous && !previous.bytesMissing && !current.bytesMissing ? comparison?.byteVerdict : undefined;
            rows.push({
                current,
                previous: comparison?.previous ?? previous,
                divergenceIndex,
                byteVerdict,
                verdict: "UNMETERED",
                meterVsBytes: "UNMETERED",
                divergenceClass: "usage_missing",
                comparisonNote: comparison?.comparisonNote,
                prefixDivergence: comparison?.prefixDivergence,
                ...requestFields,
            });
            continue;
        }
        if (!previousMetered) {
            rows.push({ current, divergenceIndex: -1, verdict: "BASE", decision, ...requestFields });
            previousMetered = current;
            previousMeteredDecision = decision;
            prefixRefreshedAtMs = current.requestTimestampMs;
            continue;
        }
        const previous = previousMetered;
        if (!previous.usage || !current.usage) continue;
        // Implicit-prefix forgiveness is the previous request's uncached input: its
        // tail may not be cached yet. After a provider-side miss that input is the
        // whole prompt, which would forgive any read at all, so a Gemini request
        // that follows a run of LATENCY rows is measured against the last request
        // before the run. The run kept the prefix byte-identical (that is what
        // makes it LATENCY), so that earlier read is still owed. A BUST resets the
        // reference because it really did rewrite the prefix.
        const reference =
            previous.usage.provider === "gemini" && latencyReference?.usage
                ? latencyReference
                : previous;
        const referenceUsage = reference.usage ?? previous.usage;
        const prevTotal = referenceUsage.total;
        // Anthropic-style breakpoints: the read alone must cover what the previous
        // request read or wrote; uncached input_tokens never count as reuse.
        const explicitBreakpoints = !isImplicitPrefixCache(current.usage.provider);
        // Gemini's cachedContentTokenCount over a byte-identical prefix routinely
        // reads a few tokens (8-9 in Code Assist exports) below the previous read,
        // so the 64-token allowance is added on top of the previous uncached input
        // instead of only standing in for a smaller one. Without it every such dip
        // reads as a short read.
        const epsilon = explicitBreakpoints
            ? CACHE_READ_EPSILON_TOKENS
            : referenceUsage.provider === "gemini"
              ? 64 + referenceUsage.input
              : Math.max(64, referenceUsage.input);
        // For the implicit caches, prevTotal - epsilon is at most the previous
        // read: the previous uncached tail may not be cached yet.
        const meterFloor = explicitBreakpoints
            ? cachedPrefixFloor({
                  read: referenceUsage.cacheRead,
                  write: referenceUsage.cacheCreation ?? 0,
                  input: referenceUsage.input,
              })
            : prevTotal - epsilon;
        // Only the provider cache read counts as reuse, on every meter. OpenAI's
        // and Gemini's uncached prompt tokens include rewritten prefix tokens, and
        // Anthropic's input_tokens are billed in full and cached nothing.
        const comparableRead = current.usage.cacheRead;
        // A rewrite cannot use the prior rewrite's direct input as forgiveness
        // while cacheRead remains at the same floor.
        const rebust: boolean =
            previousShortRead && current.usage.cacheRead <= previous.usage.cacheRead;
        const noBytes = current.bytesMissing || previous.bytesMissing;
        const shortRead: boolean = current.runnerRequest && current.usage.provider === "anthropic"
            ? comparableRead < meterFloor : rebust || comparableRead < meterFloor;
        previousShortRead = shortRead;
        const reading = {
            read: current.usage.cacheRead,
            write: current.usage.cacheCreation ?? 0,
            input: current.usage.input,
        };
        const lastTouch = options.cacheTouches?.filter((at) => at <= current.requestTimestampMs).reduce((latest, at) => Math.max(latest, at), -Infinity);
        if (lastTouch !== undefined && lastTouch > (prefixRefreshedAtMs ?? -Infinity)) prefixRefreshedAtMs = lastTouch;
        const previousRequestAt = snaps[index - 1]?.requestTimestampMs ?? previous.requestTimestampMs;
        const runnerGapMs = current.requestTimestampMs - Math.max(previousRequestAt, lastTouch ?? -Infinity);
        if (current.runnerRequest && shortRead) {
            requestFields.runnerClassification = classifyRunnerStep(
                { at: previous.requestTimestampMs, model: previous.runnerRequest?.model ?? previous.wireModel ?? "", read: previous.usage.cacheRead, write: previous.usage.cacheCreation ?? 0 },
                { at: current.requestTimestampMs, model: current.runnerRequest.model, read: current.usage.cacheRead, write: current.usage.cacheCreation ?? 0 },
                options.runnerEvidence?.decisions ?? [], {
                    cacheTtlMs: options.cacheTtlMs ?? previousRouteRequest?.statedCacheTtlMs,
                    lastTouchAt: Number.isFinite(lastTouch) ? lastTouch : undefined,
                    previousCompletedAt: previous.runnerRequest?.completedAt,
                    scopeChange,
                },
            );
        }
        if (shortRead && scopeChange && !noBytes) {
            const scopePrevious = previousSessionRequest ?? previous;
            rows.push({
                current, previous: scopePrevious, divergenceIndex: -1, verdict: "SHORT",
                meterVsBytes: "N/A", comparisonNote: scopeChange, divergenceClass: "cache_scope_changed",
                shortRead, meterFloor, comparableRead, epsilon, prevTotal,
                ...(reference !== scopePrevious ? { meterReference: reference } : {}),
                rewrittenTokens: current.usage.cacheCreation ?? Math.max(0, prevTotal - current.usage.cacheRead),
                decision, ...requestFields,
            });
            previousMetered = current;
            previousMeteredDecision = decision;
            latencyReference = undefined;
            previousBustDivergenceIndex = undefined;
            if (refreshesCachedPrefix(reading, { shortRead, explicitBreakpoints })) prefixRefreshedAtMs = current.requestTimestampMs;
            continue;
        }
        const comparison = compareClientBytes(current, previous, snaps.slice(0, index));
        const { divergenceIndex, byteVerdict } = comparison;
        const comparisonPrevious = comparison.previous;
        // Once a runner's cache has expired, changing bytes cannot incur an
        // additional cache miss. Preserve the diff as evidence, not a bust.
        if (current.runnerRequest && shortRead) {
            const classification = requestFields.runnerClassification!;
            const verdicts = { scope_changed: "SCOPE_CHANGED", view: "VIEW", plan_changed: "PLAN_CHANGED", provider_forgot: "PROVIDER_FORGOT", expired: "EXPIRED", unexplained: "UNEXPLAINED (no bytes)" } as const;
            if (noBytes || classification.class === "expired") {
            rows.push({ current, previous, divergenceIndex: noBytes ? -1 : divergenceIndex,
                ...(noBytes ? {} : { byteVerdict }), verdict: verdicts[classification.class ?? "unexplained"], shortRead, meterFloor,
                comparableRead, epsilon, prevTotal, idleGapMs: runnerGapMs,
                ...(classification.class === "expired" ? { divergenceClass: "idle_cache_expiry" as const } : {}),
                rewrittenTokens: classification.rewrittenTokens, ...requestFields });
            previousMetered = current;
            previousMeteredDecision = decision;
            latencyReference = undefined;
            previousBustDivergenceIndex = undefined;
            if (refreshesCachedPrefix(reading, { shortRead, explicitBreakpoints })) prefixRefreshedAtMs = current.requestTimestampMs;
            continue;
            }
        }
        if (noBytes) {
            // Without both wire bodies, identical empty segment arrays prove
            // nothing. Only elapsed cache lifetime or logged view changes can
            // explain a short read; never call it provider latency or a BUST.
            const idleGapMs = runnerGapMs;
            const verdict: MeterVerdict = !shortRead ? "STABLE"
                : runnerDecisions?.changes.length ? "VIEW" : "UNEXPLAINED (no bytes)";
            rows.push({ current, previous, divergenceIndex: -1, verdict, shortRead, meterFloor,
                comparableRead, epsilon, prevTotal, idleGapMs, ...requestFields });
            previousMetered = current;
            previousMeteredDecision = decision;
            latencyReference = undefined;
            continue;
        }
        const idleGapMs =
            current.runnerRequest ? runnerGapMs : current.requestTimestampMs - (prefixRefreshedAtMs ?? previous.requestTimestampMs);
        const idleCacheExpiry =
            shortRead &&
            (current.runnerRequest ? runnerGapMs > cacheTtlMs : isIdleCacheExpiry(
                current.requestTimestampMs,
                prefixRefreshedAtMs ?? previous.requestTimestampMs,
                cacheTtlMs,
            ));
        const missingBreakpointAfterRead = isMissingBreakpointAfterRead(reading, {
            shortRead,
            explicitBreakpoints,
        });
        if (refreshesCachedPrefix(reading, { shortRead, explicitBreakpoints })) {
            prefixRefreshedAtMs = current.requestTimestampMs;
        }
        // A missing breakpoint is the request's own shape, not provider latency,
        // so it is a BUST even when the reusable bytes are unchanged.
        const verdict: MeterVerdict = shortRead
            ? comparison.specialClass ? "SHORT" : byteVerdict === "BUST" || (missingBreakpointAfterRead && !idleCacheExpiry)
                ? "BUST"
                : "LATENCY"
            : "STABLE";
        latencyReference = verdict === "LATENCY" ? reference : undefined;
        const meterVsBytes: MeterVsBytes =
            byteVerdict === undefined ? "N/A" : verdict === "LATENCY"
                ? "LATENCY"
                : verdict === "STABLE" && byteVerdict === "BUST"
                  ? "BYTES-ONLY"
                  : "AGREE";
        const rewrittenTokens =
            verdict === "BUST" || verdict === "LATENCY" || verdict === "SHORT"
                ? (current.usage.cacheCreation ?? Math.max(0, prevTotal - current.usage.cacheRead))
                : undefined;
        const attributionDecision =
            rebust && byteVerdict === "STABLE" && previousMeteredDecision?.materialized
                ? previousMeteredDecision
                : decision;
        const divergentSegment =
            divergenceIndex < 0
                ? undefined
                 : (comparison.prefixDivergence ?? current.segments[divergenceIndex] ?? comparisonPrevious.segments[divergenceIndex]);
        const tailShrink = isTailShrink(comparisonPrevious, current, divergenceIndex);
        // A LATENCY row is also classified: a short read over an unchanged reusable
        // prefix is a provider-side fact and deserves a name, not a blank cell.
        const divergenceClass =
            verdict === "SHORT" || verdict === "BUST" || verdict === "LATENCY"
                ? classifyCacheBust({
                      hostMessagesRemoved: decisionsAndMarkers.some((record) =>
                          record.disruption === "host_messages_removed" &&
                          record.timestampMs > (previousSessionRequest?.requestTimestampMs ?? previous.requestTimestampMs) &&
                          record.timestampMs <= current.requestTimestampMs),
                      threadEvidence: comparison.specialClass,
                      providerCacheMissReason: current.providerCacheMissReason?.type,
                      providerShortReadWithIdenticalPrefix: verdict === "LATENCY",
                      divergenceIndex,
                      previousMessageCount: comparisonPrevious.segments.length,
                      previousBustDivergenceIndex,
                      idleCacheExpiry,
                      missingBreakpointAfterRead,
                      previousProvider: previous.provider,
                      currentProvider: current.provider,
                      firstDivergenceRole: divergentSegment?.role,
                      firstDivergenceSize: divergentSegment?.bytes,
                      rewrittenTokens,
                      cacheCreationTokens: current.usage.cacheCreation,
                      promptTokens: prevTotal,
                      tailShrink,
                      providerComparableRead: current.usage.cacheRead,
                      directInput: current.usage.input,
                       previousTotal: prevTotal,
                        previousModel: scopeWireModel(previousSessionRequest),
                        currentModel: scopeWireModel(current),
                       ocInputStepRatio: (() => {
                           if (attributionDecision?.inputCount === undefined) return undefined;
                           const recentCounts = decisions
                               .filter(
                                   (candidate) =>
                                       candidate.inputCount !== undefined &&
                                       candidate.inputCount > 0 &&
                                       candidate.timestampMs < attributionDecision.timestampMs &&
                                       attributionDecision.timestampMs - candidate.timestampMs <= 120_000,
                               )
                               .map((candidate) => candidate.inputCount as number);
                           return recentCounts.length > 0
                               ? attributionDecision.inputCount / Math.min(...recentCounts)
                               : undefined;
                       })(),
                        inheritedFold: attributionDecision !== decision,
                      contentEvidence: [comparisonPrevious, current]
                          .flatMap((snapshot) =>
                              snapshot.segments.slice(
                                  Math.max(0, divergenceIndex - 2),
                                  Math.max(0, divergenceIndex + 4),
                              ),
                          )
                          .map((segment) => segment.canonical)
                          .join("\n"),
                      decision: attributionDecision,
                      previousEpochHard: attributionDecision
                          ? decisions
                                .filter(
                                    (candidate) =>
                                        candidate.timestampMs < attributionDecision.timestampMs &&
                                        candidate.materialized &&
                                        candidate.materializeReason?.toLowerCase() === "epoch_change",
                                )
                                .at(-1)
                          : undefined,
                      precedingDisruption: precedingDisruption(attributionDecision),
                  })
                : undefined;
        previousBustDivergenceIndex = verdict === "BUST" ? divergenceIndex : undefined;
        previousMetered = current;
        previousMeteredDecision = decision;
        rows.push({
            current,
            previous: comparisonPrevious,
            divergenceIndex,
            byteVerdict,
            verdict,
            meterVsBytes,
            prevTotal,
            ...(reference !== comparisonPrevious ? { meterReference: reference } : {}),
            epsilon,
            meterFloor,
            comparableRead,
            shortRead,
            idleGapMs,
            rewrittenTokens,
            divergenceClass,
            comparisonNote: comparison.comparisonNote,
            prefixDivergence: comparison.prefixDivergence,
            decision: attributionDecision,
            ...requestFields,
        });
    }
    return rows;
}

function fmtTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const mi = String(date.getUTCMinutes()).padStart(2, "0");
    const ss = String(date.getUTCSeconds()).padStart(2, "0");
    return `${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
}

/** The printable form of a segment: reasoning content redacted, never the raw canonical. */
function segmentText(snapshot: Snapshot, index: number): string | undefined {
    return index < 0 ? undefined : snapshot.segments[index]?.display;
}

function clippedDiff(text: string, start: number, end: number): string {
    const before = text.slice(Math.max(0, start - 120), start);
    const changed = text.slice(start, Math.min(end, start + 240));
    const after = text.slice(end, end + 120);
    return `${start > 120 ? "…" : ""}${before}[${changed}${end - start > 240 ? "…" : ""}]${after}${end + 120 < text.length ? "…" : ""}`;
}

function printSegmentDiff(previous: Snapshot, current: Snapshot, index: number): void {
    const prevText = segmentText(previous, index) ?? "(segment absent)";
    const curText = segmentText(current, index) ?? "(segment absent)";
    let start = 0;
    while (start < prevText.length && start < curText.length && prevText[start] === curText[start])
        start += 1;
    let prevEnd = prevText.length;
    let curEnd = curText.length;
    while (prevEnd > start && curEnd > start && prevText[prevEnd - 1] === curText[curEnd - 1]) {
        prevEnd -= 1;
        curEnd -= 1;
    }
    console.log(`          └─ segment diff @char ${start}:`);
    console.log(`             prev: ${clippedDiff(prevText, start, prevEnd)}`);
    console.log(`             cur:  ${clippedDiff(curText, start, curEnd)}`);
}

function printProviderCacheMiss(row: AnalysisRow): void {
    const reason = row.providerCacheMissReason;
    if (!reason) return;
    const missed = reason.cacheMissedInputTokens;
    console.log(`          └─ provider says: ${reason.type}${missed === undefined ? "" : `, ${missed.toLocaleString()} missed`}`);
}

function meterCell(row: AnalysisRow): string {
    if (row.verdict === "UNMETERED") return `unavailable; bytes=${row.byteVerdict}`;
    const read = row.current.usage?.cacheRead ?? 0;
    const rewritten =
        row.rewrittenTokens === undefined
            ? ""
            : `; rewritten≈${row.rewrittenTokens.toLocaleString()}`;
    const directInput = row.current.usage?.input ?? 0;
    const comparable = isImplicitPrefixCache(row.current.usage?.provider ?? row.current.provider)
        ? `cached=${read.toLocaleString()}`
        : `read=${read.toLocaleString()} (write=${(row.current.usage?.cacheCreation ?? 0).toLocaleString()}, uncached input=${directInput.toLocaleString()})`;
    const wireModel =
        row.previous?.wireModel &&
        row.current.wireModel &&
        row.previous.wireModel !== row.current.wireModel
            ? `; wireModel=${row.previous.wireModel} → ${row.current.wireModel}`
            : "";
    const reference = row.meterReference
        ? `; ref=${fmtTime(row.meterReference.createdAt)} (${row.current.provider === "gemini" ? "last read before the LATENCY run" : "meter baseline"})`
        : "";
    const floorBasis = isImplicitPrefixCache(row.current.usage?.provider ?? row.current.provider)
        ? `prevTotal=${row.prevTotal?.toLocaleString()}, ε=${row.epsilon?.toLocaleString()}`
        : `prev read+write-${row.epsilon?.toLocaleString()}; prevTotal=${row.prevTotal?.toLocaleString()}`;
    const gap = row.current.runnerRequest && row.shortRead && row.idleGapMs !== undefined
        ? `; gap=${(row.idleGapMs / 60_000).toFixed(1)}m` : "";
    return `${comparable}; floor=${row.meterFloor?.toLocaleString()} (${floorBasis})${reference}${rewritten}${wireModel}${gap}`;
}

const HELP = `usage: bun scripts/analyze-cache-busts.ts --session <prefix> [options]

Sources (runner meters are auto-detected by exact session id):
  OC2:       thalamus-harness/opencode2-server/data/opencode/opencode.db (read-only WAL).
  Pi:        thalamus-pi/hosted-heads/*.json resolves the Pi session UUID to JSONL.
  Runners:   ck-mc daily logs plus step_render logs; nearest-time request/view join.
             OC2 dumps: thalamus-harness/opencode2-server/tmp/opencode-anthropic-auth-dumps.
             Pi dumps: thalamus-pi/anthropic-auth-dumps. Bodies are read in place.
              Without both bodies: SCOPE_CHANGED, VIEW, PLAN_CHANGED, PROVIDER_FORGOT,
              EXPIRED, or UNEXPLAINED (no bytes). Setup alone is never a cause.
              Keep-warm sends touch the cache but are never steps or byte baselines.
  Astrocyte: --source astrocyte reads the daemon's usage.steps.read feed (24h);
             Anthropic meters and ck-mc logs, no request bodies or runner stores.
  Anthropic: <tmp>/opencode-anthropic-auth-dumps (OPENCODE_ANTHROPIC_AUTH_DUMP_DIR)
             system + messages[] bodies; explicit read/write cache meters.
  OpenAI:    <tmp>/opencode-openai-auth-dumps (OPENCODE_OPENAI_AUTH_DUMP_DIR)
             Responses instructions + input[] bodies; implicit prefix cache,
             prompt_tokens_details.cached_tokens, and no write premium.
             WebSocket captures can have no response file and are UNMETERED.
  Broca:     cache-dump exports (pass the export dir as --dir). meta.json
             wire_family picks the body shape and meter: anthropic_messages,
             openai_responses(_chatgpt), gemini and google_codeassist (Gemini
             usageMetadata: promptTokenCount includes cachedContentTokenCount).

Any analysed request without a usable meter reading makes the run refuse with
a named reason (meter_missing / wire_family_unsupported) and exit 2 instead of
printing a clean result.

Options:
  --source <kind>       auto (default), dumps (OC1/Broca), oc2, pi, or astrocyte
  --connection-file <p> daemon connection file for the astrocyte source
  --runner-data-dir <p> CortexKit data root (default: ~/.local/share/cortexkit)
  --dump-dir <path>     override the runner dump directory
  --mc-log <path>       override ck-mc daily logs, or legacy scheduler log fallback
  --dir <path>          inspect one explicit directory (legacy override)
  --anthropic-dir <p>   override the Anthropic source
  --openai-dir <path>   override the OpenAI source
  --meter <kind>        force the anthropic, openai, or gemini meter for every request
  --since/--until <t>   ISO timestamp or duration ago (for example 2h)
  --limit <N>           keep the last N requests in range
  --cache-ttl <dur>     override the previous same-route body's longest stated
                         breakpoint ttl (fallback: 1h for runners, 5m for dumps)
  --show-diff           print both versions of the first-diverging message
  --all-busts           list every diverging message
  --all-rows            also print STABLE and UNMETERED rows`;

async function main(): Promise<void> {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log(HELP);
        return;
    }
    if (!opts.sessionPrefix) {
        console.error(HELP);
        process.exit(1);
    }
    if (opts.source === "astrocyte") {
        const client = await SubcClient.connect({ connectionFile: opts.connectionFile ?? join(getDataDir(), "cortexkit/run/subc-connection.json"), handshakeTimeoutMs: 2000 });
        try {
            const now = Date.now();
            const rows = await analyzeRunnerFeed(new AstrocyteRunnerMeterSource(async () => client),
                loadRunnerHeads(opts.runnerDataDir, now, opts.mcLogPath), opts.sessionPrefix,
                { since: opts.since ? Date.parse(resolveTimeBound(opts.since, now)!) : undefined,
                    until: opts.until ? Date.parse(resolveTimeBound(opts.until, now)!) : undefined });
            printRunnerFeedAnalysis(rows);
        } finally { client.close(); }
        return;
    }
    const runner = opts.source === "dumps" ? undefined : loadRunnerSession(
        opts.runnerDataDir, opts.sessionPrefix, opts.source === "auto" ? undefined : opts.source,
    );
    if (!runner && (opts.source === "oc2" || opts.source === "pi")) {
        throw new Error(`No ${opts.source} runner meter found for session ${opts.sessionPrefix} under ${opts.runnerDataDir}`);
    }
    if (runner) opts.sources = [
        { provider: "anthropic", dir: opts.dumpDir ?? runnerDumpDirectory(opts.runnerDataDir, runner.kind), label: `${runner.kind} anthropic-auth` },
        ...opts.sources,
    ];
    else if (opts.dumpDir) opts.sources = [{ provider: "anthropic", dir: opts.dumpDir, label: "explicit --dump-dir" }];
    const dumpOptions = runner ? { ...opts, since: undefined, until: undefined, limit: undefined, excludeKeepWarm: true } : opts;
    const selection: SnapshotSelection = runner ? { snapshots: [], candidates: [] } : loadSnapshotSelection(dumpOptions);
    const dumps = runner ? discoverDumpCandidates(dumpOptions)
        .filter((candidate) => candidate.session === runner.session)
        .flatMap((candidate) => loadCandidateSnapshots(candidate, dumpOptions)) : selection.snapshots;
    const allSnaps = runner ? runnerSnapshots(runner, dumps, opts.meter) : dumps;
    const since = resolveTimeBound(opts.since);
    const until = resolveTimeBound(opts.until);
    const evidence = runner ? loadRunnerEvidence(opts.runnerDataDir, runner, opts.mcLogPath, {
        sinceMs: since ? Date.parse(since) : undefined, untilMs: until ? Date.parse(until) : undefined,
    }) : undefined;
    const touches = runner ? keepWarmTouches(opts.sources, runner.session) : [];
    let rows = analyzeSnapshots(
        allSnaps,
        runner ? [] : withSchedulerLogFallback([], allSnaps[0]?.session ?? opts.sessionPrefix, opts.mcLogPath),
        { cacheTtlMs: opts.cacheTtl ? parseCacheTtl(opts.cacheTtl) : undefined, runnerEvidence: evidence, cacheTouches: touches.map((touch) => touch.at) },
    );
    rows = rows.filter((row) => (!since || row.current.createdAt >= since) && (!until || row.current.createdAt <= until));
    if (opts.limit && rows.length > opts.limit) rows = rows.slice(-opts.limit);
    const snaps = rows.map((row) => row.current);
    if (snaps.length === 0) {
        const searched = opts.sources.map((source) => source.dir).join(", ");
        console.error(`No ${runner ? "runner requests in range" : "dumps"} found for session prefix "${opts.sessionPrefix}" in ${searched}`);
        process.exit(1);
    }
    if (selection.candidates.length > 1) {
        console.log(`Ambiguous session prefix "${opts.sessionPrefix}"; candidates:`);
        for (const candidate of selection.candidates) {
            console.log(
                `  ${candidate.session} provider=${candidate.source.provider} mtime=${new Date(candidate.latestMtimeMs).toISOString()} size=${candidate.totalBytes.toLocaleString()}B dumps=${candidate.dumpCount} dir=${candidate.source.dir}`,
            );
        }
        console.log(
            `Using newest candidate ${selection.selected?.session} from ${selection.selected?.source.dir}.`,
        );
        console.log("");
    }
    const provider = snaps[0].provider;
    const meterKind = snaps[0].meter ?? provider;
    const meterRule =
        snaps.find((snapshot) => snapshot.usage)?.usage?.rule ?? METER_RULES[meterKind];
    const wireFamilies = [
        ...new Set(snaps.flatMap((snapshot) => (snapshot.wireFamily ? [snapshot.wireFamily] : []))),
    ];
    const meterKinds = [
        ...new Set(snaps.map((snapshot) => snapshot.meter ?? "none")),
    ];
    // Dumps without a recorded wire family and without --meter keep the original
    // header byte for byte; the extra lines describe a choice those dumps never had.
    const describeMeterChoice = wireFamilies.length > 0 || opts.meter !== undefined;
    console.log(`Session:  ${snaps[0].session}`);
    if (runner) console.log(`Source: ${runner.kind}; files read: ${[...runner.files, ...(evidence?.files ?? []), ...touches.map((touch) => touch.file)].join(", ")}; dump directories: ${opts.sources.map((source) => source.dir).join(", ")}`);
    if (runner) console.log(`Runner: ${runner.requests.length} metered step(s); ${touches.length} keep-warm cache touch(es), never steps or byte baselines. Request/view join: nearest time within 60s, once per render. Cache lifetime: ${opts.cacheTtl ?? "previous same-route body's longest stated breakpoint TTL (fallback: 1h)"}.`);
    if (runner) console.log(`Models: ${[...new Set(snaps.map((snapshot) => `${snapshot.runnerRequest?.provider}/${snapshot.runnerRequest?.model}${snapshot.runnerRequest?.variant ? ` (variant=${snapshot.runnerRequest.variant})` : ""}`))].join(", ")}`);
    console.log(
        wireFamilies.length > 0
            ? `Provider: ${provider} (from wire_family; searched as ${selection.selected?.source.label})`
            : `Provider: ${provider} (${runner ? `${runner.kind} meter` : selection.selected?.source.label})`,
    );
    if (describeMeterChoice) {
        console.log(
            `Wire family: ${wireFamilies.length > 0 ? wireFamilies.join(", ") : "absent (filename/directory detection)"}`,
        );
        console.log(
            `Meter:    ${meterKinds.map((kind) => (kind === "none" ? "none (wire family has no meter)" : `${kind} (${METER_FIELDS[kind]})`)).join(", ")}${opts.meter ? " (forced by --meter)" : ""}`,
        );
    }
    console.log(`Dumps:    ${snaps.filter((snapshot) => !snapshot.bytesMissing).length}  (dir: ${snaps.find((snapshot) => snapshot.sourceDir)?.sourceDir ?? "none; bytes unavailable"})`);
    if (runner) console.log(`Bytes read in place: ${dumps.map((dump) => dump.bodyPath).join(", ") || "none"}`);
    console.log("");
    console.log("Dashboard times are local (UTC+2); table times are UTC.");
    const shortRule =
        meterKind === "gemini"
            ? "Short when the provider-comparable read < prevTotal - ε, ε=64 + previous uncached input, measured from the last request before a run of LATENCY rows"
            : meterKind === "anthropic"
              ? "Short when the cache read < previous read + previous write - 64, and a short read with no write and ≥1,024 uncached input tokens is a missing-breakpoint BUST"
              : "Short when the provider-comparable read < prevTotal - ε, ε=max(64, previous direct/uncached input)";
    console.log(
        `Meter rule (${meterKind}): ${meterRule}. ${shortRule}; bytes distinguish BUST from LATENCY.`,
    );
    console.log(
        "time(UTC)          | segs | verdict          | meter                                                  | meterVsBytes | first-divergence                | prevBodyBytes → curBodyBytes | reusableNormalizedPrefix@breakpoint",
    );
    console.log(
        "-------------------|------|------------------|--------------------------------------------------------|--------------|---------------------------------|-----------------------------|------------------------",
    );

    let bustCount = 0;
    let latencyCount = 0;
    let shortCount = 0;
    let unmeteredBustCount = 0;
    for (const row of rows) {
        if (row.current.runnerRequest && (row.current.bytesMissing || row.previous?.bytesMissing)) {
            if (opts.allRows || row.providerCacheMissReason || !["BASE", "STABLE"].includes(row.verdict)) {
                console.log(`${fmtTime(row.current.createdAt)} | ${row.verdict} | read=${row.current.usage?.cacheRead ?? "unavailable"} write=${row.current.usage?.cacheCreation ?? "unavailable"} input=${row.current.usage?.input ?? "unavailable"} floor=${row.meterFloor ?? "—"} gap=${row.idleGapMs === undefined ? "—" : `${(row.idleGapMs / 60_000).toFixed(1)}m`} | bytes unavailable | view=${row.renderedView ?? "none"} (join=${row.viewJoin})`);
                if (row.divergenceClass === "cache_scope_changed") console.log(`          └─ cache_scope_changed: ${row.comparisonNote}`);
                printProviderCacheMiss(row);
                if (row.runnerClassification) console.log(`          └─ ${row.runnerClassification.class} | ${formatRunnerStepTiming(row.runnerClassification)} | ${row.runnerClassification.evidence}`);
                for (const event of row.runnerDecisions ?? []) console.log(`          └─ ck-mc ${event.kind}: ${event.detail}`);
            }
            continue;
        }
        if (row.verdict === "BASE") {
            if (opts.allRows || row.providerCacheMissReason) {
                console.log(
                    `${fmtTime(row.current.createdAt)} | ${(row.current.threadType === "continue" ? `${row.current.messagesCount - (row.current.segments[0]?.role === "system" ? 1 : 0)}c` : String(row.current.segments.length)).padStart(4)} | BASE             |                                                        |              | (first request)                 |                             |`,
                );
                printProviderCacheMiss(row);
            }
            continue;
        }
        const shouldPrint =
            opts.allRows ||
            row.providerCacheMissReason ||
            row.verdict === "BUST" ||
            row.verdict === "LATENCY" ||
            row.verdict === "SHORT" ||
            row.verdict === "EXPIRED" ||
            (row.verdict === "UNMETERED" && row.byteVerdict === "BUST");
        if (!shouldPrint) continue;
        if (row.verdict === "BUST") bustCount += 1;
        if (row.verdict === "LATENCY") latencyCount += 1;
        if (row.verdict === "SHORT") shortCount += 1;
        if (row.verdict === "UNMETERED" && row.byteVerdict === "BUST") unmeteredBustCount += 1;

        const previous = row.previous;
        if (!previous) {
            // An unmetered request with no metered predecessor has nothing to diff
            // against; it is still listed so the refusal below has visible rows.
            console.log(
                `${fmtTime(row.current.createdAt)} | ${(row.current.threadType === "continue" ? `${row.current.messagesCount - (row.current.segments[0]?.role === "system" ? 1 : 0)}c` : String(row.current.segments.length)).padStart(4)} | ${"UNMETERED".padEnd(16)} | ${"unavailable; no metered predecessor".padEnd(54)} | ${(row.meterVsBytes ?? "").padEnd(12)} | ${"(no metered predecessor)".padEnd(31)} | ${`${row.current.bodyBytes.toLocaleString()}B`.padEnd(27)} |`,
            );
            printProviderCacheMiss(row);
            continue;
        }
        const index = row.divergenceIndex;
        const segment =
            index < 0 ? undefined : (row.current.segments[index] ?? previous.segments[index]);
        const attribution = row.prefixDivergence?.id ?? row.comparisonNote ?? (row.verdict === "EXPIRED" ? "(expired cache)" : segment
            ? `${segment.id} (bytes ${row.byteVerdict})`
            : `(identical; bytes ${row.byteVerdict})`);
        const currentPrefix = cachedPrefixBytes(row.current.segments, index);
        const byteDelta = `${previous.bodyBytes.toLocaleString()}B → ${row.current.bodyBytes.toLocaleString()}B`;
        const verdictLabel =
            row.verdict === "UNMETERED"
                ? `UNMETERED (bytes ${row.byteVerdict})`
                : `${row.verdict} (meter)`;
        console.log(
            `${fmtTime(row.current.createdAt)} | ${(row.current.threadType === "continue" ? `${row.current.messagesCount - (row.current.segments[0]?.role === "system" ? 1 : 0)}c` : String(row.current.segments.length)).padStart(4)} | ${verdictLabel.padEnd(16)} | ${meterCell(row).padEnd(54)} | ${(row.meterVsBytes ?? "").padEnd(12)} | ${attribution.padEnd(31)} | ${byteDelta.padEnd(27)} | ${row.byteVerdict === undefined ? "(not comparable)" : `${currentPrefix.at} (${currentPrefix.bytes.toLocaleString()}B)`}`,
        );
        printProviderCacheMiss(row);
        if (row.verdict === "EXPIRED" && segment) {
            console.log(`          └─ bytes also changed at ${segment.id}`);
        }
        if (row.divergenceClass) {
            console.log(`          └─ divergence-class: ${row.divergenceClass}`);
        }
        if (runner) {
            if (row.runnerClassification) console.log(`          └─ runner-class: ${row.runnerClassification.class}; ${formatRunnerStepTiming(row.runnerClassification)}; ${row.runnerClassification.evidence}`);
            console.log(`          └─ view=${row.renderedView ?? "none"} (join=${row.viewJoin})`);
            for (const event of row.runnerDecisions ?? []) console.log(`          └─ ck-mc ${event.kind}: ${event.detail}`);
        }

        if (
            (opts.showDiff || opts.allBusts) &&
            index >= 0 &&
            (row.byteVerdict === "BUST" || opts.allRows)
        ) {
            if (opts.allBusts) {
                const diffs: number[] = [];
                const count = Math.max(previous.segments.length, row.current.segments.length);
                for (let diffIndex = index; diffIndex < count; diffIndex += 1) {
                    if (
                        previous.segments[diffIndex]?.hash !==
                            row.current.segments[diffIndex]?.hash ||
                        previous.segments[diffIndex]?.id !== row.current.segments[diffIndex]?.id
                    ) {
                        diffs.push(diffIndex);
                    }
                }
                for (const diffIndex of diffs) {
                    console.log(
                        `          └─ diverge @${diffIndex}: prev=${previous.segments[diffIndex]?.id ?? "—"}/${previous.segments[diffIndex]?.hash ?? "—"}  cur=${row.current.segments[diffIndex]?.id ?? "—"}/${row.current.segments[diffIndex]?.hash ?? "—"}`,
                    );
                }
            }
            if (opts.showDiff) {
                if (row.prefixDivergence?.id.startsWith("tools")) printSegmentDiff({ ...previous, segments: previous.tools ? [previous.tools] : [] }, { ...row.current, segments: row.current.tools ? [row.current.tools] : [] }, 0);
                else printSegmentDiff(previous, row.current, index);
            }
        }
    }

    console.log("");
    const coverage = meterCoverage(snaps);
    if (describeMeterChoice || coverage.refusals.length > 0) {
        console.log(
            `Metered:  ${coverage.metered} of ${coverage.analysed} analysed request(s) carry a usable meter reading.`,
        );
    }
    if (coverage.refusals.length > 0) {
        // A request whose meter was never read cannot count as "not a bust", so
        // a clean summary would be vacuous. Positive findings on the metered
        // requests are still printed; the clean-result line never is.
        if (bustCount > 0) {
            console.log(
                `${bustCount} metered bust(s) across ${coverage.metered} metered request(s).`,
            );
        }
    } else if (runner && rows.some((row) => row.current.bytesMissing || row.previous?.bytesMissing)) {
        console.log(`No-bytes short reads: ${["EXPIRED", "VIEW", "PLAN_CHANGED", "PROVIDER_FORGOT", "SCOPE_CHANGED", "UNEXPLAINED (no bytes)"].map((verdict) => `${verdict}=${rows.filter((row) => row.verdict === verdict).length}`).join(", ")}. Byte-attributed metered busts: ${bustCount}.`);
    } else if (bustCount === 0 && shortCount > 0) {
        console.log(`No byte-attributed metered busts; ${shortCount} metered short read(s) without a demonstrated byte rewrite across ${snaps.length} request(s).`);
    } else if (bustCount === 0) {
        console.log(`No metered busts across ${snaps.length} request(s).`);
    } else {
        console.log(
            `${bustCount} metered bust(s) across ${snaps.length} request(s).${opts.allRows ? "" : " (STABLE rows hidden; pass --all-rows to show them.)"}`,
        );
    }
    if (latencyCount > 0) {
        console.log(
            `${latencyCount} latency-only short read(s) had no reusable-prefix byte divergence.`,
        );
    }
    const expiryCount = rows.filter((row) => row.divergenceClass === "idle_cache_expiry").length;
    if (expiryCount > 0) {
        console.log(
            `${expiryCount} short read(s) came more than ${opts.cacheTtl ?? "the previous same-route body's stated cache lifetime (fallback: 1h for runners, 5m for plugin dumps)"} ${runner ? "since the previous request or keep-warm cache touch" : "after the prefix was last read in full or written"} (idle_cache_expiry; --cache-ttl changes the window).`,
        );
    }
    if (unmeteredBustCount > 0) {
        console.log(
            `${unmeteredBustCount} unmetered byte-attributed bust candidate(s); response usage was unavailable.`,
        );
    }
    if (coverage.refusals.length > 0) {
        for (const refusal of coverage.refusals) console.log(refusal);
        console.log(
            "Refusing to report a clean result: the meter was not read on every analysed request.",
        );
        process.exitCode = 2;
    }
}

interface MeterCoverage {
    analysed: number;
    metered: number;
    /** One named reason per (wire family, meter) group of unmetered requests. */
    refusals: string[];
}

/**
 * Count the requests whose meter was actually read and name every group that
 * was not. A missing meter is not a cache hit: before this check a Gemini dump
 * read with the OpenAI meter looked unmetered on every request and the analyzer
 * still printed "No metered busts".
 */
function meterCoverage(snaps: readonly Snapshot[]): MeterCoverage {
    const groups = new Map<string, { count: number; snapshot: Snapshot }>();
    let metered = 0;
    for (const snapshot of snaps) {
        if (!isUsageMissing(snapshot)) {
            metered += 1;
            continue;
        }
        const key = `${snapshot.wireFamily ?? ""}\0${snapshot.meter ?? ""}`;
        const group = groups.get(key) ?? { count: 0, snapshot };
        group.count += 1;
        groups.set(key, group);
    }
    const refusals = [...groups.values()].map(({ count, snapshot }) => {
        const family = `wire_family=${snapshot.wireFamily ?? "absent"}`;
        if (!snapshot.meter) {
            return `wire_family_unsupported: ${count} of ${snaps.length} requests carry ${family}, which has no meter in this analyzer`;
        }
        const forced = snapshot.meterForced ? "; meter forced by --meter" : "";
        return `meter_missing: ${count} of ${snaps.length} requests carry no ${snapshot.meter} usage (${METER_FIELDS[snapshot.meter]}) (${family}${forced})`;
    });
    return { analysed: snaps.length, metered, refusals };
}

export const __test = {
    analyzeSnapshots,
    loadMeterUsage,
    loadSnapshots,
    meterCoverage,
    parseArgs,
    parseDumpFilename,
    resolveTimeBound,
    runnerSnapshots,
    keepWarmTouches,
};

if (import.meta.main) await main();
