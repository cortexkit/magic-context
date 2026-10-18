import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { log } from "@magic-context/core/shared/logger";
import {
	ensureStorageDirectorySync,
	writeStorageFileSync,
} from "@magic-context/core/shared/storage-permissions";
import { PiContextSupersededError } from "./pi-context-budget";
import type { PiLkgSerializedOutput } from "./pi-lkg";
import {
	PiServedEnvelopeUnavailable,
	readPiCommittedServedNumbers,
} from "./pi-served-identities";

export const PI_SERVED_ARRAY_TAIL_MESSAGES = 40;
export const PI_SERVED_ARRAY_BODY_CAPTURE_ENV =
	"MAGIC_CONTEXT_PI_SERVED_BODY_CAPTURE";
const LEDGER_DIRECTORY = "pi-served-array-digests";
const BODY_DIRECTORY = "pi-served-array-bodies";
const IDENTITY_DIRECTORY = "pi-served-tag-numbers";
const FLUSH_DELAY_MS = 25;

type JsonMessage = Record<string, unknown>;

export class PiServedIdentityError extends Error {
	constructor(cause: unknown) {
		super("Pi served-number identity could not be persisted or restored", {
			cause,
		});
		this.name = "PiServedIdentityError";
	}
}

export interface PiServedArrayDigestRecord {
	version: 1;
	session_id: string;
	pass_ts: string;
	sequence: number;
	message_count: number;
	sha256: string;
	previous_sha256: string | null;
	first_divergence_message_index: number | null;
	block_vector_start: number;
	block_vectors: string[];
}

interface PreviousPass {
	digest: string;
	serializedMessages: readonly string[];
}

