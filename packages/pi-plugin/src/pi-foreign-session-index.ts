import { createHash } from "node:crypto";
import { stableStringify } from "@magic-context/core/shared/stable-json";
import {
	PI_HISTORY_ORIGIN,
	piIsDeveloperHistory,
} from "./pi-dispatch-agent-history";
import { piDateReminderText } from "./pi-dispatch-date-reminder";
import {
	type PiPreparedStructure,
	piPreparedUserSources,
} from "./pi-dispatch-structure";
import {
	piOmpRenderedContent,
	piOmpRenderedTexts,
	piOmpSessionTexts,
} from "./pi-foreign-native-text";
import { PI_FOREIGN_NON_TEXT_ENTRY_TYPES } from "./pi-foreign-omp-kinds";
import {
	piForeignRevision,
	piSameForeignRevision,
} from "./pi-foreign-revision";

export const piForeignRecord = (
	value: unknown,
): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
const STEERING_NOTICE =
	"<system-notice>\nUser interjection during work: priority; supersedes conflicting prior instructions. Re-read; ensure current work reflects user intent.\n</system-notice>\n";

export function piForeignUnwrap(text: string): string {
	const prefix =
		/^(<system-reminder>\nToday: [^\n]+\n<\/system-reminder>)\n{0,2}/u.exec(
			text,
		);
	if (prefix && piDateReminderText(prefix[1]))
		text = text.slice(prefix[0].length);
	if (text.startsWith(STEERING_NOTICE))
		text = text.slice(STEERING_NOTICE.length);
	return text;
}

function canonical(text: string): string {
	return (
		piForeignUnwrap(text)
			.replace(/^(?:§\d+§ ?)+/u, "")
			// Unicode mode leaves valid surrogate pairs intact and replaces lone
			// code units exactly as the provider's String.toWellFormed() does.
			.replace(/[\uD800-\uDFFF]/gu, "\ufffd")
	);
}

export function piForeignFirstText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const part of content) {
		const block = piForeignRecord(part);
		if (
			block &&
			typeof block.text === "string" &&
			(block.type === undefined ||
				["text", "input_text", "output_text"].includes(String(block.type)))
		) {
			if (piDateReminderText(block.text)) continue;
			return block.text;
		}
	}
	return undefined;
}

export function piForeignTag(content: unknown): string | undefined {
	const text = piForeignFirstText(content);
	return text === undefined
		? undefined
		: /^§\d+§/u.exec(piForeignUnwrap(text))?.[0];
}

interface PiForeignRendering {
	role: unknown;
	fastText?: string;
	revision: readonly unknown[];
	texts: readonly string[];
	hashes?: readonly string[];
}

export interface PiForeignSessionIndex {
	entries: Map<
		string,
		{
			entry: unknown;
			body: unknown;
			rendering?: PiForeignRendering;
			pass: number;
		}
	>;
	seen: WeakMap<object, PiForeignRendering>;
	expectedTexts: WeakMap<
		object,
		{ rendering: PiForeignRendering; texts: readonly string[] }
	>;
	taggedSources: WeakMap<
		object,
		{ text: string | undefined; tag: string | undefined }
	>;
	sessionFingerprints: Set<string>;
	/** Only current entry renderings retain text keys; old versions retain digests only. */
	currentTexts: Map<string, { hash: string; references: number }>;
	ids: Set<string>;
	pass: number;
	stats: {
		hashes: number;
		renders: number;
		comparisons: number;
		wireHashes: number;
		entries: number;
		reads: number;
	};
}
export function createPiForeignSessionIndex(): PiForeignSessionIndex {
	return {
		entries: new Map(),
		seen: new WeakMap(),
		expectedTexts: new WeakMap(),
		taggedSources: new WeakMap(),
		sessionFingerprints: new Set(),
		currentTexts: new Map(),
		ids: new Set(),
		pass: 0,
		stats: {
			hashes: 0,
			renders: 0,
			comparisons: 0,
			wireHashes: 0,
			entries: 0,
			reads: 0,
		},
	};
}

