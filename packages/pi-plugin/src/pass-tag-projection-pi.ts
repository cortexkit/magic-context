import { rowWindowMass } from "@magic-context/core/features/magic-context/protection-window";
import type { PiTagMetadata } from "./tag-snapshot-pi";

/** Reverse canonical rows without allocating sorted copies or historical tie-group arrays. */
export function protectedPiPassTagNumbers(
	rows: readonly PiTagMetadata[],
	floor: number,
	toolsRatio = 1,
): Set<number> {
	const numbers = new Set<number>();
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
		}
		numbers.add(row.tagNumber);
		mass += rowWindowMass(row);
	}
	return numbers;
}
