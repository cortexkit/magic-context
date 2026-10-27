import { setImmediate as yieldImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { createFailClosedBlockingError } from "@magic-context/core/features/magic-context/fail-closed-block";
import { inRootAsyncContext } from "@magic-context/core/shared/sqlite";
import { createWorkerShutdown } from "@magic-context/core/shared/worker-shutdown";
import { decodePiHydrationOperation } from "./tag-snapshot-codec-pi";
import {
	createPiTagSnapshotCandidate,
	type PiFallbackTagRow,
	type PiSnapshotTag,
	type PiTagSnapshotCandidate,
} from "./tag-snapshot-pi";

export interface PiHydrationGeneration {
	revision: string;
	durable: number;
}

export interface PiHydrationRequest {
	path: string;
	sessionId: string;
	connectionEpoch: number;
	sessionEpoch: number;
	jobId: number;
	/** Internal fixture controls; production callers leave these unset. */
	test?: {
		openDelayMs?: number;
		pageDelayMs?: number;
		crash?: "before-end" | "after-end";
	};
}

export type PiHydrationStream = "tags" | "fallback";
export type PiHydrationMessage = {
	jobId: number;
	sessionId: string;
	connectionEpoch: number;
	sessionEpoch: number;
	sequence: number;
	generation: PiHydrationGeneration;
} & (
	| {
			type: "packet";
			stream: PiHydrationStream;
			bytes: ArrayBuffer;
			byteLength: number;
			rows: number;
	  }
	| { type: "end"; stream: PiHydrationStream; rows: number }
	| {
			type: "done";
			maxReadTransactionMs: number;
			packetCount: number;
			packetBytes: number;
	  }
	| {
			type: "failed";
			reason: string;
			code: "failed" | "stale" | "schema" | "open";
			persistedVersion?: number;
			supportedVersion?: number;
	  }
);

export type PiHydrationOperation =
	| { type: "row"; value: PiSnapshotTag | PiFallbackTagRow }
	| {
			type: "field";
			key: string;
			value: unknown;
			append: boolean;
			totalLength?: number;
	  }
	| { type: "row-end" };

export class PiTagHydrationError extends Error {
	constructor(
		message: string,
		readonly code:
			| "failed"
			| "stale"
			| "cancelled"
			| "schema"
			| "deadline" = "failed",
	) {
		super(`Pi tag hydration: ${message}`);
		this.name = "PiTagHydrationError";
	}
}

export interface PiHydrationTelemetry {
	maxReadTransactionMs: number;
	maxAssemblyMs: number;
	packetCount: number;
	packetBytes: number;
	jobMs: number;
}

/** One credited packet at a time; incomplete arrays never leave this consumer. */
export function createPiHydrationPacketConsumer(
	request: PiHydrationRequest,
	cached: readonly PiSnapshotTag[] = [],
	byteLimit?: number,
) {
	const assembly = createPiTagSnapshotCandidate(cached, byteLimit);
	let sequence = 0;
	let generation: PiHydrationGeneration | undefined;
	let busy = false;
	let rejected = false;
	let stream: PiHydrationStream = "tags";
	let tagsEnded = false;
	let fallbackEnded = false;
	let fragment: Record<string, unknown> | undefined;
	let fragmentBytes = 0;
	const byteOffsets = new Map<string, number>();
	let streamRows = 0;
	let maxAssemblyMs = 0;
	let done = false;
	const fail = (message: string): never => {
		rejected = true;
		throw new PiTagHydrationError(message);
	};
	return {
		async consume(
			message: PiHydrationMessage,
		): Promise<PiTagSnapshotCandidate | null> {
			if (busy || rejected || done)
				return fail("packet after completion or without credit");
			if (
				message.jobId !== request.jobId ||
				message.sessionId !== request.sessionId ||
				message.connectionEpoch !== request.connectionEpoch ||
				message.sessionEpoch !== request.sessionEpoch ||
				message.sequence !== sequence++
			)
				return fail("packet sequence or lifetime mismatch");
			if (message.type === "failed") {
				rejected = true;
				if (message.code === "open")
					throw createFailClosedBlockingError({
						kind: "storage_failure",
						cause: `Pi tag hydration: ${message.reason}`,
					});
				if (message.code === "schema")
					throw createFailClosedBlockingError(
						{
							kind: "schema_fence",
							persistedVersion: message.persistedVersion ?? 0,
							supportedVersion: message.supportedVersion ?? 0,
						},
						{ cause: new PiTagHydrationError(message.reason, "schema") },
					);
				throw new PiTagHydrationError(message.reason, message.code);
			}
			if (
				generation &&
				(generation.revision !== message.generation.revision ||
					generation.durable !== message.generation.durable)
			)
				return fail("packet generation mismatch");
			generation ??= message.generation;
			if (message.type === "done") {
				if (!tagsEnded || !fallbackEnded || fragment)
					return fail("completion before both streams ended");
				done = true;
				return assembly.finish();
			}
			if (message.stream !== stream || fallbackEnded)
				return fail("stream order mismatch");
			if (message.type === "end") {
				if (fragment || message.rows !== streamRows)
					return fail("incomplete row or stream count mismatch");
				assembly.end(stream);
				if (stream === "tags") {
					tagsEnded = true;
					stream = "fallback";
				} else fallbackEnded = true;
				streamRows = 0;
				return null;
			}
			if (
				!(message.bytes instanceof ArrayBuffer) ||
				message.bytes.byteLength > 65_536 ||
				message.byteLength <= 0 ||
				message.byteLength > message.bytes.byteLength ||
				message.rows > 256
			)
				return fail("packet exceeds credit limits");
			busy = true;
			let started = performance.now();
			let packetRows = 0;
			const append = (row: PiSnapshotTag | PiFallbackTagRow) => {
				if (stream === "tags") assembly.appendTag(row as PiSnapshotTag);
				else assembly.appendFallback(row as PiFallbackTagRow);
				streamRows++;
				packetRows++;
			};
			try {
				const bytes = new Uint8Array(message.bytes, 0, message.byteLength);
				const view = new DataView(message.bytes);
				for (let offset = 0; offset < bytes.length; ) {
					if (offset + 4 > bytes.length) return fail("truncated frame length");
					const length = view.getUint32(offset);
					offset += 4;
					if (length === 0 || offset + length > bytes.length)
						return fail("truncated frame");
					const operation = decodePiHydrationOperation(
						bytes.subarray(offset, offset + length),
					);
					offset += length;
					if (operation.type === "row") {
						if (fragment) return fail("whole row inside fragments");
						append(operation.value);
					} else if (operation.type === "field") {
						if (!fragment) fragmentBytes = 384;
						fragment ??= Object.create(null) as Record<string, unknown>;
						const value = operation.value;
						fragmentBytes +=
							typeof value === "string"
								? 24 + value.length * 2
								: value instanceof Uint8Array
									? value.length
									: 8;
						if (
							assembly.estimatedBytes + fragmentBytes >
							(byteLimit ?? 128 * 1024 * 1024)
						)
							return fail(
								"candidate memory limit exceeded during field assembly",
							);
						if (operation.append) {
							const prior = fragment[operation.key];
							if (
								typeof prior === "string" &&
								typeof operation.value === "string"
							)
								fragment[operation.key] = prior + operation.value;
							else if (
								prior instanceof Uint8Array &&
								operation.value instanceof Uint8Array
							) {
								const offset = byteOffsets.get(operation.key);
								if (
									offset === undefined ||
									offset + operation.value.length > prior.length
								)
									return fail("invalid binary field length");
								prior.set(operation.value, offset);
								byteOffsets.set(operation.key, offset + operation.value.length);
							} else return fail("invalid field fragment");
						} else if (value instanceof Uint8Array) {
							const length = operation.totalLength ?? value.length;
							if (
								length < value.length ||
								length > (byteLimit ?? 128 * 1024 * 1024)
							)
								return fail("binary field memory limit");
							const target = new Uint8Array(length);
							target.set(value);
							fragment[operation.key] = target;
							byteOffsets.set(operation.key, value.length);
						} else fragment[operation.key] = value;
					} else if (operation.type === "row-end") {
						if (!fragment) return fail("row end without fields");
						append(fragment as unknown as PiSnapshotTag);
						fragment = undefined;
						byteOffsets.clear();
					} else return fail("unknown frame");
					const elapsed = performance.now() - started;
					maxAssemblyMs = Math.max(maxAssemblyMs, elapsed);
					if (elapsed >= 4) {
						await yieldImmediate();
						started = performance.now();
					}
				}
				if (packetRows !== message.rows)
					return fail("packet row count mismatch");
				return null;
			} catch (error) {
				rejected = true;
				throw error;
			} finally {
				busy = false;
			}
		},
		get generation() {
			return generation;
		},
		get maxAssemblyMs() {
			return maxAssemblyMs;
		},
	};
}

/** Launch from source in Bun or beside emitted chunks in a packed package. */
export function startPiTagSnapshotWorker(
	request: PiHydrationRequest,
	options: {
		cached?: readonly PiSnapshotTag[];
		byteLimit?: number;
		deadlineMs?: number;
		entry?: URL;
		beforeAck?: (message: PiHydrationMessage) => Promise<void>;
	} = {},
) {
	const entry =
		options.entry ??
		new URL(
			import.meta.url.endsWith(".ts")
				? "./tag-snapshot-worker-pi.ts"
				: "./tag-snapshot-worker-pi.js",
			import.meta.url,
		);
	const started = performance.now();
	const consumer = createPiHydrationPacketConsumer(
		request,
		options.cached,
		options.byteLimit,
	);
	const worker = inRootAsyncContext(
		() => new Worker(entry, { workerData: request }),
	);
	// The worker reads a close request between pages, while it waits for a
	// packet's credit, and then exits at once. A page is one read transaction of
	// at most 256 rows; the connection's 50 ms busy timeout bounds only its lock
	// wait, not the query. A worker still in a page after this deadline is
	// terminated, as every cancelled job was before.
	const shutdown = createWorkerShutdown(worker, "pi-tag-snapshot", 1_000);
	let exited = false;
	let settled = false;
	let consumption = Promise.resolve();
	let complete:
		| {
				candidate: PiTagSnapshotCandidate;
				generation: PiHydrationGeneration;
				telemetry: PiHydrationTelemetry;
		  }
		| undefined;
	let rejectResult: (error: Error) => void;
	const released = new Promise<void>((resolve) =>
		worker.once("exit", () => {
			exited = true;
			resolve();
		}),
	);
	const result = new Promise<NonNullable<typeof complete>>(
		(resolve, reject) => {
			rejectResult = reject;
			const consumeMessage = async (message: PiHydrationMessage) => {
				if (settled) return;
				try {
					const candidate = await consumer.consume(message);
					if (candidate && message.type === "done") {
						complete = {
							candidate,
							generation: message.generation,
							telemetry: {
								maxReadTransactionMs: message.maxReadTransactionMs,
								maxAssemblyMs: consumer.maxAssemblyMs,
								packetCount: message.packetCount,
								packetBytes: message.packetBytes,
								jobMs: performance.now() - started,
							},
						};
					} else {
						await options.beforeAck?.(message);
						if (!settled) {
							// Transfer message.bytes back with the ACK so the worker can
							// refill it instead of allocating a new buffer on every packet.
							const bytes =
								message.type === "packet" ? message.bytes : undefined;
							worker.postMessage(
								{ type: "ack", sequence: message.sequence, bytes },
								bytes ? [bytes] : [],
							);
						}
					}
				} catch (error) {
					abort(error instanceof Error ? error : new Error(String(error)));
				}
			};
			worker.on("message", (message: PiHydrationMessage) => {
				consumption = consumeMessage(message);
			});
			worker.once("error", (error) => abort(error));
			worker.once("exit", async (code) => {
				// Node may drain the final message during exit notification. Wait
				// for its async consumer before deciding whether completion arrived.
				await consumption;
				// A finished worker must not retain the consumer's candidate arrays,
				// decoded packets or the old snapshot captured for identity reuse.
				worker.removeAllListeners("message");
				worker.removeAllListeners("error");
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (code === 0 && complete) resolve(complete);
				else
					reject(
						new PiTagHydrationError(
							`worker exited with code ${code} before a clean complete result`,
						),
					);
			});
		},
	);
	function abort(
		error: Error = new PiTagHydrationError("cancelled", "cancelled"),
	) {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		rejectResult(error);
		if (!exited) void shutdown.close();
	}
	const timer = inRootAsyncContext(() =>
		setTimeout(
			() => abort(new PiTagHydrationError("job deadline exceeded", "deadline")),
			options.deadlineMs ?? 10_000,
		),
	);
	timer.unref();
	worker.unref();
	// A prewarm can be cancelled before its owner joins the result. Observe
	// that background rejection immediately; awaiting result still rejects.
	void result.catch(() => {});
	return { result, released, cancel: abort };
}
