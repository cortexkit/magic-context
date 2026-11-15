import { createHash } from "node:crypto";
import { getSlot } from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	getPiLastServedArray,
	getPiLastServedDigest,
} from "./served-array-ledger";

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function contentParts(
	message: Record<string, unknown>,
): Record<string, unknown>[] {
	return Array.isArray(message.content)
		? message.content.flatMap((part) => {
				const p = record(part);
				return p ? [p] : [];
			})
		: [];
}

/** Prose edits do not change a tool call's owner; repeated call ids alone are not unique. */
export function piAssistantToolIdentity(message: unknown): string | undefined {
	const m = record(message);
	if (
		m?.role !== "assistant" ||
		typeof m.timestamp !== "number" ||
		!Number.isFinite(m.timestamp)
	)
		return;
	const ids = contentParts(m)
		.filter((p) => p.type === "toolCall")
		.map((p) => p.id);
	if (!ids.length || ids.some((id) => typeof id !== "string" || !id)) return;
	return JSON.stringify([m.timestamp, ids]);
}

const LEADING_TAG = /^§(\d+)§/;
const LEADING_SENTINEL = /^\[(?:dropped|truncated) §(\d+)§\]/;
const DROPPED_INPUT_VALUE = /^\[dropped §(\d+)§\]$/;

/**
 * Tag numbers that the served array shows in a position where Magic Context
 * renders a tag: the start of a text part (or of string content), a leading
 * `[dropped §N§]` / `[truncated §N§]` placeholder, or a tool call whose
 * arguments were replaced by the dropped-input placeholder.
 *
 * Magic Context writes tags only there, and `prependTag` strips any existing
 * leading tag notation before writing its own, so a number found there is the
 * number decorating that part. A `§N§` anywhere else is text a tool or the
 * model wrote, such as the `Queued: drop §8§.` receipt ctx_reduce returns or a
 * reply quoting an old tag. That text says nothing about which number this
 * call or message carries, so it must not veto a survivor the tag positions
 * prove.
 */
export function piRenderedTagNumbers(
	messages: readonly Record<string, unknown>[],
): Set<number> {
	const numbers = new Set<number>();
	const readText = (text: unknown) => {
		if (typeof text !== "string") return;
		const match = LEADING_TAG.exec(text) ?? LEADING_SENTINEL.exec(text);
		if (match) numbers.add(Number(match[1]));
	};
	for (const message of messages) {
		if (typeof message.content === "string") {
			readText(message.content);
			continue;
		}
		for (const part of contentParts(message)) {
			if (part.type === "text") readText(part.text);
			else if (part.type === "toolCall") {
				// Only the dropped-input placeholder itself counts: arguments that are
				// exactly `{ dropped: "[dropped §N§]" }` (droppedInputMarker). The
				// same text inside ordinary arguments is something the model wrote.
				const args = record(part.arguments);
				const keys = args ? Object.keys(args) : [];
				const value = keys.length === 1 ? args?.dropped : undefined;
				const match =
					typeof value === "string" ? DROPPED_INPUT_VALUE.exec(value) : null;
				if (match) numbers.add(Number(match[1]));
			}
		}
	}
	return numbers;
}

/**
 * A saved last-known-good (LKG) array may have been captured but never returned
 * to Pi. Its digest must match the last returned array before its bytes can
 * authorize removing a duplicate tag. A candidate number rendered as a tag
 * anywhere else vetoes the proof; a number quoted inside text does not (see
 * piRenderedTagNumbers).
 */
