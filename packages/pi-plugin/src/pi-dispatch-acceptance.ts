import {
	type PiForeignEvidence,
	type PiForeignRows,
	piWithoutForeignRows,
} from "./pi-dispatch-foreign";
import {
	type PiDispatchAlignedRow,
	type PiPreparedStructure,
	piDispatchRowCount,
	piPreparedStructureMismatch,
} from "./pi-dispatch-structure";

/** Existing provider matching remains authoritative before and after removing inserts. */
export function piCheckPreparedDispatch(
	payload: unknown,
	prepared: PiPreparedStructure | undefined,
	evidence: PiForeignEvidence | undefined,
	onImageTrim?: (counts: {
		planned: number;
		actual: number;
		trimmed: number;
	}) => void,
	onComparatorRun?: () => void,
): { mismatch?: string; foreign?: PiForeignRows } {
	onComparatorRun?.();
	const mismatch = piPreparedStructureMismatch(payload, prepared, onImageTrim);
	if (!mismatch) return {};
	const rowCounts = /expectedRows=(\d+) actualRows=(\d+)/u.exec(mismatch);
	// Reuse an exact count from the original comparator. Variable row plans
	// need the conservative reader instead; the hint never proves admission.
	const countHint =
		rowCounts &&
		mismatch.includes("comparison=count") &&
		!prepared?.anthropicOptional &&
		!prepared?.responsesAlternatives &&
		!prepared?.imageBudget
			? Number(rowCounts[2])
			: undefined;
	const foreign = piWithoutForeignRows(
		payload,
		evidence,
		(prefix) => piDispatchRowCount(prefix, prepared),
		(filtered) => {
			onComparatorRun?.();
			let alignment: readonly PiDispatchAlignedRow[] | undefined;
			return piPreparedStructureMismatch(
				filtered,
				prepared,
				onImageTrim,
				(rows) => {
					alignment = rows;
				},
			)
				? undefined
				: alignment;
		},
		countHint,
	);
	// The analysis returns a payload only after tag binding and the unchanged
	// comparator pass; an explanatory reason can never accompany acceptance.
	if (foreign.payload !== undefined && !foreign.reason) return { foreign };
	const reason =
		foreign.reason === "not-text-user" &&
		rowCounts &&
		Number(rowCounts[2]) <= Number(rowCounts[1])
			? "prepared-row"
			: (foreign.reason ?? "prepared-row");
	const rule =
		reason === "limit" ||
		reason === "search-limit" ||
		reason === "ambiguous-rewrite"
			? 4
			: reason === "session-content" || reason === "unreadable-branch"
				? 3
				: reason === "not-text-user" || reason === "tool-pair"
					? 2
					: 1;
	return {
		mismatch: `${mismatch}; foreign rule=${rule} reason=${reason} count=${foreign.count} chars=${foreign.chars}${reason === "ambiguous-rewrite" ? ` gapPrepared=${foreign.gapPrepared ?? 0} gapWire=${foreign.gapWire ?? 0} gapChars=${foreign.gapChars ?? 0}; another extension is adding messages beside a rewritten untagged prepared row (maximum 4 rows, 32768 characters)` : reason === "search-limit" ? "; another extension is adding messages after Magic Context's pass; bounded reconciliation search exhausted (maximum 64 comparator runs)" : reason === "limit" ? "; another extension is adding messages after Magic Context's pass (maximum 4 rows, 32768 characters)" : reason === "unreadable-branch" ? "; the host's complete session entries could not be read" : reason === "session-content" ? "; another extension added a message identical to session content" : ""}`,
	};
}
