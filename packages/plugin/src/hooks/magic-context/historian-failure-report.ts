/**
 * User-facing wording for historian (history summary) trouble, shared by every
 * host so OpenCode 1, OpenCode 2, Pi and Oh My Pi say the same thing:
 *
 * - the refusal of a turn at 95% usage whose wait for a summary run ran out;
 * - the early warning shown when summary runs keep failing, well before 95%.
 *
 * Both are built from the same facts: the chunk the run summarizes, the state
 * of the run, the session's streak of consecutive failed runs (stored in
 * session_meta and the historian_runs records), and the provider's last usage
 * reading. Neither text ever enters the model's prompt: the refusal is the
 * error the host shows instead of sending the turn, and the warning goes
 * through the host's status-notice channel.
 */

import {
    type ContextDatabase,
    getHistorianFailureState,
    loadPersistedUsage,
} from "../../features/magic-context/storage";
import { getRecentFailedHistorianRunTimes } from "../../features/magic-context/storage-historian-runs";

/** Raw message ordinals a historian run summarizes, both ends included. */
export interface HistorianChunkRange {
    start: number;
    end: number;
}

/** What a waiting pass knows about the historian run it waited for. */
export interface HistorianRunProgress {
    /**
     * When the run was started. A failure recorded at or after this time is
     * the run's own; one recorded before it belongs to an earlier run.
     */
    startedAt?: number;
    /** When the run ended; unset while it is still running. */
    endedAt?: number;
    /** The chunk the run summarizes, once the run has read it. */
    chunk?: HistorianChunkRange;
}

/** The session's current streak of consecutive failed historian runs. */
export interface HistorianFailureStreak {
    /** Consecutive failed runs; a successful run resets it to 0. */
    count: number;
    /** The error of the most recent failed run. */
    lastError: string | null;
    /** When the most recent failure was recorded (epoch ms). */
    lastFailureAt: number | null;
    /** When the first failed run of the streak ended, if the run records show it. */
    since: number | null;
}

/** Summary-run failures in a row at which the early warning is shown. */
export const REPEATED_HISTORIAN_FAILURE_WARNING_STEP = 3;
/** The least time between two early warnings of the same streak. */
export const REPEATED_HISTORIAN_FAILURE_WARNING_INTERVAL_MS = 30 * 60 * 1000;

const ACTIONS =
    "What to do: run /ctx-status for detail; change the historian model or its fallback models in magic-context.jsonc; or run /ctx-recomp to rebuild the history.";

/**
 * Read the session's failure streak. `unrecordedFailures` counts failures that
 * are already in the count but whose run has not written its run record yet
 * (a run records itself when it ends), so the streak's start is found among
 * the right records.
 */
export function readHistorianFailureStreak(
    db: ContextDatabase,
    sessionId: string,
    options: { unrecordedFailures?: number } = {},
): HistorianFailureStreak {
    const state = getHistorianFailureState(db, sessionId);
    const count = state.failureCount;
    let since: number | null = null;
    if (count > 0) {
        const recorded = count - Math.max(0, options.unrecordedFailures ?? 0);
        if (recorded <= 0) {
            since = state.lastFailureAt;
        } else {
            const times = getRecentFailedHistorianRunTimes(db, sessionId, recorded);
            since = times.length === recorded ? (times[recorded - 1] ?? null) : null;
        }
    }
    return { count, lastError: state.lastError, lastFailureAt: state.lastFailureAt, since };
}

/** A time of day in local time, with the date when it is not the same day as `now`. */
export function formatHistorianClockTime(at: number, now: number = Date.now()): string {
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, "0");
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    const today = new Date(now);
    const sameDay =
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate();
    return sameDay
        ? clock
        : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** Seconds for a wait or an age: whole seconds from 10 s up, milliseconds below. */
export function formatHistorianSeconds(ms: number): string {
    const seconds = Math.max(0, ms) / 1000;
    return String(Number(seconds.toFixed(seconds >= 10 ? 0 : 3)));
}

function singleLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

