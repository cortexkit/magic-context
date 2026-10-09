/**
 * The model a Pi session's proven input floor was proven on.
 *
 * `session_meta.observed_safe_input_tokens` is the largest prompt a provider
 * accepted in the session. Magic Context lifts the usable context limit to it
 * when Pi's configured window is smaller. That proof is only about the model
 * (provider route and model id) that served the request: a 786K prompt
 * accepted by a 1M-window model says nothing about a model with a 500K
 * window. So the floor is recorded together with that model, and applied only
 * while the session runs on it.
 *
 * The model is kept in the JSON object in `session_meta.deferred_execute_state`
 * (a namespaced per-session state column that the decision calibration also
 * uses), under its own key, with the token count it was recorded for. A floor
 * whose column value no longer equals the recorded count was written without
 * a model (by a release before this check, or by a path that does not record
 * one), so nothing says which model proved it: it is dropped on first use.
 * Legacy model-keyed records are re-derived once from accepted assistant usage
 * on the session branch. New records mark that measured basis explicitly; neither
 * a calibrated local estimate nor a back-derived percentage establishes capacity.
 */

import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { providerResponseFailed } from "@magic-context/core/shared/provider-response-completion";
import {
	computePiPressure,
	extractAssistantUsage,
	MAX_UNKNOWN_PI_INPUT_TOKENS,
} from "./pi-pressure";

const FLOOR_STATE_KEY = "piProvenInputFloor";

// `session|proven model|current model` triples already logged as not applied.
const mismatchLogged = new Set<string>();

export interface PiProvenFloorRecord {
	/** `provider/id` exactly as Pi reports the model that served the request. */
	modelKey: string;
	tokens: number;
}

/** Only assistant provider usage proves capacity; Pi's live estimates do not. */
function largestAcceptedInput(
	entries: readonly unknown[],
	modelKey: string,
	providerInputLimit: number,
): number {
	let largest = 0;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as { type?: unknown; message?: unknown };
		if (
			row.type !== "message" ||
			!row.message ||
			typeof row.message !== "object"
		)
			continue;
		const message = row.message as {
			provider?: unknown;
			model?: unknown;
			stopReason?: unknown;
			errorMessage?: unknown;
		};
		if (
			piProvenFloorModelKey({
				provider: message.provider,
				id: message.model,
			}) !== modelKey ||
			providerResponseFailed({
				finish: message.stopReason,
				error: message.errorMessage,
			})
		)
			continue;
		const pressure = computePiPressure(
			extractAssistantUsage(message),
			0,
			providerInputLimit,
		);
		if (pressure) largest = Math.max(largest, pressure.inputTokens);
	}
	return largest;
}

function hasMeasuredBasis(raw: unknown): boolean {
	if (typeof raw !== "string") return false;
	try {
		return JSON.parse(raw)?.[FLOOR_STATE_KEY]?.basis === "provider_usage_v1";
	} catch {
		return false;
	}
}

/** `provider/id` for a Pi model, or undefined when either part is missing. */
export function piProvenFloorModelKey(
	model: { provider?: unknown; id?: unknown } | null | undefined,
): string | undefined {
	if (!model) return undefined;
	if (typeof model.provider !== "string" || model.provider.length === 0)
		return undefined;
	if (typeof model.id !== "string" || model.id.length === 0) return undefined;
	return `${model.provider}/${model.id}`;
}

function readFloorRow(
	db: ContextDatabase,
	sessionId: string,
): { observed: number; state: unknown } {
	try {
		const row = db
			.prepare(
				"SELECT observed_safe_input_tokens, deferred_execute_state FROM session_meta WHERE session_id = ?",
			)
			.get(sessionId) as
			| {
					observed_safe_input_tokens?: unknown;
					deferred_execute_state?: unknown;
			  }
			| undefined;
		const observed = row?.observed_safe_input_tokens;
		return {
			observed:
				typeof observed === "number" && Number.isFinite(observed)
					? observed
					: 0,
			state: row?.deferred_execute_state,
		};
	} catch {
		return { observed: 0, state: undefined };
	}
}

function parseFloorRecord(raw: unknown): PiProvenFloorRecord | undefined {
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	try {
		const root = JSON.parse(raw) as Record<string, unknown> | null;
		const value = root?.[FLOOR_STATE_KEY] as
			| { modelKey?: unknown; tokens?: unknown }
			| undefined;
		if (
			value &&
			typeof value.modelKey === "string" &&
			value.modelKey.length > 0 &&
			typeof value.tokens === "number" &&
			Number.isFinite(value.tokens)
		) {
			return { modelKey: value.modelKey, tokens: value.tokens };
		}
	} catch {
		// An unreadable state document records no model.
	}
	return undefined;
}