export interface PiForeignEvidence {
	source: unknown;
	input: readonly unknown[];
	messages?: readonly unknown[];
	prepared?: PiPreparedStructure;
	index: PiForeignSessionIndex;
	tags?: readonly string[];
	untagged?: readonly unknown[];
	preparedTexts?: Set<string>;
	wireFingerprints?: Map<string, string>;
}

/** Capture references only: an ordinary matching dispatch never reads or hashes the session. */
export function piForeignEvidence(
	source: unknown,
	input: readonly unknown[],
	index = createPiForeignSessionIndex(),
): PiForeignEvidence {
	return { source, input, index };
}

export function piProtectPreparedRows(
	evidence: PiForeignEvidence,
	messages: readonly unknown[],
	prepared?: PiPreparedStructure,
): void {
	evidence.messages = messages;
	evidence.prepared = prepared;
}

function texts(
	index: PiForeignSessionIndex,
	value: unknown,
	roleOverride?: string,
	trackEntry = false,
): PiForeignRendering {
	const source = piForeignRecord(value);
	if (!source) throw new Error("unreadable session message");
	try {
		const role = roleOverride ?? source.role;
		const content = source.content;
		const fastText =
			(role === "user" || role === "developer") && typeof content === "string"
				? content
				: undefined;
		const prior = index.seen.get(source);
		// Entry identity is insufficient: native shake/prune replaces fields in
		// place. Recompare their values before reusing a rendering or its hashes.
		if (prior) {
			index.stats.comparisons++;
			if (prior.role === role && fastText !== undefined) {
				index.stats.comparisons++;
				if (prior.fastText === fastText) return prior;
			}
		}
		const revision = piForeignRevision(source, role);
		if (prior && piSameForeignRevision(prior.revision, revision, index.stats))
			return prior;
		const rendered = roleOverride ? { ...source, role: roleOverride } : source;
		if (trackEntry) index.stats.renders++;
		const result = {
			role,
			fastText,
			revision,
			texts: [...new Set(piOmpSessionTexts(rendered).map(canonical))],
		};
		index.seen.set(source, result);
		index.expectedTexts.delete(source);
		index.taggedSources.delete(source);
		return result;
	} catch (error) {
		index.seen.delete(source);
		index.expectedTexts.delete(source);
		index.taggedSources.delete(source);
		throw error;
	}
}

export function piForeignPreparedTags(
	evidence: PiForeignEvidence,
): readonly string[] {
	if (evidence.tags) return evidence.tags;
	const tags: string[] = [];
	const untagged: unknown[] = [];
	const sources = evidence.prepared
		? piPreparedUserSources(evidence.prepared)
		: (evidence.messages ?? []);
	for (const message of sources) {
		const row = piForeignRecord(message);
		const text = piForeignFirstText(row?.content);
		const cached = row && evidence.index.taggedSources.get(row);
		const tag =
			cached && cached.text === text ? cached.tag : piForeignTag(text);
		if (row && (!cached || cached.text !== text))
			evidence.index.taggedSources.set(row, { text, tag });
		if (tag) tags.push(tag);
		else untagged.push(message);
	}
	evidence.tags = tags;
	evidence.untagged = untagged;
	return tags;
}

function fingerprint(
	text: string,
	index: PiForeignSessionIndex,
	wire = false,
): string {
	if (wire) index.stats.wireHashes++;
	else index.stats.hashes++;
	return createHash("sha256")
		.update(stableStringify([{ type: "text", text }]))
		.digest("hex");
}