/** "." ends a sentence unless the quoted error already ends with punctuation. */
function endSentence(text: string): string {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

function usageClause(usagePercentage: number | null | undefined): string {
    return typeof usagePercentage === "number" && Number.isFinite(usagePercentage)
        ? `context is at ${Math.round(usagePercentage)}% of the window`
        : "context is nearly full";
}

function chunkLabel(chunk: HistorianChunkRange | undefined): string {
    return chunk ? `messages ${chunk.start}-${chunk.end}` : "";
}

function streakSentence(failures: HistorianFailureStreak, now: number): string | null {
    if (failures.count <= 0) return null;
    const since =
        failures.since !== null ? `, since ${formatHistorianClockTime(failures.since, now)}` : "";
    return `Summary runs failed in a row: ${failures.count}${since}.`;
}

/** Whether the stored last failure was recorded by the given run. */
function failureBelongsToRun(
    failures: HistorianFailureStreak,
    run: HistorianRunProgress | undefined,
): boolean {
    return (
        failures.count > 0 &&
        failures.lastFailureAt !== null &&
        run?.startedAt !== undefined &&
        failures.lastFailureAt >= run.startedAt
    );
}

/**
 * The refusal shown when a pass at 95% usage waited for a historian run, the
 * wait ran out, and the request could not be shown to fit without the summary.
 * It names the run the pass waited for and its state, quotes a stored failure
 * only as the run's own when it was recorded after the run started, and
 * otherwise as the previous run's.
 */
export function describeHistorianJoinRefusal(input: {
    /** How long the pass could wait for the run. */
    waitedMs: number;
    usagePercentage?: number | null;
    /** The run the pass waited for, read when the refusal is written. */
    run?: HistorianRunProgress;
    failures: HistorianFailureStreak;
    now?: number;
}): string {
    const now = input.now ?? Date.now();
    const { run, failures } = input;
    const sentences = [
        `This turn was not sent: ${usageClause(input.usagePercentage)}, and Magic Context waited ${formatHistorianSeconds(input.waitedMs)} s for a history summary that did not finish in time.`,
    ];
    const subject = run?.chunk
        ? `The summary of ${chunkLabel(run.chunk)}`
        : "The summary run";
    const ownFailure = failureBelongsToRun(failures, run);
    const lastError = failures.lastError ? singleLine(failures.lastError) : "";
    if (ownFailure) {
        sentences.push(endSentence(`${subject} failed: ${lastError || "no reason recorded"}`));
    } else if (run && run.endedAt === undefined) {
        sentences.push(
            run.startedAt !== undefined
                ? `${subject} is still running after ${formatHistorianSeconds(now - run.startedAt)} s.`
                : `${subject} is still running.`,
        );
    } else if (run) {
        sentences.push(`${subject} finished after the wait ended.`);
    }
    if (!ownFailure && failures.count > 0 && lastError && failures.lastFailureAt !== null) {
        sentences.push(
            endSentence(
                `The previous run failed at ${formatHistorianClockTime(failures.lastFailureAt, now)}: ${lastError}`,
            ),
        );
    }
    const streak = streakSentence(failures, now);
    if (streak) sentences.push(streak);
    sentences.push(ACTIONS);
    return sentences.join(" ");
}

/**
 * The early warning shown when summary runs keep failing: names the chunk, the
 * streak, the last error and the current usage, and what to do.
 */
export function describeRepeatedHistorianFailures(input: {
    chunk?: HistorianChunkRange;
    failures: HistorianFailureStreak;
    usagePercentage?: number | null;
    now?: number;
}): string {
    const now = input.now ?? Date.now();
    const { failures } = input;
    const facts = [
        streakSentence(failures, now) ?? "Summary runs are failing.",
        ...(input.chunk ? [`Last chunk: ${chunkLabel(input.chunk)}.`] : []),
        ...(failures.lastError ? [endSentence(`Last error: ${singleLine(failures.lastError)}`)] : []),
        `Now ${usageClause(input.usagePercentage)}; at 95% a turn waits for a summary and is not sent if none finishes in time.`,
    ];
    return [
        "## Magic Context — History summaries keep failing",
        "",
        facts.join(" "),
        "",
        ACTIONS,
    ].join("\n");
}

const repeatedFailureWarnings = new Map<string, { count: number; at: number }>();

/**
 * Whether the early warning is due for this failure count, recording it as
 * shown when it is. It is due at every multiple of
 * {@link REPEATED_HISTORIAN_FAILURE_WARNING_STEP}, at most once per
 * {@link REPEATED_HISTORIAN_FAILURE_WARNING_INTERVAL_MS} within one streak. A
 * count at or below the last warned one means the streak ended (a successful
 * run resets the count) and a new one has reached the step, so it is due again.
 */
export function shouldWarnRepeatedHistorianFailures(
    sessionId: string,
    failureCount: number,
    now: number = Date.now(),
): boolean {
    const step = REPEATED_HISTORIAN_FAILURE_WARNING_STEP;
    if (failureCount < step || failureCount % step !== 0) return false;
    const last = repeatedFailureWarnings.get(sessionId);
    if (
        last &&
        failureCount > last.count &&
        now - last.at < REPEATED_HISTORIAN_FAILURE_WARNING_INTERVAL_MS
    ) {
        return false;
    }
    repeatedFailureWarnings.set(sessionId, { count: failureCount, at: now });
    return true;
}

/**
 * The early warning for a failure the caller has just counted, or null when
 * none is due. Call it once per counted failure: a due warning is recorded as
 * shown. `unrecordedFailures` is 1 when the failing run has not written its
 * run record yet.
 */
export function takeRepeatedHistorianFailureWarning(input: {
    db: ContextDatabase;
    sessionId: string;
    failureCount: number;
    chunk?: HistorianChunkRange;
    unrecordedFailures?: number;
    now?: number;
}): string | null {
    const now = input.now ?? Date.now();
    if (!shouldWarnRepeatedHistorianFailures(input.sessionId, input.failureCount, now)) {
        return null;
    }
    const failures = readHistorianFailureStreak(input.db, input.sessionId, {
        unrecordedFailures: input.unrecordedFailures,
    });
    return describeRepeatedHistorianFailures({
        chunk: input.chunk,
        failures: { ...failures, count: input.failureCount },
        usagePercentage: loadPersistedUsage(input.db, input.sessionId)?.usage.percentage,
        now,
    });
}

/** Forget a session's early-warning state (session deleted or cleared). */
export function clearRepeatedHistorianFailureWarning(sessionId: string): void {
    repeatedFailureWarnings.delete(sessionId);
}
