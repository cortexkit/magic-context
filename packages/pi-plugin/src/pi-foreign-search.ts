export interface PiForeignCandidate {
	index: number;
	text: string;
}

/** Order proposals only; the comparator, anchors and gap rules still decide admission. */
export function* piForeignDeletionSets(
	candidates: readonly PiForeignCandidate[],
	lastUser: number,
	maxRows: number,
): Generator<readonly PiForeignCandidate[]> {
	const byIndex = new Map(candidates.map((row) => [row.index, row]));
	const seen = new Set<string>();
	function* proposal(rows: readonly PiForeignCandidate[]) {
		if (!rows.length || rows.length > maxRows) return;
		const key = rows.map((row) => row.index).join(",");
		if (seen.has(key)) return;
		seen.add(key);
		yield rows;
	}
	// Filtering removed every known prepared slot. Whole remaining stretches,
	// including multiple separate insertions, are the common extension case.
	if (candidates.length <= maxRows) yield* proposal(candidates);
	let run: PiForeignCandidate[] = [];
	for (const row of candidates) {
		if (run.length && row.index !== run[run.length - 1].index + 1) {
			yield* proposal(run);
			run = [];
		}
		run.push(row);
	}
	yield* proposal(run);
	const first = candidates[0]?.index;
	const last = candidates[candidates.length - 1]?.index;
	for (const boundary of [first, last, lastUser - 1]) {
		if (boundary === undefined) continue;
		for (let size = maxRows; size >= 1; size--) {
			const start = boundary === first ? boundary : boundary - size + 1;
			const rows = Array.from({ length: size }, (_, offset) =>
				byIndex.get(start + offset),
			);
			if (rows.every((row) => row !== undefined)) yield* proposal(rows);
		}
	}
	const selected: PiForeignCandidate[] = [];
	function* rest(
		start: number,
		remaining: number,
	): Generator<readonly PiForeignCandidate[]> {
		if (!remaining) {
			yield* proposal([...selected]);
			return;
		}
		for (let index = start; index <= candidates.length - remaining; index++) {
			selected.push(candidates[index]);
			yield* rest(index + 1, remaining - 1);
			selected.pop();
		}
	}
	for (let size = 1; size <= Math.min(maxRows, candidates.length); size++)
		yield* rest(0, size);
}
