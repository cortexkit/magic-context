/**
 * Pi pressure computation — OpenCode-equivalent semantics.
 *
 * Pi's built-in `ctx.getContextUsage()` reports a `percent` field
 * computed as `(input + output + cacheRead + cacheWrite) / contextWindow`.
 * That includes output tokens, which makes Pi's percentage drift above
 * the wire-input-only pressure OpenCode tracks. The drift is small but
 * material:
 *
 *   - Test assertions expect exact integer percentages (40, 50, …) and
 *     Pi off-by-output produces 40.1, 46.9, … on the same inputs.
 *   - The overflow-recovery path's "use detectedContextLimit for next
 *     pressure pass" contract is unimplementable if Pi keeps reporting
 *     its own percent — that field is locked to Pi's `contextWindow`
 *     from settings/models.json and cannot be re-divided by the
 *     post-overflow limit.
 *
 * The fix is to compute pressure ourselves from the latest assistant
 * message's `usage` field, exactly the way OpenCode's
 * `event-handler.ts` does:
 *
 *     inputTokens = min(input + cacheRead + cacheWrite, totalTokens - output)
 *     percentage  = (inputTokens / contextLimit) * 100
 *
 * The contextLimit MUST already be the output-reserved safe window, with any
 * persisted `session_meta.detected_context_limit` applied to the raw window
 * first. Callers resolve that ordering before invoking this helper, mirroring
 * OpenCode's `resolveContextLimit()` path.
 */

import { sessionLog } from "@magic-context/core/shared/logger";
import {
	hasTrustedAbsoluteWall,
	MIN_PLAUSIBLE_CONTEXT_LIMIT,
	type WindowGeometryResult,
} from "@magic-context/core/shared/window-geometry";

// OpenCode's model resolver uses the same 3M sanity ceiling. Without an
// authoritative window, a larger billing counter is not proof of capacity.
// Catalog windows remain advisory so accepted measurements can repair them.
export const MAX_UNKNOWN_PI_INPUT_TOKENS = 3_000_000;

export function piPressureEvidenceLimit(
	geometry?: WindowGeometryResult,
): number {
	return geometry && hasTrustedAbsoluteWall(geometry)
		? geometry.derivation.absoluteWall
		: MAX_UNKNOWN_PI_INPUT_TOKENS;
}

const rejectedUsageLogged = new Set<string>();
const rejectedProviderUsage = new Set<string>();

export function recordPiProviderUsageValidity(
	sessionId: string,
	rejected: boolean,
): void {
	if (rejected) rejectedProviderUsage.add(sessionId);
	else rejectedProviderUsage.delete(sessionId);
}

export function piProviderUsageWasRejected(sessionId: string): boolean {
	return rejectedProviderUsage.has(sessionId);
}

export function noteRejectedPiUsage(
	sessionId: string,
	reading: number,
	limit: number,
	source: string,
): void {
	if (rejectedUsageLogged.has(sessionId)) return;
	rejectedUsageLogged.add(sessionId);
	sessionLog(
		sessionId,
		`provider_usage_not_single_request: ${source} input ${reading} exceeds pressure evidence bound ${limit}; ignoring possible turn-aggregate billing usage and using request estimates`,
	);
}

export interface PiAssistantUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

export interface PiPressure {
	/** Tokens charged against contextLimit, mirroring OpenCode's pressure-input definition. */
	inputTokens: number;
	/** Percentage of contextLimit. Capped at 0 when contextLimit is unknown. */
	percentage: number;
}

/**
 * Extract `usage` from a Pi `event.message` assistant payload.
 * Pi puts the usage in `message.usage` per its AssistantMessage type.
 * Returns null when the message is not an assistant or carries no
 * usage data (aborted/error messages have no usage).
 */
export function extractAssistantUsage(
	message: unknown,
): PiAssistantUsage | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { role?: unknown; usage?: unknown };
	if (m.role !== "assistant") return null;
	if (!m.usage || typeof m.usage !== "object") return null;
	const u = m.usage as Record<string, unknown>;
	const result: PiAssistantUsage = {};
	if (typeof u.input === "number") result.input = u.input;
	if (typeof u.output === "number") result.output = u.output;
	if (typeof u.cacheRead === "number") result.cacheRead = u.cacheRead;
	if (typeof u.cacheWrite === "number") result.cacheWrite = u.cacheWrite;
	if (typeof u.totalTokens === "number") result.totalTokens = u.totalTokens;
	return result;
}

