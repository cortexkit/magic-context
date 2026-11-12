import { z } from "zod";
import type { RunnerClassification, RunnerMeterStep } from "./cache-bust-runner-classification";

export const ZERO_READ_WAVE_WINDOW_MS = 10 * 60_000;
export const ZERO_READ_WAVE_LIFETIME_MS = 6 * 3_600_000;
export const ZERO_READ_WAVE_SUMMARY_MS = 30 * 60_000;

const time = z.number().finite().nonnegative();
const memberSchema = z.object({
    session: z.string(),
    harness: z.string(),
    at: time,
    written: time,
    previousStepAt: time,
});
export const runnerWaveStateSchema = z.object({
    candidates: z.array(memberSchema).default([]),
    open: z.object({
        startedAt: time,
        members: z.array(memberSchema),
        summarizedMembers: time,
        lastSummaryAt: time.optional(),
    }).optional(),
});
export type RunnerWaveMember = z.infer<typeof memberSchema>;
export type RunnerWaveState = z.infer<typeof runnerWaveStateSchema>;
export type RunnerZeroReadWave = NonNullable<RunnerWaveState["open"]>;
export const emptyRunnerWaveState = (): RunnerWaveState => ({ candidates: [] });

/** Advance in step order, then to scan time only once the backlog is drained. */
export function advanceRunnerWave(state: RunnerWaveState, at: number): RunnerZeroReadWave | undefined {
    state.candidates = state.candidates.filter((member) => member.at >= at - ZERO_READ_WAVE_WINDOW_MS);
    if (!state.open || at < state.open.startedAt + ZERO_READ_WAVE_LIFETIME_MS) return;
    const closed = state.open;
    delete state.open;
    state.candidates = [];
    return closed;
}

/** Recorded causes keep their own classification; only unexplained rewrites join. */
export function observeRunnerWave(
    state: RunnerWaveState,
    identity: { session: string; harness: string },
    previous: RunnerMeterStep,
    current: RunnerMeterStep,
    classification: RunnerClassification,
): { member?: RunnerWaveMember; opened?: RunnerZeroReadWave } {
    if (classification.class !== "unexplained" || current.read !== 0 || current.write < 20_000 ||
        (previous.prompt ?? previous.read + previous.write) < 20_000 || previous.model !== current.model) return {};
    const member: RunnerWaveMember = {
        ...identity, at: current.at, written: current.write, previousStepAt: previous.at,
    };
    if (state.open) {
        if (state.open.members.some((prior) => prior.session === member.session) ||
            previous.at >= state.open.startedAt) return {};
        state.open.members.push(member);
        return { member };
    }
    // Keep the first rewrite per session, not a later repeat that could hide a defect.
    if (!state.candidates.some((prior) => prior.session === member.session)) state.candidates.push(member);
    if (state.candidates.length < 2) return {};
    const members = state.candidates;
    const opened: RunnerZeroReadWave = {
        startedAt: members[0]!.at, members, summarizedMembers: members.length,
    };
    state.open = opened;
    state.candidates = [];
    return { member, opened };
}

export function attributeRunnerWave(classification: RunnerClassification, startedAt: number): void {
    classification.class = "zero_read_wave";
    classification.zeroReadWaveStartedAt = startedAt;
    classification.evidence = `zero_read_wave began at ${new Date(startedAt).toISOString()}; account or route change is not proven by the feed`;
}

export function runnerWaveMembersText(members: readonly RunnerWaveMember[]): string {
    return members.map((member) => `session=${member.session}, time=${new Date(member.at).toISOString()}, written=${member.written}, previous step=${new Date(member.previousStepAt).toISOString()}`).join("; ");
}

export function runnerWaveTotals(wave: RunnerZeroReadWave): { sessions: number; written: number } {
    return { sessions: wave.members.length, written: wave.members.reduce((sum, member) => sum + member.written, 0) };
}
