import { piDateReminderText } from "./pi-dispatch-date-reminder";
import { piGoogleConversation } from "./pi-dispatch-google";
import type { PiDispatchAlignedRow } from "./pi-dispatch-structure";
import { piPreparedDispatchRowLimit } from "./pi-dispatch-structure";
import {
	type PiForeignWireRow,
	piForeignAlignment,
} from "./pi-foreign-alignment";
import { piForeignDeletionSets } from "./pi-foreign-search";
import {
	piForeignRecord as object,
	type PiForeignEvidence,
	piForeignExpectedTexts,
	piForeignFirstText,
	piForeignPreparedTags,
	piForeignSessionContent,
	piForeignTag,
	piForeignWireIdentity,
	piMaterializeForeignEvidence,
} from "./pi-foreign-session-index";

export {
	createPiForeignSessionIndex,
	type PiForeignEvidence,
	type PiForeignSessionIndex,
	piForeignEvidence,
	piForeignEvidenceStats,
	piMaterializeForeignEvidence,
	piProtectPreparedRows,
} from "./pi-foreign-session-index";

// Superpowers 7.0.2 sends about 4.4k characters. Allow several comparable
// extensions, but never an unbounded second conversation after our pass.
export const PI_FOREIGN_MAX_ROWS = 4;
export const PI_FOREIGN_MAX_CHARS = 32 * 1024;
// The caller already ran the original comparator once. Bound both proposed
// deletion sets and reconciliation runs, including refusal paths.
export const PI_FOREIGN_MAX_SEARCH_RUNS = 63;

export interface PiForeignRows {
	payload?: unknown;
	count: number;
	chars: number;
	positions: number[];
	before: number[];
	gapPrepared?: number;
	gapWire?: number;
	gapChars?: number;
	reason?:
		| "prepared-row"
		| "not-text-user"
		| "tool-pair"
		| "session-content"
		| "unreadable-branch"
		| "ambiguous-rewrite"
		| "search-limit"
		| "limit";
}

function conversation(payload: unknown) {
	const body = object(payload);
	if (!body) return undefined;
	const google = piGoogleConversation(body);
	const envelope = google ?? body;
	const field = google
		? "contents"
		: Array.isArray(body.messages)
			? "messages"
			: "input";
	const rows = envelope[field];
	if (!Array.isArray(rows)) return undefined;
	return {
		body,
		google: !!google,
		field,
		rows,
		withRows: (rows: unknown[]) => {
			const filtered = { ...envelope, [field]: rows };
			return google && google !== body
				? { ...body, request: filtered }
				: filtered;
		},
	};
}

function wireText(
	row: Record<string, unknown>,
	google: boolean,
	bedrock: boolean,
	responses: boolean,
): string | undefined {
	if (row.role !== "user") return undefined;
	const allowed = [
		"role",
		google ? "parts" : "content",
		"id",
		"messageId",
		"entryId",
		"timestamp",
		...(responses ? ["type"] : []),
	];
	if (
		Object.keys(row).some((key) => !allowed.includes(key)) ||
		(row.type !== undefined && row.type !== "message")
	)
		return undefined;
	if (
		["id", "messageId", "entryId"].some(
			(key) => row[key] !== undefined && typeof row[key] !== "string",
		)
	)
		return undefined;
	if (
		row.timestamp !== undefined &&
		typeof row.timestamp !== "number" &&
		typeof row.timestamp !== "string"
	)
		return undefined;
	const content = google ? row.parts : row.content;
	if (typeof content === "string")
		return google || bedrock ? undefined : content;
	if (!Array.isArray(content) || content.length === 0) return undefined;
	const texts: string[] = [];
	for (const [index, value] of content.entries()) {
		const block = object(value);
		// Bedrock's final cache breakpoint is metadata, not model-visible text.
		if (bedrock && block?.cachePoint !== undefined) {
			const cache = object(block.cachePoint);
			if (
				index !== content.length - 1 ||
				Object.keys(block).length !== 1 ||
				cache?.type !== "default" ||
				Object.keys(cache).some((key) => !["type", "ttl"].includes(key)) ||
				(cache.ttl !== undefined && cache.ttl !== "5m" && cache.ttl !== "1h")
			)
				return undefined;
			continue;
		}
		if (!block || typeof block.text !== "string") return undefined;
		if (google || bedrock) {
			if (Object.keys(block).some((key) => key !== "text")) return undefined;
		} else {
			if (
				block.type !== (responses ? "input_text" : "text") ||
				Object.keys(block).some(
					(key) => !["type", "text", "cache_control"].includes(key),
				)
			)
				return undefined;
			if (block.cache_control !== undefined) {
				const cache = object(block.cache_control);
				if (
					cache?.type !== "ephemeral" ||
					Object.keys(cache).some(
						(key) => !["type", "ttl", "scope"].includes(key),
					) ||
					(cache.ttl !== undefined &&
						cache.ttl !== "5m" &&
						cache.ttl !== "1h") ||
					(cache.scope !== undefined && cache.scope !== "global")
				)
					return undefined;
			}
		}
		texts.push(block.text);
	}
	return texts.length ? texts.join("\n") : undefined;
}