/**
 * Compute OpenCode-equivalent pressure from a Pi usage payload + the
 * effective context limit. Returns null when no usage is available.
 *
 * The formula intentionally omits output tokens — they're not part of
 * the prefix sent to the next prompt, so they don't count against
 * cacheable-prefix pressure. This matches
 * `packages/plugin/src/hooks/magic-context/event-handler.ts:388-397`
 * exactly:
 *
 *     totalInputTokens = info.tokens.input + info.tokens.cache.read + info.tokens.cache.write
 *
 * OpenAI reports cached input as a subset of input tokens. Pi versions before
 * its cached-input normalization exposed both the inclusive input value and
 * cacheRead. `totalTokens - output` is therefore a second prompt-only reading:
 * taking the smaller value handles either representation without adding output.
 */
export function computePiPressure(
	usage: PiAssistantUsage | null,
	contextLimit: number,
	absoluteWall?: number,
): PiPressure | null {
	const inputTokens = piUsageInputTokens(usage);
	if (
		inputTokens === null ||
		inputTokens > (absoluteWall ?? MAX_UNKNOWN_PI_INPUT_TOKENS)
	)
		return null;
	const percentage = contextLimit > 0 ? (inputTokens / contextLimit) * 100 : 0;
	return { inputTokens, percentage };
}

/** Normalize old inclusive-cache shapes before judging the prompt reading. */
export function piUsageInputTokens(
	usage: PiAssistantUsage | null,
): number | null {
	if (!usage) return null;
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const componentPromptTokens = input + cacheRead + cacheWrite;
	const totalPromptTokens =
		typeof usage.totalTokens === "number" &&
		Number.isFinite(usage.totalTokens) &&
		typeof usage.output === "number" &&
		Number.isFinite(usage.output)
			? Math.max(0, usage.totalTokens - usage.output)
			: undefined;
	const inputTokens =
		totalPromptTokens !== undefined && totalPromptTokens > 0
			? Math.min(componentPromptTokens, totalPromptTokens)
			: componentPromptTokens;
	if (inputTokens <= 0 || !Number.isFinite(inputTokens)) return null;
	return inputTokens;
}

export interface PiPressureSnapshot extends PiPressure {
	/** Usable prompt-token denominator used for both percentage and display. */
	contextLimit?: number;
}

export interface ResolvePiPressureSnapshotArgs {
	persistedPercentage: number;
	persistedInputTokens: number;
	liveInputTokens?: number | null;
	usableContextLimit?: number;
	/** Scheduler recovery latch, used for historian admission, never a display denominator. */
	minimumPercentage?: number;
}

/**
 * Resolve one pressure pair for every Pi scheduler and display consumer.
 *
 * Pi's live estimate protects long, tool-heavy turns between assistant usage rows,
 * while the persisted input count is the provider-reported prompt-token source.
 * Whichever numerator is larger is divided by the actual usable window exactly
 * once. A separate safety-scaled denominator would make the percentage disagree
 * with the token/limit pair shown to users.
 */
export function resolvePiPressureSnapshot(
	args: ResolvePiPressureSnapshotArgs,
): PiPressureSnapshot {
	const persistedInputTokens =
		Number.isFinite(args.persistedInputTokens) && args.persistedInputTokens > 0
			? args.persistedInputTokens
			: 0;
	const liveInputTokens =
		typeof args.liveInputTokens === "number" &&
		Number.isFinite(args.liveInputTokens) &&
		args.liveInputTokens > 0
			? args.liveInputTokens
			: 0;
	const inputTokens = Math.max(persistedInputTokens, liveInputTokens);
	const contextLimit =
		typeof args.usableContextLimit === "number" &&
		Number.isFinite(args.usableContextLimit) &&
		args.usableContextLimit >= MIN_PLAUSIBLE_CONTEXT_LIMIT
			? args.usableContextLimit
			: undefined;

	if (contextLimit !== undefined) {
		return {
			inputTokens,
			percentage: Math.max(
				inputTokens > 0 ? (inputTokens / contextLimit) * 100 : 0,
				Number.isFinite(args.minimumPercentage)
					? (args.minimumPercentage ?? 0)
					: 0,
			),
			contextLimit,
		};
	}

	const inferredLimit = persistedInputTokens / (args.persistedPercentage / 100);
	const validInferredLimit =
		Number.isFinite(inferredLimit) &&
		inferredLimit >= MIN_PLAUSIBLE_CONTEXT_LIMIT;
	return {
		inputTokens,
		percentage: validInferredLimit ? (inputTokens / inferredLimit) * 100 : 0,
		...(validInferredLimit ? { contextLimit: inferredLimit } : {}),
	};
}

// Sessions whose current run of set-aside estimates has already been logged.
// Cleared when a usable reading arrives, so each run logs exactly once.
const estimateSetAsideLogged = new Set<string>();

/** A usable reading ends the set-aside episode for the session. */
export function notePiUsageReadingUsed(sessionId: string): void {
	estimateSetAsideLogged.delete(sessionId);
}

function entryUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const u = usage as Record<string, unknown>;
	const n = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	return (
		n(u.totalTokens) ||
		n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite)
	);
}

/**
 * Whether Pi's `getContextUsage().tokens` is currently a character-count
 * estimate of the whole raw session branch rather than a figure anchored on
 * recorded provider usage.
 *
 * Pi (0.87, `estimateProjectedContextTokens`) trusts the last assistant usage
 * only while no `context_edit` or `compaction` entry follows it. When one does
 * (Pi appends a `context_edit` to hide a failed attempt before an automatic
 * retry, e.g. after a WebSocket close), it re-estimates every message on the
 * branch at chars/4. Pi's branch is the unreduced session file, so that figure
 * ignores everything Magic Context removed from the served request and says
 * nothing about what the provider actually receives.
 *
 * Mirrors Pi's rule on the raw branch: the newest assistant entry with usable
 * usage (not aborted or errored, non-zero) against the newest invalidating
 * entry.
 */
export function isPiLiveUsageRawBranchEstimate(
	branchEntries: readonly unknown[] | null | undefined,
): boolean {
	if (!branchEntries) return false;
	for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
		const entry = branchEntries[index] as
			| { type?: unknown; message?: unknown }
			| null
			| undefined;
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "context_edit" || entry.type === "compaction")
			return true;
		if (entry.type !== "message") continue;
		if (piMessageAnchorsLiveUsage(entry.message)) return false;
	}
	return false;
}

/**
 * Whether a message, once on the branch, is the provider usage Pi anchors its
 * live figure on: an assistant reply that was not aborted or errored and
 * reports non-zero usage.
 */
export function piMessageAnchorsLiveUsage(message: unknown): boolean {
	const m = message as
		| { role?: unknown; stopReason?: unknown; usage?: unknown }
		| null
		| undefined;
	return (
		m?.role === "assistant" &&
		m.stopReason !== "aborted" &&
		m.stopReason !== "error" &&
		entryUsageTokens(m.usage) > 0
	);
}

/**
 * Runs isPiLiveUsageRawBranchEstimate on the branch read from a Pi context's
 * session manager. Returns false when the branch cannot be read, so the live
 * figure is then used as it was before this check existed.
 */
export function isPiContextUsageRawBranchEstimate(
	sessionManager: unknown,
): boolean {
	try {
		const manager = sessionManager as
			| { getBranch?: () => unknown[] }
			| null
			| undefined;
		if (typeof manager?.getBranch !== "function") return false;
		return isPiLiveUsageRawBranchEstimate(manager.getBranch());
	} catch {
		return false;
	}
}

export interface ResolveGuardedPiPressureSnapshotArgs
	extends ResolvePiPressureSnapshotArgs {
	/** Absolute request wall, not the output-reserved percentage denominator. */
	providerInputLimit?: number;
	/** Tokenized outgoing messages plus the current system/tool envelope. */
	fallbackInputTokens?: number;
	/** Pi's live figure is a raw-branch estimate (see isPiLiveUsageRawBranchEstimate). */
	liveIsRawBranchEstimate?: boolean;
	/**
	 * `persistedInputTokens` is itself Pi's live figure (the caller had no
	 * persisted provider reading and fell back to `getContextUsage()`), so
	 * it is set aside together with the live figure.
	 */
	persistedFromLive?: boolean;
}

/**
 * `resolvePiPressureSnapshot` with Pi's raw-branch estimate left out at any
 * size, and no logging. The transform (through
 * resolvePiPressureSnapshotWithEstimateGuard) and the status displays both
 * use it, so `/ctx-status` and the footer show the same figure the pressure
 * decision used.
 */
export function resolveGuardedPiPressureSnapshot(
	args: ResolveGuardedPiPressureSnapshotArgs,
): {
	snapshot: PiPressureSnapshot;
	setAsideEstimate: number | undefined;
} {
	const live =
		typeof args.liveInputTokens === "number" &&
		Number.isFinite(args.liveInputTokens)
			? args.liveInputTokens
			: 0;
	const setAside = args.liveIsRawBranchEstimate === true && live > 0;
	const bound = args.providerInputLimit ?? MAX_UNKNOWN_PI_INPUT_TOKENS;
	const rejectedPersisted = args.persistedInputTokens > bound;
	const rejectedLive = live > bound;
	const sanitized = {
		...args,
		persistedInputTokens: rejectedPersisted ? 0 : args.persistedInputTokens,
		persistedPercentage: rejectedPersisted ? 0 : args.persistedPercentage,
		liveInputTokens: rejectedLive ? undefined : args.liveInputTokens,
	};
	const snapshot = resolvePiPressureSnapshot(
		setAside
			? {
					...sanitized,
					liveInputTokens: undefined,
					...(args.persistedFromLive
						? { persistedInputTokens: 0, persistedPercentage: 0 }
						: {}),
				}
			: sanitized,
	);
	if (args.fallbackInputTokens !== undefined) {
		return {
			snapshot: resolvePiPressureSnapshot({
				...args,
				persistedInputTokens: snapshot.inputTokens,
				persistedPercentage: snapshot.percentage,
				liveInputTokens: args.fallbackInputTokens,
			}),
			setAsideEstimate: setAside ? live : undefined,
		};
	}
	return { snapshot, setAsideEstimate: setAside ? live : undefined };
}

