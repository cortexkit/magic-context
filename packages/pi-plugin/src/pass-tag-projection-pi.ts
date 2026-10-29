import {
	computeProtectionWindow,
	rowWindowMass,
} from "@magic-context/core/features/magic-context/protection-window";
import type { Transcript } from "@magic-context/core/shared/transcript";
import type { PiTagMetadata } from "./tag-snapshot-pi";

/** Select replay rows from the same pinned generation, including duplicate-number groups. */
export function projectPiReplayDrops(
	transcript: Transcript,
	metadata: readonly PiTagMetadata[],
) {
	const owners = new Set<string>();
	const addresses = new Set<string>();
	const calls = new Set<string>();
	const prefixes = new Set<number>();
	for (const message of transcript.messages) {
		owners.add(message.info.id ?? "");
		let ordinal = 0;
		for (const part of message.parts) {
			if (part.kind === "text") {
				addresses.add(`${message.info.id}:p${ordinal++}`);
				const prefix = /^§(\d+)§\s/.exec(part.getText() ?? "");
				if (prefix) prefixes.add(Number(prefix[1]));
			} else if (
				(part.kind === "tool_use" || part.kind === "tool_result") &&
				part.id
			)
				calls.add(part.id);
		}
	}
	const numbers = new Set<number>();
	for (const tag of metadata) {
		if (tag.status !== "dropped") continue;
		if (
			prefixes.has(tag.tagNumber) ||
			(tag.type === "tool"
				? calls.has(tag.messageId) &&
					(tag.toolOwnerMessageId === null ||
						tag.toolOwnerMessageId === "" ||
						owners.has(tag.toolOwnerMessageId))
				: addresses.has(tag.messageId))
		)
			numbers.add(tag.tagNumber);
	}
	return metadata.filter(
		(tag) => tag.status === "dropped" && numbers.has(tag.tagNumber),
	);
}

/** Reverse canonical rows without allocating sorted copies or historical tie-group arrays. */
export function protectedPiPassTagNumbers(
	rows: readonly PiTagMetadata[],
	floor: number,
	toolsRatio = 1,
): Set<number> {
	// Legacy nonfinite ordinals normalize to zero in the shared helper. Negative
	// ratios are not monotone, so they also need its original walk and ordering.
	if (!(toolsRatio >= 0) || rows.some((row) => !Number.isFinite(row.tagNumber)))
		return computeProtectionWindow(rows, floor, toolsRatio).protectedTagNumbers;
	const numbers: number[] = [];
	let group: number | undefined;
	let groups = 0;
	let mass = 0;
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		if (row?.type !== "tool") continue;
		if (row.tagNumber !== group) {
			// Test only after a whole duplicate-number group. Even a zero floor
			// protects the newest three distinct tool numbers, across all statuses.
			if (groups >= 3 && Math.ceil(mass * toolsRatio) >= floor) break;
			group = row.tagNumber;
			groups++;
			numbers.push(row.tagNumber);
		}
		mass += rowWindowMass(row);
	}
	return new Set(numbers.reverse());
}