/** Count open calls; the original provider comparator still binds every call/result ID. */
function toolDelta(row: Record<string, unknown>): number {
	let calls = Array.isArray(row.tool_calls) ? row.tool_calls.length : 0;
	let results = row.role === "tool" || row.role === "toolResult" ? 1 : 0;
	if (
		["function_call", "custom_tool_call", "computer_call"].includes(
			String(row.type),
		)
	)
		calls++;
	if (
		[
			"function_call_output",
			"custom_tool_call_output",
			"computer_call_output",
		].includes(String(row.type))
	)
		results++;
	const parts = Array.isArray(row.parts)
		? row.parts
		: Array.isArray(row.content)
			? row.content
			: [];
	for (const value of parts) {
		const part = object(value);
		if (
			part?.functionCall ||
			part?.toolUse ||
			["toolCall", "tool_use"].includes(String(part?.type))
		)
			calls++;
		if (
			part?.functionResponse ||
			part?.toolResult ||
			part?.type === "tool_result"
		)
			results++;
	}
	return calls - results;
}

/**
 * Search only removable whole text-user rows. Session identity decides which
 * rows may disappear; printed tags bind kept users without comparing their text.
 * The existing provider comparator is the final authority on every kept row.
 */
export function piWithoutForeignRows(
	payload: unknown,
	evidence: PiForeignEvidence | undefined,
	countRows: (payload: unknown) => number | undefined,
	matches: (payload: unknown) => readonly PiDispatchAlignedRow[] | undefined,
	normalizedCountHint?: number,
): PiForeignRows {
	const empty: PiForeignRows = {
		count: 0,
		chars: 0,
		positions: [],
		before: [],
	};
	try {
		const view = conversation(payload);
		if (!view || !evidence) return { ...empty, reason: "unreadable-branch" };
		const expectedTags = piForeignPreparedTags(evidence);
		const needed = new Map<string, number>();
		for (const tag of expectedTags) needed.set(tag, (needed.get(tag) ?? 0) + 1);
		const present = new Map<string, number>();
		const preparedTexts = new Map<string, number>();
		for (const source of evidence.untagged ?? [])
			for (const text of new Set(piForeignExpectedTexts(evidence, source)))
				preparedTexts.set(text, (preparedTexts.get(text) ?? 0) + 1);
		const seenControls = new Map<string, number>();
		const duplicateControls: { text: string; row: Record<string, unknown> }[] =
			[];
		const wire: PiForeignWireRow[] = [];
		const possible: {
			index: number;
			text: string;
			row: Record<string, unknown>;
			paired: boolean;
		}[] = [];
		let pending = 0;
		let paired = false;
		let lastUser = -1;
		for (const [index, value] of view.rows.entries()) {
			const row = object(value);
			if (!row) return { ...empty, reason: "prepared-row" };
			if (row.role === "user") lastUser = index;
			const tag =
				row.role === "user"
					? piForeignTag(view.google ? row.parts : row.content)
					: undefined;
			if (tag) present.set(tag, (present.get(tag) ?? 0) + 1);
			// A prepared tag is an ordered anchor, never a deletion candidate. Do
			// not read its full body just to decide which rows might be foreign.
			const text =
				tag && needed.has(tag)
					? undefined
					: wireText(
							row,
							view.google,
							view.body.inferenceConfig !== undefined,
							view.field === "input",
						);
			wire.push({ index, value, text, tag, paired: pending > 0 });
			const control =
				text === undefined ? undefined : piForeignWireIdentity(text);
			if (
				text !== undefined &&
				control !== undefined &&
				preparedTexts.has(control)
			) {
				const seen = (seenControls.get(control) ?? 0) + 1;
				seenControls.set(control, seen);
				if (seen > (preparedTexts.get(control) ?? 0))
					duplicateControls.push({ text, row });
			}
			if (!tag || !needed.has(tag)) {
				if (
					text !== undefined &&
					!piDateReminderText(text) &&
					text !== "Continue." &&
					!preparedTexts.has(control ?? "")
				) {
					if (pending > 0) paired = true;
					else possible.push({ index, text, row, paired: false });
				}
			}
			pending = Math.max(0, pending + toolDelta(row));
		}
		const tagsPresent = [...needed].every(
			([tag, count]) => present.get(tag) === count,
		);
		const limit = piPreparedDispatchRowLimit(evidence.prepared);
		// Ignore recognized control text conservatively for this count only. The
		// original comparator still validates its exact role and legal position.
		const withinSurplusBound =
			limit !== undefined &&
			normalizedCountHint !== undefined &&
			Number.isSafeInteger(normalizedCountHint) &&
			normalizedCountHint >= 0 &&
			normalizedCountHint - limit <= PI_FOREIGN_MAX_ROWS;
		const counted = withinSurplusBound
			? normalizedCountHint
			: countRows(
					view.withRows(
						view.rows.filter((value) => {
							const row = object(value);
							const text = piForeignFirstText(
								view.google ? row?.parts : row?.content,
							);
							return text !== "Continue." && !piDateReminderText(text);
						}),
					),
				);
		if (
			limit !== undefined &&
			counted !== undefined &&
			counted - limit > PI_FOREIGN_MAX_ROWS
		)
			return {
				...empty,
				count: possible.length,
				chars: possible.reduce((sum, row) => sum + row.text.length, 0),
				reason: "limit",
			};
		if (!possible.length && duplicateControls.length) {
			// Excluded anchors never enter the search. Preserve the more specific
			// refusal when an extra copy is also known session content.
			if (!piMaterializeForeignEvidence(evidence))
				return { ...empty, reason: "unreadable-branch" };
			return {
				...empty,
				reason: duplicateControls.some(
					({ text, row }) =>
						text.length <= PI_FOREIGN_MAX_CHARS &&
						piForeignSessionContent(evidence, text, row),
				)
					? "session-content"
					: "prepared-row",
			};
		}
		if (!possible.length)
			return {
				...empty,
				reason: tagsPresent
					? paired
						? "tool-pair"
						: "not-text-user"
					: "prepared-row",
			};
		if (!piMaterializeForeignEvidence(evidence))
			return { ...empty, reason: "unreadable-branch" };
		let session = false;
		let oversized = false;
		const candidates = possible.filter((row) => {
			if (row.text.length > PI_FOREIGN_MAX_CHARS) {
				oversized = true;
				return false;
			}
			if (piForeignSessionContent(evidence, row.text, row.row)) {
				session = true;
				return false;
			}
			return true;
		});
		if (!tagsPresent)
			return { ...empty, reason: session ? "session-content" : "prepared-row" };
		let accepted: PiForeignRows | undefined;
		let gapFailure: PiForeignRows | undefined;
		let attempts = 0;
		for (const selected of piForeignDeletionSets(
			candidates,
			lastUser,
			PI_FOREIGN_MAX_ROWS,
		)) {
			if (attempts++ === PI_FOREIGN_MAX_SEARCH_RUNS)
				return {
					...empty,
					count: candidates.length,
					chars: candidates.reduce((sum, row) => sum + row.text.length, 0),
					reason: "search-limit",
				};
			if (
				selected.reduce((sum, row) => sum + row.text.length, 0) >
				PI_FOREIGN_MAX_CHARS
			) {
				oversized = true;
				continue;
			}
			const positions = selected.map((row) => row.index).sort((a, b) => a - b);
			const removed = new Set(positions);
			const filtered = view.withRows(
				view.rows.filter((_, index) => !removed.has(index)),
			);
			const alignment = matches(filtered);
			if (!alignment) continue;
			const gaps = piForeignAlignment(wire, removed, alignment, evidence, {
				rows: PI_FOREIGN_MAX_ROWS,
				chars: PI_FOREIGN_MAX_CHARS,
			});
			if (gaps.reason) {
				gapFailure = { ...empty, ...gaps };
				continue;
			}
			const before = positions.map((position) =>
				countRows(
					view.withRows(
						view.rows
							.slice(0, position)
							.filter((_, index) => !removed.has(index)),
					),
				),
			);
			if (before.some((value) => value === undefined)) continue;
			accepted = {
				payload: filtered,
				count: gaps.count,
				chars: gaps.chars,
				positions,
				before: before as number[],
			};
			return accepted;
		}
		if (attempts >= PI_FOREIGN_MAX_SEARCH_RUNS)
			return {
				...empty,
				count: candidates.length,
				chars: candidates.reduce((sum, row) => sum + row.text.length, 0),
				reason: "search-limit",
			};
		return (
			gapFailure ?? {
				...empty,
				count: candidates.length,
				chars: candidates.reduce((sum, row) => sum + row.text.length, 0),
				reason: session
					? "session-content"
					: paired
						? "tool-pair"
						: oversized || candidates.length > PI_FOREIGN_MAX_ROWS
							? "limit"
							: "prepared-row",
			}
		);
	} catch {
		return { ...empty, reason: "prepared-row" };
	}
}