export function readPiProvenFloorRecord(
	db: ContextDatabase,
	sessionId: string,
): PiProvenFloorRecord | undefined {
	return parseFloorRecord(readFloorRow(db, sessionId).state);
}

/**
 * Record the model and largest provider-measured accepted input, without scaling.
 * Call only with accepted assistant usage, never a live or calibrated estimate.
 * Merged with json_set so unrelated decision calibration state is kept.
 */
export function recordPiProvenFloorModel(
	db: ContextDatabase,
	sessionId: string,
	modelKey: string,
	tokens: number,
): void {
	getOrCreateSessionMeta(db, sessionId);
	db.prepare(
		`UPDATE session_meta
		    SET deferred_execute_state = json_set(
		          CASE WHEN json_valid(deferred_execute_state)
		                AND json_type(deferred_execute_state) = 'object'
		               THEN deferred_execute_state ELSE '{}' END,
		          '$.${FLOOR_STATE_KEY}', json(?))
		  WHERE session_id = ?`,
	).run(
		JSON.stringify({ modelKey, tokens, basis: "provider_usage_v1" }),
		sessionId,
	);
}

/**
 * The persisted floor to apply for `modelKey`, or 0. Reads the stored floor
 * itself, so a caller holding an older copy of the session row cannot apply
 * or re-drop a floor that has since changed.
 *
 * - A floor with no recorded model is cleared from the session and not used.
 * - A floor proven on another model is not used. It stays stored, so it
 *   applies again if the session returns to that model, until a request on
 *   the current model records a floor of its own.
 * - With no current model key nothing is known to match, so no floor applies.
 */
export function resolvePiProvenInputFloor(args: {
	db: ContextDatabase;
	sessionId: string;
	modelKey: string | undefined;
	/** Authoritative raw request wall, before applying the persisted floor. */
	providerInputLimit?: number;
	/** Read lazily, only to re-derive a legacy floor on upgrade. */
	readBranch?: () => readonly unknown[] | undefined;
}): number {
	const row = readFloorRow(args.db, args.sessionId);
	const observed = row.observed;
	if (observed <= 0) return 0;
	const record = parseFloorRecord(row.state);
	if (!record || record.tokens !== observed) {
		sessionLog(
			args.sessionId,
			`proven input floor ${observed} has no recorded model; dropped instead of applied to ${args.modelKey ?? "the current model"}`,
		);
		updateSessionMeta(args.db, args.sessionId, {
			observedSafeInputTokens: 0,
			cacheAlertSent: false,
		});
		return 0;
	}
	if (args.modelKey === undefined || record.modelKey !== args.modelKey) {
		const logKey = `${args.sessionId}|${record.modelKey}|${args.modelKey ?? ""}`;
		if (!mismatchLogged.has(logKey)) {
			mismatchLogged.add(logKey);
			sessionLog(
				args.sessionId,
				`proven input floor ${observed} was proven on ${record.modelKey}; not applied to ${args.modelKey ?? "an unknown model"}`,
			);
		}
		return 0;
	}
	const providerInputLimit =
		args.providerInputLimit ?? MAX_UNKNOWN_PI_INPUT_TOKENS;
	if (!hasMeasuredBasis(row.state) || observed > providerInputLimit) {
		// Neither a legacy latch nor last_input_tokens proves a measured accepted
		// request: the latter may hold a live estimate. Rebuild from the session's
		// assistant usage, without applying decision/tokenizer calibration.
		let measured = 0;
		try {
			measured = largestAcceptedInput(
				args.readBranch?.() ?? [],
				record.modelKey,
				providerInputLimit,
			);
		} catch {
			// If the branch is unavailable, discard unverified capacity rather than
			// continuing to suppress compaction with a potentially inflated floor.
		}
		updateSessionMeta(args.db, args.sessionId, {
			observedSafeInputTokens: measured,
			cacheAlertSent: false,
			lastUsageContextLimit: 0,
		});
		recordPiProvenFloorModel(
			args.db,
			args.sessionId,
			record.modelKey,
			measured,
		);
		sessionLog(
			args.sessionId,
			`legacy proven input floor ${observed} re-derived from accepted provider usage: ${measured}`,
		);
		return measured;
	}
	return observed;
}
