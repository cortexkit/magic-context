import type { OpenCodeHostGeneration } from "../../shared/opencode-db-path";
import type { Database } from "../../shared/sqlite";

export interface WorkMetrics {
    newWorkTokens: number;
    totalInputTokens: number;
}

export interface PiSessionEntry {
    role?: unknown;
    usage?: unknown;
    message?: unknown;
}

interface WorkMetricsRow {
    new_work_tokens?: number | null;
    total_input_tokens?: number | null;
}

interface PiUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

const OPEN_CODE_WORK_METRICS_SQL = `
WITH ordered AS (
  SELECT
    json_extract(data, '$.agent') AS agent,
    time_created,
    id,
    COALESCE(json_extract(data, '$.tokens.input'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cur_prompt,
    COALESCE(json_extract(data, '$.tokens.output'), 0) AS cur_output,
    LAG(
      COALESCE(json_extract(data, '$.tokens.input'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.write'), 0),
      1, 0
    ) OVER (PARTITION BY json_extract(data, '$.agent') ORDER BY time_created, id) AS prev_prompt
  FROM message
  WHERE session_id = ?
    AND json_extract(data, '$.role') = 'assistant'
    AND data IS NOT NULL
),
deltas AS (
  SELECT agent, MAX(0, cur_prompt - prev_prompt) AS delta, cur_output,
         ROW_NUMBER() OVER (PARTITION BY agent ORDER BY time_created DESC, id DESC) AS rn
  FROM ordered
),
flagged AS (
  SELECT
    agent, cur_prompt, prev_prompt, time_created, id,
    SUM(CASE WHEN cur_prompt < prev_prompt THEN 1 ELSE 0 END)
      OVER (PARTITION BY agent ORDER BY time_created, id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS phase_id
  FROM ordered
),
phase_peaks AS (
  SELECT agent, phase_id, MAX(cur_prompt) AS phase_peak
  FROM flagged
  WHERE prev_prompt > 0 OR phase_id = 0
  GROUP BY agent, phase_id
),
metric_a AS (
  SELECT COALESCE(SUM(delta), 0)
       + COALESCE(SUM(CASE WHEN rn = 1 THEN cur_output ELSE 0 END), 0) AS new_work
  FROM deltas
),
metric_b AS (
  SELECT COALESCE(SUM(phase_peak), 0) AS total_input FROM phase_peaks
)
SELECT metric_a.new_work AS new_work_tokens,
       metric_b.total_input AS total_input_tokens
FROM metric_a, metric_b`;

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getPiUsage(entry: unknown): PiUsage | null {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const message =
        record.message && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : record;
    if (message.role !== "assistant") return null;
    if (!message.usage || typeof message.usage !== "object") return null;
    const usage = message.usage as Record<string, unknown>;
    return {
        input: asNumber(usage.input),
        output: asNumber(usage.output),
        cacheRead: asNumber(usage.cacheRead ?? usage.cache_read),
        cacheWrite: asNumber(usage.cacheWrite ?? usage.cache_write),
    };
}

export function computeOpenCodeWorkMetrics(openCodeDb: Database, sessionId: string): WorkMetrics {
    const row = openCodeDb
        .prepare(OPEN_CODE_WORK_METRICS_SQL)
        .get(sessionId) as WorkMetricsRow | null;
    return {
        newWorkTokens: Math.max(0, Math.floor(row?.new_work_tokens ?? 0)),
        totalInputTokens: Math.max(0, Math.floor(row?.total_input_tokens ?? 0)),
    };
}

// ── Incremental (watermark) work-metrics ───────────────────────────────────
//
// `computeOpenCodeWorkMetrics` recomputes from a window-function json_extract
// scan over EVERY assistant row of the session. That is O(session age) and was
// running on every transform pass — the dominant transform cost on long
// sessions (47K assistant rows ≈ 250ms/pass). Both halves of the metric are
// strictly left-to-right accumulations, so nothing before a watermark ever
// changes. The fold below reproduces the SQL semantics exactly while letting
// callers process only rows newer than the last-seen `(time_created, id)`.
// The window-function SQL above is retained as the equivalence oracle in tests.

/** A single assistant row's usage, as folded by `foldWorkMetricsRows`. */
export interface AssistantUsageRow {
    /** json_extract(data,'$.agent'); null when absent (its own partition). */
    agent: string | null;
    /** Ordering key: v1 time_created, or v2 seq (the store's append order). */
    timeCreated: number;
    id: string;
    /** input + cache.read + cache.write. */
    prompt: number;
    output: number;
}