interface IdentityFileStamp {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

function identityFileStamp(filePath: string): IdentityFileStamp | undefined {
	try {
		const { dev, ino, size, mtimeMs } = statSync(filePath);
		return { dev, ino, size, mtimeMs };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

function sameIdentityFile(
	a: IdentityFileStamp | undefined,
	b: IdentityFileStamp | undefined,
): boolean {
	return (
		a === b ||
		(a !== undefined &&
			b !== undefined &&
			a.dev === b.dev &&
			a.ino === b.ino &&
			a.size === b.size &&
			a.mtimeMs === b.mtimeMs)
	);
}

/**
 * Issue #723: the append-mode ledger flushes on Windows/Bun have been seen to
 * grow these files with a hole-padded NUL tail. Those bytes carry no record
 * content, so callers strip them before parsing and restore the file to its
 * written length; only genuinely unreadable records may fail closed.
 */
function splitNulTail(buffer: Buffer): {
	text: string;
	nulTailBytes: number;
	midFileNul: boolean;
} {
	let end = buffer.length;
	while (end > 0 && buffer[end - 1] === 0) end -= 1;
	let midFileNul = false;
	for (let index = 0; index < end; index += 1) {
		if (buffer[index] === 0) {
			midFileNul = true;
			break;
		}
	}
	return {
		text: buffer.toString("utf8", 0, end),
		nulTailBytes: buffer.length - end,
		midFileNul,
	};
}

function repairNulTailOnDisk(
	filePath: string,
	buffer: Buffer,
	nulTailBytes: number,
	label: string,
): void {
	if (!nulTailBytes) return;
	try {
		// Only trim while no peer appended between read and repair: rewriting a
		// stale length would drop a legitimately concurrent record.
		const stamp = identityFileStamp(filePath);
		if (stamp && stamp.size === buffer.length) {
			writeStorageFileSync(
				filePath,
				buffer.subarray(0, buffer.length - nulTailBytes),
			);
			log(
				`[magic-context][pi] repaired ${label} hole-padded NUL tail (${nulTailBytes} bytes) in ${path.basename(filePath)}`,
			);
			return;
		}
		log(
			`[magic-context][pi] skipped ${label} NUL tail repair in ${path.basename(filePath)}: file changed since read`,
		);
	} catch (error) {
		log(
			`[magic-context][pi] could not repair ${label} NUL tail: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

interface CaptureOptions {
	/** The saved request plus raw recovery messages assigns no new tag numbers; log bytes without consulting or publishing their identity tables. */
	recoveryWithoutTagState?: boolean;
	/** Managed identities are authoritative in SQLite; JSONL is a post-commit mirror. */
	db?: import("@magic-context/core/shared/sqlite").Database;
	/** Numbers assigned to identities represented by this managed result, not parsed from text. */
	servedTagNumbers?: Iterable<number>;
	assertCurrentPass?: () => void;
	storageDir?: string;
	now?: Date;
	fullBodyCapture?: boolean;
	/** Only the detached serialization captured from these messages in this pass. */
	serializedOutput?: PiLkgSerializedOutput;
}

const previousBySession = new Map<string, PreviousPass>();
const servedTagNumbersBySession = new Map<
	string,
	{ path: string; numbers: Set<number>; stamp: IdentityFileStamp | undefined }
>();
const sequenceBySession = new Map<string, number>();
const pendingLinesByPath = new Map<
	string,
	{ line: string; assertCurrentPass?: () => void }[]
>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let swallowedWriteCount = 0;
let lastWriteError: string | null = null;

/** Release transcript-sized state without discarding already queued ledger rows. */
export function clearPiServedArraySession(sessionId: string): void {
	previousBySession.delete(sessionId);
	servedTagNumbersBySession.delete(sessionId);
	sequenceBySession.delete(sessionId);
}

/** Assigned numbers in served records, including earlier process lifetimes. */
export function getPiServedTagNumbers(
	sessionId: string,
	storageDir = getMagicContextStorageDir(),
	db?: import("@magic-context/core/shared/sqlite").Database,
): ReadonlySet<number> {
	if (db) {
		const legacy = getPiServedTagNumbers(sessionId, storageDir);
		try {
			return new Set([
				...legacy,
				...readPiCommittedServedNumbers(db, sessionId),
			]);
		} catch (error) {
			// Unreadable optional SQLite evidence cannot erase valid legacy identities.
			if (error instanceof PiServedEnvelopeUnavailable) return legacy;
			throw error;
		}
	}
	const filePath = getPiServedTagNumbersPath(sessionId, storageDir);
	const stamp = identityFileStamp(filePath);
	const cached = servedTagNumbersBySession.get(sessionId);
	if (cached?.path === filePath && sameIdentityFile(cached.stamp, stamp))
		return cached.numbers;
	let text: string;
	try {
		const bytes = readFileSync(filePath);
		const sanitized = splitNulTail(bytes);
		if (sanitized.midFileNul) {
			// Zeros inside recorded content might not be padding; strict parsing
			// below decides whether the file is fit for identity adoption.
			text = bytes.toString("utf8");
		} else {
			text = sanitized.text;
			repairNulTailOnDisk(filePath, bytes, sanitized.nulTailBytes, "identity");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		text = "";
	}
	const numbers = new Set<number>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let row: {
			version?: unknown;
			session_id?: unknown;
			tag_numbers?: unknown;
		};
		try {
			row = JSON.parse(line) as typeof row;
		} catch (error) {
			// A torn write must surface as the envelope-unavailable class callers
			// already wrap the SQLite mirror with, never as a raw SyntaxError.
			throw new PiServedEnvelopeUnavailable(
				`Pi served-number ledger is unreadable (JSON parse error in ${path.basename(filePath)}); refusing identity adoption`,
				{ cause: error },
			);
		}
		if (
			row.version !== 1 ||
			row.session_id !== sessionId ||
			!Array.isArray(row.tag_numbers) ||
			!row.tag_numbers.every(
				(number) => Number.isSafeInteger(number) && number > 0,
			)
		) {
			throw new Error(
				"Invalid durable Pi served-number record; refusing identity adoption",
			);
		}
		for (const number of row.tag_numbers) numbers.add(number);
	}
	// Retain the pre-read stamp: a peer append during the read must invalidate the
	// next lookup rather than certify that the newly appended bytes were parsed.
	servedTagNumbersBySession.set(sessionId, { path: filePath, numbers, stamp });
	return numbers;
}

export function getPiLastServedDigest(
	sessionId: string,
	storageDir = getMagicContextStorageDir(),
): string | undefined {
	const previous = previousBySession.get(sessionId);
	if (previous) return previous.digest;
	try {
		const filePath = getPiServedArrayLedgerPath(sessionId, storageDir);
		const bytes = readFileSync(filePath);
		const sanitized = splitNulTail(bytes);
		if (!sanitized.midFileNul)
			repairNulTailOnDisk(filePath, bytes, sanitized.nulTailBytes, "digest");
		const lines = (sanitized.midFileNul ? bytes.toString("utf8") : sanitized.text)
			.trim()
			.split("\n");
		const last = JSON.parse(lines.at(-1) ?? "") as PiServedArrayDigestRecord;
		if (
			last.version === 1 &&
			last.session_id === sessionId &&
			/^[a-f0-9]{64}$/.test(last.sha256)
		)
			return last.sha256;
	} catch {
		// A missing or damaged returned-array digest cannot authorize deleting a
		// duplicate tag: it does not prove which numbered bytes Pi received.
	}
}

/** Keep returned bytes as identity evidence even when a changed input shape prevents replay. */
export function getPiLastServedArray(sessionId: string): string | undefined {
	const previous = previousBySession.get(sessionId);
	return previous ? `[${previous.serializedMessages.join(",")}]` : undefined;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeSessionFileStem(sessionId: string): string {
	const readable = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
	return `${readable || "session"}-${sha256(sessionId).slice(0, 12)}`;
}

export function getPiServedArrayLedgerPath(
	sessionId: string,
	storageDir = getMagicContextStorageDir(),
): string {
	return path.join(
		storageDir,
		LEDGER_DIRECTORY,
		`${safeSessionFileStem(sessionId)}.jsonl`,
	);
}

export function getPiServedArrayBodyPath(
	sessionId: string,
	storageDir = getMagicContextStorageDir(),
): string {
	return path.join(
		storageDir,
		BODY_DIRECTORY,
		`${safeSessionFileStem(sessionId)}.jsonl`,
	);
}

export function getPiServedTagNumbersPath(
	sessionId: string,
	storageDir = getMagicContextStorageDir(),
): string {
	return path.join(
		storageDir,
		IDENTITY_DIRECTORY,
		`${safeSessionFileStem(sessionId)}.jsonl`,
	);
}

function fullBodyCaptureEnabled(): boolean {
	const value = process.env[PI_SERVED_ARRAY_BODY_CAPTURE_ENV]
		?.trim()
		.toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function serializeMessage(message: unknown): string {
	return JSON.stringify(message) ?? "null";
}

function firstDivergence(
	previous: readonly string[],
	current: readonly string[],
): number {
	const sharedLength = Math.min(previous.length, current.length);
	for (let index = 0; index < sharedLength; index += 1) {
		if (previous[index] !== current[index]) return index;
	}
	return previous.length === current.length ? -1 : sharedLength;
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

function blockVector(message: unknown): string {
	if (!message || typeof message !== "object") return "unknown:message(0)";
	const record = message as JsonMessage;
	const role = typeof record.role === "string" ? record.role : "unknown";
	const content = record.content;
	if (typeof content === "string") {
		return `${role}:text(${Buffer.byteLength(content)})`;
	}
	if (!Array.isArray(content)) {
		return `${role}:none(0)`;
	}
	if (content.length === 0) return `${role}:empty(0)`;
	const blocks = content.map((block) => {
		const type =
			block && typeof block === "object" && "type" in block
				? String((block as { type?: unknown }).type ?? "unknown")
				: typeof block;
		return `${type}(${byteLength(block)})`;
	});
	return `${role}:${blocks.join(",")}`;
}

function recordWriteFailure(error: unknown): void {
	try {
		swallowedWriteCount += 1;
		lastWriteError = error instanceof Error ? error.message : String(error);
		log("[magic-context][pi] served-array digest ledger write failed", error);
	} catch {
		// Observability must never interfere with the provider request.
	}
}

function appendPendingLines(filePath: string, lines: string[]): void {
	try {
		ensureStorageDirectorySync(path.dirname(filePath));
		writeStorageFileSync(filePath, lines.join(""), {
			encoding: "utf8",
			flag: "a",
		});
	} catch (error) {
		recordWriteFailure(error);
	}
}

/** Flush queued records. Context passes only enqueue; filesystem work runs later. */
export function flushPiServedArrayLedger(): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (pendingLinesByPath.size === 0) return;
	const pending = [...pendingLinesByPath.entries()];
	pendingLinesByPath.clear();
	for (const [filePath, lines] of pending) {
		const admitted = lines
			.filter((item) => {
				try {
					item.assertCurrentPass?.();
					return true;
				} catch (error) {
					// A deferred capture can outlive its pass. Discard that capture quietly;
					// unexpected ownership failures still need a diagnostic.
					if (error instanceof PiContextSupersededError) return false;
					log(
						"[magic-context][pi] DISCARDED CONTEXT RESULT: queued served capture",
						error,
					);
					return false;
				}
			})
			.map((item) => item.line);
		if (admitted.length) appendPendingLines(filePath, admitted);
	}
}

function scheduleFlush(): void {
	if (flushTimer) return;
	flushTimer = inRootAsyncContext(() =>
		setTimeout(flushPiServedArrayLedger, FLUSH_DELAY_MS),
	);
	flushTimer.unref?.();
}

function enqueue(
	filePath: string,
	line: string,
	assertCurrentPass?: () => void,
): void {
	const pending = pendingLinesByPath.get(filePath);
	if (pending) pending.push({ line, assertCurrentPass });
	else pendingLinesByPath.set(filePath, [{ line, assertCurrentPass }]);
	scheduleFlush();
}

/**
 * Record the exact AgentMessage array returned to Pi for this provider pass.
 * Only a digest and the newest 40 shape vectors are retained by default; body
 * bytes are written separately only when MAGIC_CONTEXT_PI_SERVED_BODY_CAPTURE
 * is explicitly enabled.
 */
export function capturePiServedArray(
	sessionId: string,
	messages: readonly unknown[],
	options: CaptureOptions = {},
): PiServedArrayDigestRecord | undefined {
	options.assertCurrentPass?.();
	let identityPersistenceFailed = false;
	try {
		const serializedMessages =
			options.serializedOutput?.jsonMessages ?? messages.map(serializeMessage);
		const serializedArray =
			options.serializedOutput?.json ?? `[${serializedMessages.join(",")}]`;
		const digest = sha256(serializedArray);
		const storageDir = options.storageDir ?? getMagicContextStorageDir();
		identityPersistenceFailed = true;
		const previousNumbers = options.recoveryWithoutTagState
			? new Set<number>()
			: getPiServedTagNumbers(sessionId, storageDir);
		const managedNumbers = options.recoveryWithoutTagState
			? []
			: (options.servedTagNumbers ?? []);
		identityPersistenceFailed = false;
		const served = new Set(previousNumbers);
		if (options.db && !options.recoveryWithoutTagState) {
			identityPersistenceFailed = true;
			for (const number of readPiCommittedServedNumbers(options.db, sessionId))
				served.add(number);
			for (const number of managedNumbers) {
				if (!served.has(number))
					throw new PiServedIdentityError(
						new Error("Pi identities have no committed LKG"),
					);
			}
			identityPersistenceFailed = false;
		}
		for (const number of managedNumbers) {
			if (Number.isSafeInteger(number) && number > 0) served.add(number);
		}
		const previous = previousBySession.get(sessionId);
		const divergence = previous
			? firstDivergence(previous.serializedMessages, serializedMessages)
			: null;
		const sequence = (sequenceBySession.get(sessionId) ?? 0) + 1;
		const tailStart = Math.max(
			0,
			messages.length - PI_SERVED_ARRAY_TAIL_MESSAGES,
		);
		const record: PiServedArrayDigestRecord = {
			version: 1,
			session_id: sessionId,
			pass_ts: (options.now ?? new Date()).toISOString(),
			sequence,
			message_count: messages.length,
			sha256: digest,
			previous_sha256: previous?.digest ?? null,
			first_divergence_message_index: divergence,
			block_vector_start: tailStart,
			block_vectors: messages.slice(tailStart).map(blockVector),
		};
		options.assertCurrentPass?.();
		const newNumbers = [...served].filter(
			(number) => !previousNumbers.has(number),
		);
		const identityPath = getPiServedTagNumbersPath(sessionId, storageDir);
		if (newNumbers.length) {
			// Managed numbers have already committed with their LKG. Keep a cumulative
			// compatibility mirror, so older releases also honor these identities.
			identityPersistenceFailed = true;
			ensureStorageDirectorySync(path.dirname(identityPath));
			options.assertCurrentPass?.();
			writeStorageFileSync(
				identityPath,
				`${JSON.stringify({ version: 1, session_id: sessionId, tag_numbers: newNumbers })}\n`,
				{
					encoding: "utf8",
					flag: "a",
				},
			);
			identityPersistenceFailed = false;
		}
		options.assertCurrentPass?.();
		// A peer can append other numbers between our read and this mirror write.
		// Invalidate the parsed JSONL cache so the next reader reloads all of them.
		if (newNumbers.length) servedTagNumbersBySession.delete(sessionId);
		enqueue(
			getPiServedArrayLedgerPath(sessionId, storageDir),
			`${JSON.stringify(record)}\n`,
			options.assertCurrentPass,
		);
		if (options.fullBodyCapture ?? fullBodyCaptureEnabled()) {
			const bodyHeader = JSON.stringify({
				version: 1,
				session_id: sessionId,
				pass_ts: record.pass_ts,
				sequence,
				sha256: digest,
			});
			enqueue(
				getPiServedArrayBodyPath(sessionId, storageDir),
				`${bodyHeader.slice(0, -1)},"messages":${serializedArray}}\n`,
				options.assertCurrentPass,
			);
		}
		previousBySession.set(sessionId, { digest, serializedMessages });
		sequenceBySession.set(sessionId, sequence);
		return record;
	} catch (error) {
		options.assertCurrentPass?.();
		if (identityPersistenceFailed) throw new PiServedIdentityError(error);
		recordWriteFailure(error);
		return undefined;
	}
}

export const __test = {
	blockVector,
	firstDivergence,
	fullBodyCaptureEnabled,
	getDiagnostics: () => ({ swallowedWriteCount, lastWriteError }),
	reset(): void {
		flushPiServedArrayLedger();
		previousBySession.clear();
		servedTagNumbersBySession.clear();
		sequenceBySession.clear();
		pendingLinesByPath.clear();
		swallowedWriteCount = 0;
		lastWriteError = null;
	},
};

process.once("beforeExit", flushPiServedArrayLedger);

import { inRootAsyncContext } from "@magic-context/core/shared/sqlite";
