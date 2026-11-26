/**
 * Our own count of the last request a Pi session served, for the emergency
 * tool drop.
 *
 * The planner infers the part of the request no tool drop can remove (the
 * fixed part) by subtracting our count of the active tags from a size of the
 * whole request. The provider's usage reading is in the provider's units and
 * can exceed our count of the same request by a wide margin; every token of
 * that difference used to land in the fixed part (issue 860). The planner
 * therefore takes the smaller of the reading and our own count of the last
 * request served. This module makes that count from the copy of that request
 * the last-good-request store captured, and only when it was sent to the same
 * model with the system prompt and tools the pass can size now.
 *
 * The count need not be of the request the reading measured. The tags the
 * planner subtracts are those active now, which describe the last request
 * served; and the smaller of the two sizes can only lower the fixed part.
 */

import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { piLkgLastServedRequest } from "./pi-lkg";
import { countPiServedRequestTokens } from "./pi-overflow-recovery";
import type { PiFitEnvelope } from "./pi-raw-fallback";

export type PiServedCount = { tokens: number } | { unavailable: string };

/**
 * Count the last served request of `sessionId` with the pass's envelope and
 * tag calibration. `envelope` describes the system prompt and active tools of
 * the current pass; the count is made only when the saved request was sent to
 * the same model with the same envelope signature, so those sizes are the
 * ones it carried.
 */
export function countPiLastServedRequest(args: {
	sessionId: string;
	envelope: PiFitEnvelope | undefined;
	calibration: { systemRatio?: number; toolsRatio: number; proseRatio: number };
	recovery: boolean;
}): PiServedCount {
	const saved = piLkgLastServedRequest(args.sessionId);
	if (!saved)
		return {
			unavailable: "no saved copy of the last request served in this process",
		};
	const { envelope } = args;
	if (!envelope?.envelopeSignature)
		return {
			unavailable: "the system prompt or the active tools cannot be sized",
		};
	if (
		!saved.modelKey ||
		piModelRefToCanonical(saved.modelKey).toLowerCase() !== envelope.modelKey
	)
		return { unavailable: "the saved request was served to another model" };
	if (saved.envelopeSignature !== envelope.envelopeSignature)
		return {
			unavailable:
				"the system prompt or tools changed since the saved request was served",
		};
	let messages: unknown;
	try {
		messages = JSON.parse(saved.json);
	} catch {
		return { unavailable: "the saved request cannot be read" };
	}
	if (!Array.isArray(messages))
		return { unavailable: "the saved request cannot be read" };
	const tokens = countPiServedRequestTokens(messages, envelope, {
		calibration: args.calibration,
		recovery: args.recovery,
	});
	if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0)
		return {
			unavailable: "the saved request holds content the count does not know",
		};
	return { tokens };
}
