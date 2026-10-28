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
 * Any provider: a short read more than --cache-ttl (default 5m) after the prefix
 * was last read in full or written is `idle_cache_expiry`.
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
 *   --cache-ttl <d>  idle time after which the provider prefix is expired (default 5m)
 *   --show-diff      print before/after snippet of the first-diverging segment
 *   --all-busts      list every diverging segment, not just the first
 *   --all-rows       also print STABLE and UNMETERED rows
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AnalyzedCacheRequest,
    type CacheBustDecisionAttribution,
    type CacheBustDivergenceClass,
    type CacheBustSessionAnalysis,
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

type Json = Record<string, unknown>;
type ByteVerdict = "BUST" | "STABLE";
type MeterVerdict = ByteVerdict | "LATENCY" | "UNMETERED";
type MeterVsBytes = "AGREE" | "BYTES-ONLY" | "LATENCY" | "UNMETERED";

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
    /** Idle time after which the provider prefix counts as expired; default 5 min. */
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
    const session = /(?:^|-)(ses_[A-Za-z0-9]+)(?=-|\.meta\.json$)/.exec(file);
    if (!timestamp || !session) return null;
    const rest = file.slice(timestamp.index + timestamp[0].length);
    const sequence = /-(\d+)(?=-ses_)/.exec(rest);
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
    if (!responsePath || !existsSync(responsePath)) return undefined;
    try {
        const candidates: MeterUsage[] = [];
        for (const payload of parseResponsePayloads(readFileSync(responsePath, "utf8"))) {
            collectUsageCandidates(payload, "response", provider, candidates);
        }
        return candidates.at(-1);
    } catch {
        return undefined;
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

function discoverDumpCandidates(opts: Args): DumpCandidate[] {
    const candidates = new Map<string, DumpCandidate>();
    const since = resolveTimeBound(opts.since);
    const until = resolveTimeBound(opts.until);
    for (const source of opts.sources) {
        if (!existsSync(source.dir)) continue;
        for (const metaFile of readdirSync(source.dir).filter((file) =>
            file.endsWith(".meta.json"),
        )) {
            const parsedName = parseDumpFilename(metaFile);
            let meta: Json;
            try {
                meta = JSON.parse(readFileSync(join(source.dir, metaFile), "utf8")) as Json;
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
    for (const metaFile of selectedFiles ?? readdirSync(candidate.source.dir).filter((file) =>
        file.endsWith(".meta.json"),
    )) {
        const dumpName = parseDumpFilename(metaFile);
        if (dumpName && dumpName.session !== candidate.session) continue;
        let meta: Json;
        try {
            meta = JSON.parse(readFileSync(join(candidate.source.dir, metaFile), "utf8")) as Json;
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
                usage: meter ? loadMeterUsage(responsePath, meter) : undefined,
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

function loadSnapshotSelection(opts: Args): SnapshotSelection {
    const candidates = discoverDumpCandidates(opts);
    const selected = candidates[0];
    return {
        candidates,
        selected,
        snapshots: selected ? loadCandidateSnapshots(selected, opts) : [],
    };
}

function loadSnapshots(opts: Args): Snapshot[] {
    return loadSnapshotSelection(opts).snapshots;
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
): CacheBustSessionAnalysis & { filesExamined: number; scanBounded: boolean; scanCursor?: string } {
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
        showDiff: false,
        allBusts: false,
        allRows: true,
        help: false,
    };
    const scanNow = options.scanNow ?? Date.now;
    let filesExamined = 0;
    let nextCursor: string | undefined;
    let scanBounded = false;
    const precedingRequestTimestampsMs: number[] = [];
    const snapshots = options.scanDeadlineMs === undefined
        ? discoverDumpCandidates(args)
            .filter((candidate) => candidate.session === options.sessionId)
            .flatMap((candidate) => loadCandidateSnapshots(candidate, args))
        : (() => {
            // Filenames carry session and request time; only open new files and two
            // preceding requests needed for the first comparison in the batch.
            const indexed = sources.flatMap((source) => existsSync(source.dir)
                ? readdirSync(source.dir).flatMap((file) => {
                    if (!file.endsWith(".meta.json")) return [];
                    const parsed = parseDumpFilename(file);
                    if (!parsed || parsed.session !== options.sessionId) return [];
                    return [{ source, file, timestamp: Date.parse(parsed.createdAt), sequence: parsed.sequence }];
                }) : []);
            indexed.sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence ||
                a.file.localeCompare(b.file) || a.source.provider.localeCompare(b.source.provider));
            const key = (entry: typeof indexed[number]) => `${String(entry.timestamp).padStart(16, "0")}:${String(entry.sequence).padStart(8, "0")}:${entry.file}:${entry.source.provider}`;
            const pending = indexed.filter((entry) => entry.timestamp <= (options.untilInclusiveMs ?? Infinity) &&
                (options.scanCursor ? key(entry) > options.scanCursor : entry.timestamp > (options.sinceExclusiveMs ?? -Infinity)));
            const chosen: typeof indexed = [];
            for (const entry of pending) {
                if (chosen.length && (chosen.length >= 32 || scanNow() >= options.scanDeadlineMs!)) {
                    scanBounded = true;
                    break;
                }
                chosen.push(entry);
            }
            filesExamined = chosen.length;
            if (chosen.length) nextCursor = key(chosen.at(-1)!);
            const first = indexed.indexOf(chosen[0]);
            const selected = first < 0 ? [] : [...indexed.slice(Math.max(0, first - 2), first), ...chosen];
            // Earlier dump filenames reserve their passes without reopening old bodies.
            // Otherwise a bounded scan could reuse a pass claimed in a previous batch.
            precedingRequestTimestampsMs.push(
                ...indexed
                    .slice(0, first < 0 ? 0 : Math.max(0, first - 2))
                    .map((entry) => entry.timestamp),
            );
            return sources.flatMap((source) => loadCandidateSnapshots(
                { source, session: options.sessionId, latestMtimeMs: 0, totalBytes: 0, dumpCount: 0 },
                args, selected.filter((entry) => entry.source === source).map((entry) => entry.file),
            ));
        })();
    snapshots.sort(
        (left, right) =>
            left.orderCreatedAt.localeCompare(right.orderCreatedAt) ||
            left.sequence - right.sequence ||
            left.file.localeCompare(right.file),
    );
    const inWindow = (snapshot: Snapshot): boolean =>
        (options.scanCursor
            ? `${String(Date.parse(snapshot.createdAt)).padStart(16, "0")}:${String(snapshot.sequence).padStart(8, "0")}:${snapshot.file}:${sources.find((source) => source.dir === snapshot.sourceDir)?.provider}` > options.scanCursor
            : options.sinceExclusiveMs === undefined || Date.parse(snapshot.createdAt) > options.sinceExclusiveMs) &&
        (options.untilInclusiveMs === undefined || Date.parse(snapshot.createdAt) <= options.untilInclusiveMs);
    const boundedSnapshots = snapshots.filter((snapshot) => {
        const timestampMs = Date.parse(snapshot.createdAt);
        return (
            Number.isFinite(timestampMs) &&
            (options.untilInclusiveMs === undefined || timestampMs <= options.untilInclusiveMs)
        );
    });
    const firstNewIndex = boundedSnapshots.findIndex((snapshot) =>
        inWindow(snapshot),
    );
    const analysisStart = options.sinceExclusiveMs === undefined ? 0 : Math.max(0, firstNewIndex - 2);
    const analysisSnapshots = firstNewIndex < 0 ? [] : boundedSnapshots.slice(analysisStart);
    precedingRequestTimestampsMs.push(
        ...boundedSnapshots.slice(0, analysisStart).map((snapshot) => snapshot.requestTimestampMs),
    );
    const rows = analyzeSnapshots(
        analysisSnapshots,
        withSchedulerLogFallback(options.decisions ?? [], options.sessionId, options.mcLogPath),
        { cacheTtlMs: options.cacheTtlMs, precedingRequestTimestampsMs },
    );
    const requests: AnalyzedCacheRequest[] = rows.flatMap((row) => {
        const timestampMs = Date.parse(row.current.createdAt);
            if (!Number.isFinite(timestampMs) || !inWindow(row.current)) return [];
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
                firstDivergence:
                    row.verdict === "BASE"
                        ? "(first request)"
                        : (segment?.id ?? "(identical normalized prefix)"),
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
    return {
        requests,
        highWaterMarkMs:
            analyzedRequestTimestamps.length > 0 ? Math.max(...analyzedRequestTimestamps) : null,
        filesExamined,
        scanBounded,
        scanCursor: scanBounded ? nextCursor : undefined,
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
            !previousPart.textPrefix.startsWith(currentPart.textPrefix)
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
    options: { cacheTtlMs?: number; precedingRequestTimestampsMs?: readonly number[] } = {},
): AnalysisRow[] {
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    // When the reusable prefix was last read in full or written; see
    // refreshesCachedPrefix for which requests move it.
    let prefixRefreshedAtMs: number | undefined;
    // Disruption markers explain a following epoch HARD but never serve a request, so
    // they stay out of every request join.
    const decisions = decisionsAndMarkers.filter((record) => record.disruption === undefined);
    const joinDecision = createCacheBustDecisionJoiner(decisions);
    for (const timestampMs of options.precedingRequestTimestampsMs ?? []) joinDecision(timestampMs);
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
        // BASE, STABLE, and unmetered requests claim passes too, not just busts.
        const decision = joinDecision(current.requestTimestampMs);
        if (isUsageMissing(current)) {
            const previous = previousMetered;
            const divergenceIndex = previous
                ? firstDivergence(previous.segments, current.segments)
                : -1;
            const byteVerdict = previous
                ? bustsReusablePrefix(previous, current, divergenceIndex)
                    ? "BUST"
                    : "STABLE"
                : undefined;
            rows.push({
                current,
                previous,
                divergenceIndex,
                byteVerdict,
                verdict: "UNMETERED",
                meterVsBytes: "UNMETERED",
                divergenceClass: "usage_missing",
            });
            continue;
        }
        if (!previousMetered) {
            rows.push({ current, divergenceIndex: -1, verdict: "BASE", decision });
            previousMetered = current;
            previousMeteredDecision = decision;
            prefixRefreshedAtMs = current.requestTimestampMs;
            continue;
        }
        const previous = previousMetered;
        if (!previous.usage || !current.usage) continue;
        const divergenceIndex = firstDivergence(previous.segments, current.segments);
        const byteVerdict: ByteVerdict = bustsReusablePrefix(previous, current, divergenceIndex)
            ? "BUST"
            : "STABLE";
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
        const shortRead: boolean = rebust || comparableRead < meterFloor;
        previousShortRead = shortRead;
        const reading = {
            read: current.usage.cacheRead,
            write: current.usage.cacheCreation ?? 0,
            input: current.usage.input,
        };
        const idleGapMs =
            current.requestTimestampMs - (prefixRefreshedAtMs ?? previous.requestTimestampMs);
        const idleCacheExpiry =
            shortRead &&
            isIdleCacheExpiry(
                current.requestTimestampMs,
                prefixRefreshedAtMs ?? previous.requestTimestampMs,
                cacheTtlMs,
            );
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
            ? byteVerdict === "BUST" || (missingBreakpointAfterRead && !idleCacheExpiry)
                ? "BUST"
                : "LATENCY"
            : "STABLE";
        latencyReference = verdict === "LATENCY" ? reference : undefined;
        const meterVsBytes: MeterVsBytes =
            verdict === "LATENCY"
                ? "LATENCY"
                : verdict === "STABLE" && byteVerdict === "BUST"
                  ? "BYTES-ONLY"
                  : "AGREE";
        const rewrittenTokens =
            verdict === "BUST" || verdict === "LATENCY"
                ? (current.usage.cacheCreation ?? Math.max(0, prevTotal - current.usage.cacheRead))
                : undefined;
        const attributionDecision =
            rebust && byteVerdict === "STABLE" && previousMeteredDecision?.materialized
                ? previousMeteredDecision
                : decision;
        const divergentSegment =
            divergenceIndex < 0
                ? undefined
                : (current.segments[divergenceIndex] ?? previous.segments[divergenceIndex]);
        const tailShrink = isTailShrink(previous, current, divergenceIndex);
        // A LATENCY row is also classified: a short read over an unchanged reusable
        // prefix is a provider-side fact and deserves a name, not a blank cell.
        const divergenceClass =
            verdict === "BUST" || verdict === "LATENCY"
                ? classifyCacheBust({
                      providerShortReadWithIdenticalPrefix: verdict === "LATENCY",
                      divergenceIndex,
                      previousMessageCount: previous.segments.length,
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
                       previousModel: previous.wireModel,
                       currentModel: current.wireModel,
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
                      contentEvidence: [previous, current]
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
            previous,
            divergenceIndex,
            byteVerdict,
            verdict,
            meterVsBytes,
            prevTotal,
            ...(reference !== previous ? { meterReference: reference } : {}),
            epsilon,
            meterFloor,
            comparableRead,
            shortRead,
            idleGapMs,
            rewrittenTokens,
            divergenceClass,
            decision: attributionDecision,
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

function segmentText(snapshot: Snapshot, index: number): string | undefined {
    return index < 0 ? undefined : snapshot.segments[index]?.canonical;
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
        ? `; ref=${fmtTime(row.meterReference.createdAt)} (last read before the LATENCY run)`
        : "";
    const floorBasis = isImplicitPrefixCache(row.current.usage?.provider ?? row.current.provider)
        ? `prevTotal=${row.prevTotal?.toLocaleString()}, ε=${row.epsilon?.toLocaleString()}`
        : `prev read+write-${row.epsilon?.toLocaleString()}; prevTotal=${row.prevTotal?.toLocaleString()}`;
    return `${comparable}; floor=${row.meterFloor?.toLocaleString()} (${floorBasis})${reference}${rewritten}${wireModel}`;
}

const HELP = `usage: bun scripts/analyze-cache-busts.ts --session <prefix> [options]

Sources (both searched by default):
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
  --mc-log <path>       scheduler log fallback (default: MAGIC_CONTEXT_LOG_PATH or harness log)
  --dir <path>          inspect one explicit directory (legacy override)
  --anthropic-dir <p>   override the Anthropic source
  --openai-dir <path>   override the OpenAI source
  --meter <kind>        force the anthropic, openai, or gemini meter for every request
  --since/--until <t>   ISO timestamp or duration ago (for example 2h)
  --limit <N>           keep the last N requests in range
  --cache-ttl <dur>     idle time after which the provider prefix counts as
                        expired (default 5m; for example 1h)
  --show-diff           print both versions of the first-diverging message
  --all-busts           list every diverging message
  --all-rows            also print STABLE and UNMETERED rows`;

function main(): void {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log(HELP);
        return;
    }
    if (!opts.sessionPrefix) {
        console.error(HELP);
        process.exit(1);
    }
    const selection = loadSnapshotSelection(opts);
    const snaps = selection.snapshots;
    if (snaps.length === 0) {
        const searched = opts.sources.map((source) => source.dir).join(", ");
        console.error(`No dumps found for session prefix "${opts.sessionPrefix}" in ${searched}`);
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
    const rows = analyzeSnapshots(
        snaps,
        withSchedulerLogFallback([], snaps[0].session, opts.mcLogPath),
        { cacheTtlMs: parseCacheTtl(opts.cacheTtl) },
    );
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
    console.log(
        wireFamilies.length > 0
            ? `Provider: ${provider} (from wire_family; searched as ${selection.selected?.source.label})`
            : `Provider: ${provider} (${selection.selected?.source.label})`,
    );
    if (describeMeterChoice) {
        console.log(
            `Wire family: ${wireFamilies.length > 0 ? wireFamilies.join(", ") : "absent (filename/directory detection)"}`,
        );
        console.log(
            `Meter:    ${meterKinds.map((kind) => (kind === "none" ? "none (wire family has no meter)" : `${kind} (${METER_FIELDS[kind]})`)).join(", ")}${opts.meter ? " (forced by --meter)" : ""}`,
        );
    }
    console.log(`Dumps:    ${snaps.length}  (dir: ${snaps[0].sourceDir})`);
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
    let unmeteredBustCount = 0;
    for (const row of rows) {
        if (row.verdict === "BASE") {
            if (opts.allRows) {
                console.log(
                    `${fmtTime(row.current.createdAt)} | ${String(row.current.segments.length).padStart(4)} | BASE             |                                                        |              | (first request)                 |                             |`,
                );
            }
            continue;
        }
        const shouldPrint =
            opts.allRows ||
            row.verdict === "BUST" ||
            row.verdict === "LATENCY" ||
            (row.verdict === "UNMETERED" && row.byteVerdict === "BUST");
        if (!shouldPrint) continue;
        if (row.verdict === "BUST") bustCount += 1;
        if (row.verdict === "LATENCY") latencyCount += 1;
        if (row.verdict === "UNMETERED" && row.byteVerdict === "BUST") unmeteredBustCount += 1;

        const previous = row.previous;
        if (!previous) {
            // An unmetered request with no metered predecessor has nothing to diff
            // against; it is still listed so the refusal below has visible rows.
            console.log(
                `${fmtTime(row.current.createdAt)} | ${String(row.current.segments.length).padStart(4)} | ${"UNMETERED".padEnd(16)} | ${"unavailable; no metered predecessor".padEnd(54)} | ${(row.meterVsBytes ?? "").padEnd(12)} | ${"(no metered predecessor)".padEnd(31)} | ${`${row.current.bodyBytes.toLocaleString()}B`.padEnd(27)} |`,
            );
            continue;
        }
        const index = row.divergenceIndex;
        const segment =
            index < 0 ? undefined : (row.current.segments[index] ?? previous.segments[index]);
        const attribution = segment
            ? `${segment.id} (bytes ${row.byteVerdict})`
            : `(identical; bytes ${row.byteVerdict})`;
        const currentPrefix = cachedPrefixBytes(row.current.segments, index);
        const byteDelta = `${previous.bodyBytes.toLocaleString()}B → ${row.current.bodyBytes.toLocaleString()}B`;
        const verdictLabel =
            row.verdict === "UNMETERED"
                ? `UNMETERED (bytes ${row.byteVerdict})`
                : `${row.verdict} (meter)`;
        console.log(
            `${fmtTime(row.current.createdAt)} | ${String(row.current.segments.length).padStart(4)} | ${verdictLabel.padEnd(16)} | ${meterCell(row).padEnd(54)} | ${(row.meterVsBytes ?? "").padEnd(12)} | ${attribution.padEnd(31)} | ${byteDelta.padEnd(27)} | ${currentPrefix.at} (${currentPrefix.bytes.toLocaleString()}B)`,
        );
        if (row.divergenceClass) {
            console.log(`          └─ divergence-class: ${row.divergenceClass}`);
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
            if (opts.showDiff) printSegmentDiff(previous, row.current, index);
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
            `${expiryCount} short read(s) came more than ${opts.cacheTtl ?? "5m"} after the prefix was last read in full or written (idle_cache_expiry; --cache-ttl changes the window).`,
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
};

if (import.meta.main) main();