interface AgentCarry {
    prevPrompt: number;
    phaseId: number;
    /** Max qualifying prompt in the current (open) phase. */
    phasePeak: number;
    /** Whether the current phase has at least one qualifying row. */
    phaseHasQualifying: boolean;
    /** Summed peaks of already-closed qualifying phases. */
    closedPhaseSum: number;
    lastOutput: number;
    seen: boolean;
}

/** Resumable accumulator: fold new rows into this to extend the metric. */
export interface WorkMetricsCarry {
    perAgent: Map<string, AgentCarry>;
    /** Σ max(0, prompt - prevPrompt) across every folded row (metric A body). */
    newWorkSum: number;
    /** Watermark: last folded row's ordering key (v1 time_created or v2 seq). */
    lastTimeCreated: number;
    lastId: string;
}

const NULL_AGENT_KEY = "\u0000__null_agent__";

export function emptyWorkMetricsCarry(): WorkMetricsCarry {
    return { perAgent: new Map(), newWorkSum: 0, lastTimeCreated: -1, lastId: "" };
}

/**
 * Fold rows (which MUST be in (timeCreated, id) ascending order and strictly
 * newer than `carry`'s watermark) into the carry, mutating and returning it.
 *
 * Mirrors OPEN_CODE_WORK_METRICS_SQL:
 *  - delta per row = max(0, prompt - LAG(prompt) per agent), default LAG 0.
 *  - phase_id = cumulative count of (prompt < prevPrompt) per agent; a dropping
 *    row starts (and belongs to) the new phase.
 *  - phase peak counts only QUALIFYING rows (prevPrompt > 0 OR phase_id == 0).
 *  - metric A = Σ deltas + Σ (last output per agent); metric B = Σ phase peaks.
 */
export function foldWorkMetricsRows(
    rows: AssistantUsageRow[],
    carry: WorkMetricsCarry,
): WorkMetricsCarry {
    for (const row of rows) {
        const key = row.agent ?? NULL_AGENT_KEY;
        let st = carry.perAgent.get(key);
        if (!st) {
            st = {
                prevPrompt: 0,
                phaseId: 0,
                phasePeak: 0,
                phaseHasQualifying: false,
                closedPhaseSum: 0,
                lastOutput: 0,
                seen: false,
            };
            carry.perAgent.set(key, st);
        }
        const cur = row.prompt;
        const prev = st.prevPrompt; // LAG default 0 for the first row per agent.
        carry.newWorkSum += Math.max(0, cur - prev);

        // A drop closes the current phase and opens the next; the dropping row
        // belongs to the new phase (matches the inclusive cumulative phase_id).
        if (st.seen && cur < prev) {
            if (st.phaseHasQualifying) st.closedPhaseSum += st.phasePeak;
            st.phaseId += 1;
            st.phasePeak = 0;
            st.phaseHasQualifying = false;
        }

        const qualifies = prev > 0 || st.phaseId === 0;
        if (qualifies) {
            if (cur > st.phasePeak) st.phasePeak = cur;
            st.phaseHasQualifying = true;
        }

        st.lastOutput = row.output;
        st.prevPrompt = cur;
        st.seen = true;

        carry.lastTimeCreated = row.timeCreated;
        carry.lastId = row.id;
    }
    return carry;
}

function cloneCarry(carry: WorkMetricsCarry): WorkMetricsCarry {
    const perAgent = new Map<string, AgentCarry>();
    for (const [k, v] of carry.perAgent) perAgent.set(k, { ...v });
    return {
        perAgent,
        newWorkSum: carry.newWorkSum,
        lastTimeCreated: carry.lastTimeCreated,
        lastId: carry.lastId,
    };
}

/** Current metric value implied by the carry (cheap; no DB access). */
export function metricsFromCarry(carry: WorkMetricsCarry): WorkMetrics {
    let totalInput = 0;
    let lastOutputSum = 0;
    for (const st of carry.perAgent.values()) {
        totalInput += st.closedPhaseSum + (st.phaseHasQualifying ? st.phasePeak : 0);
        lastOutputSum += st.lastOutput;
    }
    return {
        newWorkTokens: Math.max(0, Math.floor(carry.newWorkSum + lastOutputSum)),
        totalInputTokens: Math.max(0, Math.floor(totalInput)),
    };
}

const ASSISTANT_USAGE_ROWS_AFTER_SQL = `
SELECT
  json_extract(data, '$.agent') AS agent,
  time_created AS time_created,
  id AS id,
  COALESCE(json_extract(data, '$.tokens.input'), 0)
    + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
    + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS prompt,
  COALESCE(json_extract(data, '$.tokens.output'), 0) AS output
FROM message
WHERE session_id = ?
  AND json_extract(data, '$.role') = 'assistant'
  AND data IS NOT NULL
  AND (time_created > ? OR (time_created = ? AND id > ?))
ORDER BY time_created, id`;