function protectSession(
	index: PiForeignSessionIndex,
	message: unknown,
	roleOverride?: string,
	trackEntry = false,
): PiForeignRendering {
	const rendering = texts(index, message, roleOverride, trackEntry);
	if (!rendering.hashes) {
		rendering.hashes = rendering.texts.map((text) => {
			const current = index.currentTexts.get(text);
			if (current) return current.hash;
			return fingerprint(text, index);
		});
		for (const hash of rendering.hashes) index.sessionFingerprints.add(hash);
	}
	return rendering;
}

function releaseRendering(
	index: PiForeignSessionIndex,
	rendering: PiForeignRendering | undefined,
): void {
	for (const text of rendering?.texts ?? []) {
		const current = index.currentTexts.get(text);
		if (!current) continue;
		if (--current.references === 0) index.currentTexts.delete(text);
	}
}

function retainRendering(
	index: PiForeignSessionIndex,
	rendering: PiForeignRendering | undefined,
): void {
	if (!rendering) return;
	const hashes = rendering.hashes;
	if (!hashes) throw new Error("unhashed session rendering");
	for (const [at, text] of rendering.texts.entries()) {
		const current = index.currentTexts.get(text);
		if (current) current.references++;
		else index.currentTexts.set(text, { hash: hashes[at], references: 1 });
	}
}

function forgetSource(index: PiForeignSessionIndex, source: unknown): void {
	if (!source || typeof source !== "object") return;
	index.seen.delete(source);
	index.expectedTexts.delete(source);
	index.taggedSources.delete(source);
}

/**
 * getEntries is the host's complete session tree, not getBranch's current path.
 * A successful empty/metadata-only result proves that the referenced handler
 * input is the only message source. By dispatch it contains processed messages:
 * the handler commits its output into that array, including a pending first prompt.
 * A failed accessor never substitutes an assumed branch.
 * Oh My Pi also edits entries in place during shake/prune/image removal. Memoize
 * model-visible revisions, not entry identity. Superseded text leaves the current
 * rendering cache; only fingerprints survive. Earlier renderings are protected
 * from the first time this index is built in a process, for that process's life.
 * A restart or an edit before first indexing protects only the current rendering;
 * observing every earlier state would require indexing history on matching
 * passes, which this code avoids.
 */
export function piMaterializeForeignEvidence(
	evidence: PiForeignEvidence,
): boolean {
	try {
		const { index } = evidence;
		index.stats.reads++;
		index.pass++;
		evidence.wireFingerprints = undefined;
		const source = piForeignRecord(evidence.source);
		const entries = Array.isArray(evidence.source)
			? evidence.source
			: typeof source?.getEntries === "function"
				? source.getEntries.call(evidence.source)
				: undefined;
		if (!Array.isArray(entries)) return false;
		for (const value of entries) {
			const entry = piForeignRecord(value);
			if (!entry || typeof entry.id !== "string") return false;
			const body = entry.type === "message" ? entry.message : value;
			const prior = index.entries.get(entry.id);
			if (prior?.pass === index.pass) return false;
			let message: unknown;
			let role: string | undefined;
			if (entry.type === "message") message = entry.message ?? null;
			else if (entry.type === "custom_message") {
				message = entry;
				role = "custom";
			} else if (entry.type === "branch_summary") {
				message = entry;
				role = "branchSummary";
			} else if (entry.type === "compaction") {
				message = entry;
				role = "compactionSummary";
			} else if (
				!PI_FOREIGN_NON_TEXT_ENTRY_TYPES.some((type) => type === entry.type)
			)
				return false;
			let rendering: PiForeignRendering | undefined;
			try {
				if (message !== undefined)
					rendering = protectSession(index, message, role, true);
			} catch (error) {
				releaseRendering(index, prior?.rendering);
				forgetSource(index, prior?.body);
				index.entries.delete(entry.id);
				throw error;
			}
			if (
				prior &&
				prior.entry === value &&
				prior.body === body &&
				prior.rendering === rendering
			) {
				prior.pass = index.pass;
				continue;
			}
			if (prior?.rendering !== rendering) {
				releaseRendering(index, prior?.rendering);
				retainRendering(index, rendering);
			}
			if (prior && prior.body !== body) forgetSource(index, prior.body);
			index.ids.add(entry.id);
			index.entries.set(entry.id, {
				entry: value,
				body,
				rendering,
				pass: index.pass,
			});
			index.stats.entries++;
		}
		if (index.entries.size > entries.length)
			for (const [id, prior] of index.entries)
				if (prior.pass !== index.pass) {
					releaseRendering(index, prior.rendering);
					forgetSource(index, prior.body);
					index.entries.delete(id);
				}
		for (const message of evidence.input) protectSession(index, message);
		piForeignPreparedTags(evidence);
		evidence.preparedTexts = new Set();
		for (const message of evidence.untagged ?? [])
			for (const text of texts(index, message).texts)
				evidence.preparedTexts.add(text);
		return true;
	} catch {
		return false;
	}
}

