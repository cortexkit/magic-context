import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { resolvePiWindowGeometry } from "./pi-context-limit";
import {
	piPressureEvidenceLimit,
	resolvePiStatusPressureSnapshot,
} from "./pi-pressure";
import {
	piProvenFloorModelKey,
	resolvePiProvenInputFloor,
} from "./pi-proven-floor";

const STATUS_KEY = "magic-context";
const RECENT_FAILURE_MS = 60_000;
const recompSessions = new Set<string>();

export interface StatusLineDeps {
	db: ContextDatabase;
	projectIdentity: string;
}

export function setMagicContextRecompActive(
	sessionId: string,
	active: boolean,
): void {
	if (active) recompSessions.add(sessionId);
	else recompSessions.delete(sessionId);
}

type SessionMetaStatus = {
	compartment_in_progress: number | null;
	historian_failure_count: number | null;
	historian_last_failure_at: number | null;
	last_input_tokens: number | null;
	last_context_percentage: number | null;
	detected_context_limit: number | null;
};

const lastRenderedBySession = new Map<string, string>();

/**
 * Persistent Magic Context footer status for Pi.
 *
 * Hot path by design: one session_meta row read + ctx.getContextUsage(). No tag
 * or compartment enumeration here; the rich breakdown is reserved for /ctx-status.
 */
export function registerStatusLine(
	pi: ExtensionAPI,
	deps: StatusLineDeps,
): void {
	void deps.projectIdentity;

	pi.on("session_start", async (_event, ctx) =>
		updateStatusLine(ctx, deps, true),
	);
	pi.on("agent_end", async (_event, ctx) => updateStatusLine(ctx, deps));
	pi.on("session_compact", async (_event, ctx) =>
		updateStatusLine(ctx, deps, true),
	);
	pi.on("tool_execution_end", async (_event, ctx) =>
		updateStatusLine(ctx, deps),
	);
	pi.on("message_end", async (event, ctx) => {
		const role = (event.message as { role?: unknown } | undefined)?.role;
		if (role === "assistant") updateStatusLine(ctx, deps);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = resolveSessionId(ctx);
		if (sessionId) lastRenderedBySession.delete(sessionId);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}

export function updateStatusLine(
	ctx: ExtensionContext,
	deps: StatusLineDeps,
	force = false,
): void {
	const sessionId = resolveSessionId(ctx);
	if (!sessionId) return;
	const text = renderStatusText(ctx, deps.db, sessionId);
	if (!force && lastRenderedBySession.get(sessionId) === text) return;
	lastRenderedBySession.set(sessionId, text);
	ctx.ui.setStatus(STATUS_KEY, text);
}

export function renderStatusText(
	ctx: ExtensionContext,
	db: ContextDatabase,
	sessionId: string,
): string {
	const usage = ctx.getContextUsage?.();
	const meta = readSessionMetaStatus(db, sessionId);
	const providerInputLimit = piPressureEvidenceLimit(
		resolvePiWindowGeometry({
			rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
			rawContextWindowSource: "catalog",
			model: ctx.model,
			detectedContextLimit: meta?.detected_context_limit ?? undefined,
		}),
	);
	const provenInputTokens = resolvePiProvenInputFloor({
		db,
		sessionId,
		modelKey: piProvenFloorModelKey(ctx.model),
		readBranch: () => ctx.sessionManager.getBranch(),
		providerInputLimit,
	});

	const liveInputTokens =
		typeof usage?.tokens === "number" && Number.isFinite(usage.tokens)
			? usage.tokens
			: undefined;
	const persistedInputTokens =
		typeof meta?.last_input_tokens === "number" &&
		Number.isFinite(meta.last_input_tokens) &&
		meta.last_input_tokens >= 0
			? meta.last_input_tokens
			: undefined;
	const windowGeometry = resolvePiWindowGeometry({
		rawContextWindow: usage?.contextWindow ?? ctx.model?.contextWindow,
		rawContextWindowSource: "catalog",
		model: ctx.model,
		detectedContextLimit:
			typeof meta?.detected_context_limit === "number" &&
			meta.detected_context_limit > 0
				? meta.detected_context_limit
				: undefined,
		provenInputTokens: provenInputTokens || undefined,
		persistedInputTokens,
		persistedPercentage: meta?.last_context_percentage ?? undefined,
	});
	const pressure =
		liveInputTokens !== undefined || persistedInputTokens !== undefined
			? resolvePiStatusPressureSnapshot({
					providerInputLimit,
					sessionId,
					persistedPercentage: meta?.last_context_percentage ?? 0,
					persistedInputTokens: persistedInputTokens ?? 0,
					liveInputTokens,
					usableContextLimit: windowGeometry?.usableSoft,
				})
			: undefined;
	const inputTokens = pressure?.inputTokens;
	const pct = pressure?.percentage;
	const state = renderHistorianState(meta, recompSessions.has(sessionId));
	return `mc: ${inputTokens === undefined ? "--" : fmt(inputTokens)} (${pct === undefined ? "--" : `${Math.round(pct)}%`}) · ${state}`;
}

function renderHistorianState(
	meta: SessionMetaStatus | undefined,
	recompActive: boolean,
): string {
	const failureCount = meta?.historian_failure_count ?? 0;
	const lastFailureAt = meta?.historian_last_failure_at ?? 0;
	if (failureCount > 0 && lastFailureAt > 0) {
		const ageMs = Date.now() - lastFailureAt;
		if (ageMs >= 0 && ageMs < RECENT_FAILURE_MS) return "⚠ historian failed";
	}
	if (recompActive) return "recomp";
	if ((meta?.compartment_in_progress ?? 0) !== 0) return "historian";
	return "idle";
}

function readSessionMetaStatus(
	db: ContextDatabase,
	sessionId: string,
): SessionMetaStatus | undefined {
	try {
		return db
			.prepare<[string], SessionMetaStatus>(
				`SELECT compartment_in_progress, historian_failure_count,
				        historian_last_failure_at, last_input_tokens,
				        last_context_percentage, detected_context_limit
				 FROM session_meta WHERE session_id = ?`,
			)
			.get(sessionId);
	} catch {
		return undefined;
	}
}

function resolveSessionId(ctx: ExtensionContext): string | undefined {
	const getSessionId = (
		ctx.sessionManager as { getSessionId?: () => string | undefined }
	).getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(ctx.sessionManager);
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function fmt(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
	if (abs >= 1_000) return `${trim1(n / 1_000)}K`;
	return String(Math.round(n));
}

function trim1(n: number): string {
	const rounded = n.toFixed(1);
	return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}
