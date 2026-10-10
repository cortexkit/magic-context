import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { log } from "@magic-context/core/shared/logger";
import {
	ensureStorageDirectorySync,
	writeStorageFileSync,
} from "@magic-context/core/shared/storage-permissions";
import type { PiLkgSerializedOutput } from "./pi-lkg";

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

interface CaptureOptions {
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
	{ path: string; numbers: Set<number> }
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
): ReadonlySet<number> {
	const filePath = getPiServedTagNumbersPath(sessionId, storageDir);
	const cached = servedTagNumbersBySession.get(sessionId);
	if (cached?.path === filePath) return cached.numbers;
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		text = "";
	}
	const numbers = new Set<number>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const row = JSON.parse(line) as {
			version?: unknown;
			session_id?: unknown;
			tag_numbers?: unknown;
		};
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
	servedTagNumbersBySession.set(sessionId, { path: filePath, numbers });
	return numbers;
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
	flushTimer = setTimeout(flushPiServedArrayLedger, FLUSH_DELAY_MS);
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
		const previousNumbers = getPiServedTagNumbers(sessionId, storageDir);
		identityPersistenceFailed = false;
		const served = new Set(previousNumbers);
		for (const number of options.servedTagNumbers ?? []) {
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
			// Number identity is safety state, not optional telemetry. Persist it
			// before returning; an unload or crash must not authorize renumbering.
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
		servedTagNumbersBySession.set(sessionId, {
			path: identityPath,
			numbers: served,
		});
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
