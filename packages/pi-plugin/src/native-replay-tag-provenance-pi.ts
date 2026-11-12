import { createHash } from "node:crypto";

/**
 * The persisted key of one historical native tag strip: the native item's
 * identity and its original output text, so a fork or renumbering cannot move
 * the decision onto another item.
 */
export function nativeResponseTagStripKey(
	id: unknown,
	phase: unknown,
	text: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([id, phase, text]))
		.digest("hex");
}
