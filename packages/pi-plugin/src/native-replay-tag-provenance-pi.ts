import { createHash } from "node:crypto";
import { isRecord } from "@magic-context/core/shared/record-type-guard";

/** Prepared-message evidence, published only after the native strip decision is durable. */
export const PI_NATIVE_TAG_STRIP_PROVENANCE = "magicContextNativeTagStrips";

export function nativeResponseTagStripKey(
	id: unknown,
	phase: unknown,
	text: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([id, phase, text]))
		.digest("hex");
}

/** Check passed-in evidence without consulting storage on the dispatch path. */
export function ownsNativeResponseTagStrip(
	decisions: unknown,
	id: unknown,
	phase: unknown,
	text: string,
): boolean {
	if (
		!isRecord(decisions) ||
		(phase !== undefined && phase !== "commentary" && phase !== "final_answer")
	)
		return false;
	return Object.entries(decisions).some(
		([key, original]) =>
			typeof original === "string" &&
			/^§\d+§ /u.test(original) &&
			original.replace(/^§\d+§ /u, "") === text &&
			nativeResponseTagStripKey(id, phase, original) === key,
	);
}