// OpenCode 2 stores the role in `type`, not data.role. Its append order is seq;
// alias it to the fold's ordering key so missing or nonmonotonic timestamps do
// not skip turns or change the phase-peak calculation.
const V2_ASSISTANT_USAGE_ROWS_AFTER_SQL = `
SELECT
  json_extract(data, '$.agent') AS agent,
  seq AS time_created,
  id AS id,
  COALESCE(json_extract(data, '$.tokens.input'), 0)
    + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
    + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS prompt,
  COALESCE(json_extract(data, '$.tokens.output'), 0) AS output
FROM session_message
WHERE session_id = ?
  AND type = 'assistant'
  AND data IS NOT NULL
  AND (seq > ? OR (seq = ? AND id > ?))
ORDER BY seq, id`;

interface AssistantUsageDbRow {
    agent: string | null;
    time_created: number;
    id: string;
    prompt: number;
    output: number;
}

/** Read assistant usage rows strictly newer than the carry watermark. */
export function readAssistantUsageRowsAfter(
    openCodeDb: Database,
    sessionId: string,
    afterTimeCreated: number,
    afterId: string,
    generation: OpenCodeHostGeneration = "v1",
): AssistantUsageRow[] {
    const rows = openCodeDb
        .prepare(
            generation === "v2"
                ? V2_ASSISTANT_USAGE_ROWS_AFTER_SQL
                : ASSISTANT_USAGE_ROWS_AFTER_SQL,
        )
        .all(sessionId, afterTimeCreated, afterTimeCreated, afterId) as AssistantUsageDbRow[];
    return rows.map((r) => ({
        agent: r.agent ?? null,
        timeCreated: Number(r.time_created ?? 0),
        id: String(r.id ?? ""),
        prompt: Number(r.prompt ?? 0),
        output: Number(r.output ?? 0),
    }));
}

/**
 * Extend `carry` with assistant rows newer than its watermark and return the
 * up-to-date metrics. On a fresh carry this folds the whole session once (cold
 * start); subsequent calls fold only new rows (≈0 when idle).
 *
 * The single most-recent assistant row is NEVER committed into the durable
 * carry — OpenCode writes the row at stream start and finalizes `data.tokens`
 * at completion, so a poll mid-stream would otherwise freeze that row at a
 * partial/zero value. Instead the watermark is advanced only through the
 * second-to-last row; the last row is re-read every poll and folded into a
 * throwaway clone for the returned value, so the result always matches a full
 * re-scan even while the latest turn is still streaming.
 */
export function computeOpenCodeWorkMetricsIncremental(
    openCodeDb: Database,
    sessionId: string,
    carry: WorkMetricsCarry,
    generation: OpenCodeHostGeneration = "v1",
): { carry: WorkMetricsCarry; metrics: WorkMetrics } {
    const rows = readAssistantUsageRowsAfter(
        openCodeDb,
        sessionId,
        carry.lastTimeCreated,
        carry.lastId,
        generation,
    );
    if (rows.length === 0) {
        // No uncommitted rows at all (only possible when the session has zero
        // assistant rows, since the held-back last row always re-reads).
        return { carry, metrics: metricsFromCarry(carry) };
    }
    // Durably commit everything except the most-recent row.
    if (rows.length > 1) foldWorkMetricsRows(rows.slice(0, -1), carry);
    // Fold the held-back last row into a throwaway clone for the return value.
    const view = foldWorkMetricsRows([rows[rows.length - 1]], cloneCarry(carry));
    return { carry, metrics: metricsFromCarry(view) };
}

export function computePiWorkMetrics(sessionEntries: PiSessionEntry[] | unknown[]): WorkMetrics {
    let previousPrompt = 0;
    let phasePeak = 0;
    let newWorkTokens = 0;
    let totalInputTokens = 0;
    let lastOutput = 0;
    let sawAssistant = false;

    for (const entry of sessionEntries) {
        const usage = getPiUsage(entry);
        if (!usage) continue;
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        if (sawAssistant && prompt < previousPrompt) {
            totalInputTokens += phasePeak;
            phasePeak = prompt;
        } else {
            phasePeak = Math.max(phasePeak, prompt);
        }
        newWorkTokens += Math.max(0, prompt - previousPrompt);
        previousPrompt = prompt;
        lastOutput = usage.output;
        sawAssistant = true;
    }

    if (sawAssistant) {
        totalInputTokens += phasePeak;
        newWorkTokens += lastOutput;
    }

    return { newWorkTokens, totalInputTokens };
}