export function piCachedToolSurvivor(
	sessionId: string,
	callId: string,
	timestamp: number,
	rows: readonly { tagNumber: number; status: string }[],
	view?: PiServedCachedView | null,
): number | undefined {
	const cached =
		view === undefined ? createPiServedCachedView(sessionId) : view;
	if (!cached) return;
	const owners = cached.toolCallOwners().get(callId) ?? [];
	const owner = owners[0];
	if (
		!owner ||
		owners.length !== 1 ||
		owner.timestamp !== timestamp ||
		contentParts(owner).filter((p) => p.type === "toolCall" && p.id === callId)
			.length !== 1
	)
		return;
	const rendered = cached.rendered();
	const present = rows.filter((row) => rendered.has(row.tagNumber));
	const winner = present[0];
	if (present.length !== 1 || !winner) return;
	const { tagNumber: number, status } = winner;
	if (status !== "active" && status !== "dropped") return;
	const results = cached.toolResults().get(callId) ?? [];
	if (
		!results.some((m) =>
			contentParts(m).some(
				(p) =>
					p.type === "text" &&
					(status === "dropped"
						? p.text === `[dropped §${number}§]`
						: typeof p.text === "string" && p.text.startsWith(`§${number}§ `)),
			),
		)
	)
		return;
	return number;
}

/**
 * The last returned array, parsed once, with lookups built on first use.
 * Fallback adoption asks about thousands of duplicated identities in one pass;
 * reading, hashing and parsing the whole array again for each of them made a
 * large session's pass take minutes. One view answers every question of one
 * adoption pass.
 */
export interface PiServedCachedView {
	messages: Record<string, unknown>[];
	/** piRenderedTagNumbers of the whole array. */
	rendered(): Set<number>;
	/** Assistant messages by the id of each tool call they carry, in array order. */
	toolCallOwners(): Map<string, Record<string, unknown>[]>;
	/** Tool-result messages by tool call id, in array order. */
	toolResults(): Map<string, Record<string, unknown>[]>;
	/** Lookups other identity modules derive from `messages`, built once per view. */
	memo<T>(key: string, build: () => T): T;
}

/** A view of the last returned array, or null when there is no trustworthy one. */
export function createPiServedCachedView(
	sessionId: string,
): PiServedCachedView | null {
	const cached = readPiServedCachedArray(sessionId);
	if (!cached) return null;
	const { messages } = cached;
	const memos = new Map<string, unknown>();
	const memo = <T>(key: string, build: () => T): T => {
		if (!memos.has(key)) memos.set(key, build());
		return memos.get(key) as T;
	};
	return {
		messages,
		rendered: () => memo("rendered", () => piRenderedTagNumbers(messages)),
		toolCallOwners: () =>
			memo("toolCallOwners", () => {
				const owners = new Map<string, Record<string, unknown>[]>();
				for (const message of messages) {
					if (message.role !== "assistant") continue;
					const ids = new Set<unknown>();
					for (const part of contentParts(message))
						if (part.type === "toolCall") ids.add(part.id);
					for (const id of ids) {
						if (typeof id !== "string") continue;
						const list = owners.get(id);
						if (list) list.push(message);
						else owners.set(id, [message]);
					}
				}
				return owners;
			}),
		toolResults: () =>
			memo("toolResults", () => {
				const results = new Map<string, Record<string, unknown>[]>();
				for (const message of messages) {
					if (
						message.role !== "toolResult" ||
						typeof message.toolCallId !== "string"
					)
						continue;
					const list = results.get(message.toolCallId);
					if (list) list.push(message);
					else results.set(message.toolCallId, [message]);
				}
				return results;
			}),
		memo,
	};
}

export function readPiServedCachedArray(
	sessionId: string,
): { jsonPrefix: string; messages: Record<string, unknown>[] } | undefined {
	// A reshaped input can invalidate last-known-good (LKG) replay without
	// discarding the exact array returned to Pi. After process restart, accept a
	// saved LKG only when its digest matches the last returned-array record.
	const memory = getPiLastServedArray(sessionId);
	const slot = memory === undefined ? getSlot(sessionId) : undefined;
	const jsonPrefix = memory ?? slot?.jsonPrefix;
	if (
		jsonPrefix === undefined ||
		createHash("sha256").update(jsonPrefix).digest("hex") !==
			getPiLastServedDigest(sessionId)
	)
		return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonPrefix);
	} catch {
		return;
	}
	if (!Array.isArray(parsed)) return;
	const messages = parsed.flatMap((m) => {
		const r = record(m);
		return r ? [r] : [];
	});
	return { jsonPrefix, messages };
}