// Per session, whether Pi's live usage figure was a raw-branch estimate the
// last time the transform or message_end classified it.
const lastLiveUsageClassification = new Map<string, boolean>();

/**
 * Record how the transform or message_end classified Pi's live usage figure
 * (see isPiLiveUsageRawBranchEstimate), for the status displays.
 */
export function recordPiLiveUsageClassification(
	sessionId: string,
	isRawBranchEstimate: boolean,
): void {
	lastLiveUsageClassification.set(sessionId, isRawBranchEstimate);
}

export function clearPiLiveUsageClassification(sessionId: string): void {
	lastLiveUsageClassification.delete(sessionId);
	rejectedUsageLogged.delete(sessionId);
	rejectedProviderUsage.delete(sessionId);
}

/**
 * Pressure for the status displays (`/ctx-status` and the footer): the
 * persisted provider reading against Pi's live figure, with the raw-branch
 * estimate set aside exactly as the transform sets it aside.
 *
 * The displays reuse the classification the transform and message_end last
 * recorded instead of walking the branch themselves: the footer redraws on
 * every tool result, the status dialog refreshes on a timer, and background
 * work (such as a recomp) redraws the footer from a command context whose
 * session may no longer be readable. Pi appends the `context_edit` before the
 * retried request's context pass, and the next provider reply runs
 * message_end, so the recorded value follows the branch.
 */
export function resolvePiStatusPressureSnapshot(
	args: ResolveGuardedPiPressureSnapshotArgs & { sessionId: string },
): PiPressureSnapshot {
	const { sessionId, ...pressureArgs } = args;
	return resolveGuardedPiPressureSnapshot({
		...pressureArgs,
		liveIsRawBranchEstimate:
			lastLiveUsageClassification.get(sessionId) === true,
	}).snapshot;
}

/** Log a set-aside raw-branch estimate once per episode for the session. */
export function noteRawBranchEstimateSetAside(
	sessionId: string,
	reading: number,
	source: string,
): void {
	if (estimateSetAsideLogged.has(sessionId)) return;
	estimateSetAsideLogged.add(sessionId);
	sessionLog(
		sessionId,
		`usage reading ${reading} set aside (${source}): Pi re-estimated its whole unreduced session branch because a context edit or compaction follows the last recorded usage (for example after a retried request); keeping the previous reading until provider usage arrives`,
	);
}

/**
 * `resolvePiPressureSnapshot` for the pressure decision, with Pi's raw-branch
 * estimate (see isPiLiveUsageRawBranchEstimate) left out at any size: it is
 * Pi's own figure, not a provider report, and it ignores everything Magic
 * Context removed from the served request. The previous provider reading
 * stands instead, and the first set-aside figure of an episode is logged.
 *
 * A provider reading beyond an authoritative request wall cannot measure one
 * request. Leave it out rather than clamping it into a phantom emergency.
 * Catalog metadata is advisory; accepted measurements can still repair it.
 */
export function resolvePiPressureSnapshotWithEstimateGuard(
	args: ResolveGuardedPiPressureSnapshotArgs & {
		sessionId: string;
		source: string;
	},
): PiPressureSnapshot {
	const { snapshot, setAsideEstimate } = resolveGuardedPiPressureSnapshot(args);
	const bound = args.providerInputLimit ?? MAX_UNKNOWN_PI_INPUT_TOKENS;
	const rejected = Math.max(
		args.persistedInputTokens,
		args.liveInputTokens ?? 0,
	);
	if (rejected > bound)
		noteRejectedPiUsage(args.sessionId, rejected, bound, args.source);
	if (setAsideEstimate !== undefined) {
		noteRawBranchEstimateSetAside(
			args.sessionId,
			setAsideEstimate,
			args.source,
		);
	} else if (snapshot.inputTokens > 0) {
		notePiUsageReadingUsed(args.sessionId);
	}
	return snapshot;
}

export function formatPiPressureForLog(snapshot: PiPressureSnapshot): string {
	return `usage=${snapshot.percentage.toFixed(1)}% (${snapshot.inputTokens} tokens, limit=${snapshot.contextLimit ?? "?"})`;
}
