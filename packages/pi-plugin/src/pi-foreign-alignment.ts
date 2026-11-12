import { piDateReminderText } from "./pi-dispatch-date-reminder";
import type { PiForeignRows } from "./pi-dispatch-foreign";
import type { PiDispatchAlignedRow } from "./pi-dispatch-structure";
import {
	type PiForeignEvidence,
	piForeignExpectedTextOnly,
	piForeignExpectedTexts,
	piForeignRecord,
	piForeignSessionContent,
	piForeignTag,
	piForeignWireIdentity,
} from "./pi-foreign-session-index";

export interface PiForeignWireRow {
	index: number;
	value: unknown;
	text?: string;
	tag?: string;
	paired: boolean;
}

/**
 * An unchanged comparator alignment identifies kept slots, not the origin of
 * indistinguishable user rows. Anchor tags, exact untagged text and structural
 * rows to their own slots, then protect every possible insertion in each gap.
 * In an ambiguous rewritten-user gap, all rows must qualify and the largest
 * possible added rows determine the character budget.
 */
export function piForeignAlignment(
	wire: readonly PiForeignWireRow[],
	removed: ReadonlySet<number>,
	alignment: readonly PiDispatchAlignedRow[],
	evidence: PiForeignEvidence,
	limits: { rows: number; chars: number },
): Pick<
	PiForeignRows,
	"reason" | "chars" | "count" | "gapPrepared" | "gapWire" | "gapChars"
> {
	const fail = (reason: PiForeignRows["reason"]) => ({
		reason,
		count: 0,
		chars: 0,
	});
	const byWire = new Map<unknown, PiDispatchAlignedRow[]>();
	for (const pair of alignment)
		for (const value of pair.wire) {
			let pairs = byWire.get(value);
			if (!pairs) {
				pairs = [];
				byWire.set(value, pairs);
			}
			pairs.push(pair);
		}
	const slots: {
		info: PiForeignWireRow;
		pairs: readonly PiDispatchAlignedRow[];
	}[] = [];
	const relevant: PiForeignWireRow[] = [];
	const slotByIndex = new Map<number, number>();
	for (const info of wire) {
		if (removed.has(info.index)) {
			relevant.push(info);
			continue;
		}
		const pairs = byWire.get(info.value);
		// The existing parser deliberately excludes instruction prefixes, native
		// controls and Responses reasoning items. They were not removed and stay
		// governed by its original rules, outside the foreign-row budget.
		if (!pairs) {
			if (
				info.text !== undefined &&
				info.text !== "Continue." &&
				!piDateReminderText(info.text)
			)
				return fail("prepared-row");
			continue;
		}
		slotByIndex.set(info.index, slots.length);
		slots.push({ info, pairs });
		relevant.push(info);
	}
	const tags = new Map<string, Set<number>>();
	const exact = new Map<string, Set<number>>();
	const add = (map: Map<string, Set<number>>, key: string, index: number) => {
		let set = map.get(key);
		if (!set) {
			set = new Set();
			map.set(key, set);
		}
		set.add(index);
	};
	for (const [index, slot] of slots.entries())
		for (const pair of slot.pairs) {
			if (pair.role !== "user" || pair.calls.length || pair.results.length)
				continue;
			const tag = piForeignTag(piForeignRecord(pair.source)?.content);
			if (tag) add(tags, tag, index);
			else {
				for (const text of pair.exactText !== undefined
					? [pair.exactText]
					: pair.systemText
						? [pair.systemText.join(""), pair.systemText.join("\n")]
						: piForeignExpectedTexts(evidence, pair.source))
					add(exact, piForeignWireIdentity(text), index);
			}
		}
	const anchors: { wire: number; slot: number }[] = [{ wire: -1, slot: -1 }];
	for (const [index, info] of relevant.entries()) {
		const target =
			(info.tag && tags.get(info.tag)) ||
			(info.text !== undefined && exact.get(piForeignWireIdentity(info.text)));
		const slot = slotByIndex.get(info.index);
		if (target && (slot === undefined || !target.has(slot)))
			return fail("prepared-row");
		if (target || info.text === undefined) {
			if (slot === undefined) return fail("not-text-user");
			if (
				!target &&
				info.text === undefined &&
				slots[slot].pairs.every(
					(pair) =>
						pair.role === "user" &&
						!pair.calls.length &&
						!pair.results.length &&
						!pair.hasImages &&
						piForeignExpectedTextOnly(
							pair.source,
							piForeignRecord(info.value)?.role,
						),
				)
			)
				return fail("not-text-user");
			anchors.push({ wire: index, slot });
		}
	}
	anchors.push({ wire: relevant.length, slot: slots.length });
	let count = 0,
		chars = 0;
	let ambiguous:
		| { gapPrepared: number; gapWire: number; gapChars: number }
		| undefined;
	for (let index = 1; index < anchors.length; index++) {
		const previous = anchors[index - 1],
			next = anchors[index];
		const p = next.slot - previous.slot - 1;
		const w = next.wire - previous.wire - 1;
		if (w < p || p < 0) return fail("prepared-row");
		if (w === p) continue;
		const sizes: number[] = [];
		for (let at = previous.wire + 1; at < next.wire; at++) {
			const row = relevant[at];
			if (row.text === undefined) return fail("not-text-user");
			if (row.paired) return fail("tool-pair");
			sizes.push(row.text.length);
		}
		const added = w - p;
		const worst = sizes
			.sort((a, b) => b - a)
			.slice(0, added)
			.reduce((sum, value) => sum + value, 0);
		count += added;
		chars += worst;
		if (p) ambiguous = { gapPrepared: p, gapWire: w, gapChars: worst };
		if (count > limits.rows) return { count, chars, reason: "limit" };
		if (chars > limits.chars)
			return {
				count,
				chars,
				...ambiguous,
				reason: ambiguous ? "ambiguous-rewrite" : "limit",
			};
		for (let at = previous.wire + 1; at < next.wire; at++) {
			const row = relevant[at];
			const source = piForeignRecord(row.value);
			if (row.text === undefined || !source) return fail("not-text-user");
			if (piForeignSessionContent(evidence, row.text, source))
				return fail("session-content");
		}
	}
	if (count !== removed.size) return fail("prepared-row");
	return { count, chars };
}
