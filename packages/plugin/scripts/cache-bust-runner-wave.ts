import { z } from "zod";
import { runnerIdleExpiry, type RunnerClassification, type RunnerMeterStep } from "./cache-bust-runner-classification";

export const ZERO_READ_WAVE_WINDOW_MS = 10 * 60_000;
const ZERO_READ_WAVE_QUIET_MS = 15 * 60_000;

const time = z.number().finite().nonnegative();
const memberSchema = z.object({
    session: z.string(),
    harness: z.string(),
    at: time,
    written: time,
    previousStepAt: time,
    // Present only when Astrocyte named an account change and the runner's
    // account facts differ between the two steps: the first 8 characters of
    // each hashed account ref.
    account: z.object({ from: z.string(), to: z.string() }).optional(),
});
export const runnerWaveStateSchema = z.object({
    candidates: z.array(memberSchema).default([]),
    open: z.object({
        startedAt: time,
        members: z.array(memberSchema),
        summarizedMembers: time,
    }).optional(),
});
export type RunnerWaveMember = z.infer<typeof memberSchema>;
export type RunnerWaveState = z.infer<typeof runnerWaveStateSchema>;
export type RunnerZeroReadWave = NonNullable<RunnerWaveState["open"]>;
export const emptyRunnerWaveState = (): RunnerWaveState => ({ candidates: [] });

export function runnerWaveClosesAt(wave: RunnerZeroReadWave): number {
    const newest = wave.members.reduce((latest, member) => Math.max(latest, member.at), wave.startedAt);
    return newest + ZERO_READ_WAVE_QUIET_MS;
}

/** Advance in step order, then to scan time only once the backlog is drained. */
export function advanceRunnerWave(state: RunnerWaveState, at: number): RunnerZeroReadWave | undefined {
    state.candidates = state.candidates.filter((member) => member.at >= at - ZERO_READ_WAVE_WINDOW_MS);
    if (!state.open || at < runnerWaveClosesAt(state.open)) return;
    const closed = state.open;
    delete state.open;
    state.candidates = [];
    return closed;
}

/**
 * Recorded causes keep their own classification; only unexplained rewrites join,
 * and those Astrocyte proved were an account change. A zero-read wave is what an
 * account that stopped being given looks like, so a proven move between accounts
 * still groups with the other sessions it moved.
 */
export function observeRunnerWave(
    state: RunnerWaveState,
    identity: { session: string; harness: string },
    previous: RunnerMeterStep,
    current: RunnerMeterStep,
    classification: RunnerClassification,
): { member?: RunnerWaveMember; opened?: RunnerZeroReadWave; superseded?: RunnerZeroReadWave } {
    const accountChange = classification.class === "scope_changed" && classification.cause === "account_or_model_changed";
    if ((classification.class !== "unexplained" && !accountChange) || current.read !== 0 || current.write < 20_000 ||
        (previous.prompt ?? previous.read + previous.write) < 20_000 || previous.model !== current.model) return {};
    // A change of account can be real even when there is no warm cache left to lose.
    if (runnerIdleExpiry(previous.at, current.facts?.started_at_ms ?? current.at, {
        cacheTtlMs: previous.facts?.cache_ttl_ms,
        previousCompletedAt: previous.facts?.finished_at_ms,
    })) return {};
    const before = previous.facts?.account_ref;
    const after = current.facts?.account_ref;
    const member: RunnerWaveMember = {
        ...identity, at: current.at, written: current.write, previousStepAt: previous.at,
        ...(accountChange && before !== undefined && after !== undefined && before !== after
            ? { account: { from: before.slice(0, 8), to: after.slice(0, 8) } }
            : {}),
    };
    if (state.open) {
        // A member's second rewrite stays its own urgent event.
        if (state.open.members.some((prior) => prior.session === member.session)) return {};
        if (previous.at < state.open.startedAt) {
            state.open.members.push(member);
            return { member };
        }
        // This session's previous step came after the open wave began, so that
        // wave can't explain the rewrite. It becomes a candidate for a new wave:
        // if a second session has such a rewrite within the window, they open a
        // new wave with one wake (typically routing moved more sessions off
        // another account) instead of each rewrite waking on its own.
    }
    // Keep the first rewrite per session, not a later repeat that could hide a defect.
    if (!state.candidates.some((prior) => prior.session === member.session)) state.candidates.push(member);
    if (state.candidates.length < 2) return {};
    const superseded = state.open;
    const members = state.candidates;
    const opened: RunnerZeroReadWave = {
        startedAt: members[0]!.at, members, summarizedMembers: members.length,
    };
    state.open = opened;
    state.candidates = [];
    return { member, opened, ...(superseded ? { superseded } : {}) };
}

/** `member` is the wave member this step became; its account says whether the move is proven. */
export function attributeRunnerWave(
    classification: RunnerClassification,
    startedAt: number,
    member?: Pick<RunnerWaveMember, "account">,
): void {
    // Keep Astrocyte's evidence, which starts at "cause=". It can prove the
    // account moved, which the feed's counts alone cannot. Extracting it keeps
    // a repeated attribution of the same step from nesting it twice.
    const from = classification.cause === undefined ? -1 : classification.evidence.indexOf("cause=");
    const astrocyte = from < 0 ? "" : `; ${classification.evidence.slice(from)}`;
    const proven = member?.account !== undefined;
    classification.class = "zero_read_wave";
    classification.zeroReadWaveStartedAt = startedAt;
    classification.evidence = `zero_read_wave began at ${new Date(startedAt).toISOString()}${proven ? "" : "; account or route change is not proven by the feed"}${astrocyte}`;
}

/**
 * The accounts every member moved between, as "from→to" pairs, when each
 * member's account change is proven by the runner's account facts. Undefined
 * when any member lacks that proof: a wave can also come from a tool or system
 * change, which looks the same in the feed's counts.
 */
export function runnerWaveProvenAccounts(members: readonly RunnerWaveMember[]): string | undefined {
    if (!members.length || members.some((member) => member.account === undefined)) return undefined;
    return [...new Set(members.map((member) => `${member.account!.from}→${member.account!.to}`))].join(", ");
}

export function runnerWaveMembersText(members: readonly RunnerWaveMember[]): string {
    return members.map((member) => `session=${member.session}, time=${new Date(member.at).toISOString()}, written=${member.written}, previous step=${new Date(member.previousStepAt).toISOString()}`).join("; ");
}

export function runnerWaveTotals(wave: RunnerZeroReadWave): { sessions: number; written: number } {
    return { sessions: wave.members.length, written: wave.members.reduce((sum, member) => sum + member.written, 0) };
}