export function piForeignSessionContent(
	evidence: PiForeignEvidence,
	text: string,
	row: Record<string, unknown>,
): boolean {
	if (
		["id", "messageId", "entryId"].some(
			(key) =>
				typeof row[key] === "string" &&
				evidence.index.ids.has(row[key] as string),
		)
	)
		return true;
	const key = canonical(text);
	let hash =
		evidence.index.currentTexts.get(key)?.hash ??
		evidence.wireFingerprints?.get(key);
	if (!hash) {
		// Old renderings retain only fingerprints. Hash a bounded candidate once
		// per dispatch to compare it with those historical identities.
		hash = fingerprint(key, evidence.index, true);
		evidence.wireFingerprints ??= new Map();
		evidence.wireFingerprints.set(key, hash);
	}
	return evidence.index.sessionFingerprints.has(hash);
}

export function piForeignPreparedContent(
	evidence: PiForeignEvidence,
	text: string,
): boolean {
	return evidence.preparedTexts?.has(canonical(text)) ?? false;
}

/** Whole-row text variants bind a prepared slot; individual fragments never do. */
export function piForeignExpectedTexts(
	evidence: PiForeignEvidence,
	source: unknown,
): readonly string[] {
	const row = piForeignRecord(source);
	if (!row) return [];
	const origin = Reflect.get(row, PI_HISTORY_ORIGIN) ?? row;
	const rendering = texts(evidence.index, origin);
	const prior = evidence.index.expectedTexts.get(row);
	if (prior?.rendering === rendering) return prior.texts;
	const values = piOmpRenderedTexts(origin).map(piForeignWireIdentity);
	evidence.index.expectedTexts.set(row, { rendering, texts: values });
	return values;
}

export function piForeignWireIdentity(text: string): string {
	return piForeignUnwrap(text).replace(/[\uD800-\uDFFF]/gu, "\ufffd");
}

/** A wire image/reasoning row cannot be assigned to a prepared text-only slot. */
export function piForeignExpectedTextOnly(
	source: unknown,
	wireRole?: unknown,
): boolean {
	const row = piForeignRecord(source);
	if (!row) return true;
	// Normalized user slots can originate in developer history. Preserve their
	// real higher-priority wire role without allowing an image to borrow a text slot.
	if (
		(wireRole === "developer" || wireRole === "system") &&
		piIsDeveloperHistory(row)
	)
		return false;
	const content = piOmpRenderedContent(
		Reflect.get(row, PI_HISTORY_ORIGIN) ?? row,
	);
	return (
		typeof content === "string" ||
		(Array.isArray(content) &&
			content.every(
				(part) =>
					piForeignRecord(part)?.type === "text" &&
					typeof piForeignRecord(part)?.text === "string",
			))
	);
}

/** Instrument actual SHA calls and entry reads, rather than inferring laziness from timing. */
export function piForeignEvidenceStats(
	evidence: PiForeignEvidence,
): Readonly<PiForeignSessionIndex["stats"]> {
	return evidence.index.stats;
}
