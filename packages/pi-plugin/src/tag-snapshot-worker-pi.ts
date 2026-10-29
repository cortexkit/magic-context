import { setTimeout as delay } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import {
	getPersistedSchemaVersion,
	LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import { tagRevisionKey } from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import {
	normalizeTagSnapshotRow,
	TAG_SELECT_COLUMNS,
} from "@magic-context/core/features/magic-context/storage-tags";
import { Database, type Statement } from "@magic-context/core/shared/sqlite";
import { exitOnWorkerClose } from "@magic-context/core/shared/worker-shutdown";
import { encodePiHydrationOperation } from "./tag-snapshot-codec-pi";
import {
	PI_FALLBACK_ROW_COLUMNS,
	PI_FALLBACK_ROW_PREDICATE,
	type PiSnapshotTag,
	projectPiPassTag,
} from "./tag-snapshot-pi";
import type {
	PiHydrationGeneration,
	PiHydrationMessage,
	PiHydrationOperation,
	PiHydrationRequest,
	PiHydrationStream,
} from "./tag-snapshot-worker-client-pi";

const port = parentPort;
if (!port) throw new Error("Pi tag hydration requires a worker port");
const request = workerData as PiHydrationRequest;
let db: Database | undefined;
let sequence = 0;
let generation: PiHydrationGeneration = { revision: "0", durable: 0 };
let maxReadTransactionMs = 0;
let packetCount = 0;
let packetBytes = 0;
let sampledGeneration = false;
let generationStatement: Statement;
let opened = false;
let persistedVersion = 0;

// A cancelled job closes its connection before the thread ends instead of
// being terminated with it open (see worker-shutdown.ts). This listener is
// registered before any packet-credit listener, so it closes the connection and
// ends the thread before a credit listener could read the request; the owner
// has already discarded the job.
const { closePort } = exitOnWorkerClose(port, () => {
	const connection = db;
	db = undefined;
	connection?.close();
});

class StaleGeneration extends Error {}
class UnsupportedSchema extends Error {}

function sample(_connection: Database): PiHydrationGeneration {
	return generationStatement.get(
		tagRevisionKey(request.sessionId),
		request.sessionId,
	) as PiHydrationGeneration;
}

function envelope() {
	return {
		jobId: request.jobId,
		sessionId: request.sessionId,
		connectionEpoch: request.connectionEpoch,
		sessionEpoch: request.sessionEpoch,
		sequence: sequence++,
		generation,
	};
}

async function send(message: PiHydrationMessage) {
	const ack = new Promise<ArrayBuffer | undefined>((resolve, reject) => {
		port?.once(
			"message",
			(value: { type: string; sequence: number; bytes?: ArrayBuffer }) => {
				if (value.type !== "ack" || value.sequence !== message.sequence)
					reject(new Error("invalid packet credit"));
				else if (
					message.type === "packet" &&
					(!(value.bytes instanceof ArrayBuffer) ||
						value.bytes.byteLength !== 65_536)
				)
					reject(new Error("invalid returned packet buffer"));
				else resolve(value.bytes);
			},
		);
	});
	if (message.type === "packet") port?.postMessage(message, [message.bytes]);
	else port?.postMessage(message);
	return await ack;
}

function* operations(
	row: Record<string, unknown>,
): Generator<PiHydrationOperation> {
	if (
		Object.values(row).every(
			(value) =>
				!(typeof value === "string" && value.length > 2_048) &&
				!(value instanceof Uint8Array && value.length > 2_048),
		)
	) {
		yield { type: "row", value: row as never };
		return;
	}
	for (const [key, value] of Object.entries(row)) {
		if (typeof value === "string" || value instanceof Uint8Array) {
			if (value.length === 0)
				yield { type: "field", key, value, append: false };
			for (let start = 0; start < value.length; start += 2_048)
				yield {
					type: "field",
					key,
					value: value.slice(start, start + 2_048),
					append: start !== 0,
					totalLength: value instanceof Uint8Array ? value.length : undefined,
				};
		} else yield { type: "field", key, value, append: false };
	}
	yield { type: "row-end" };
}

async function stream(kind: PiHydrationStream) {
	const connection = db;
	if (!connection) throw new Error("closed worker connection");
	let cursor: { tag_number: unknown; id: number } | undefined;
	let rowsSent = 0;
	const columns =
		kind === "tags" ? TAG_SELECT_COLUMNS : PI_FALLBACK_ROW_COLUMNS;
	const fallback =
		kind === "fallback" ? `AND ${PI_FALLBACK_ROW_PREDICATE}` : "";
	const query = `SELECT ${columns} FROM tags WHERE session_id = ? ${fallback}`;
	const firstPage = connection.prepare(
		`${query} ORDER BY tag_number ASC, id ASC LIMIT 256`,
	);
	const nextPage = connection.prepare(
		`${query} AND (tag_number, id) > (?, ?) ORDER BY tag_number ASC, id ASC LIMIT 256`,
	);
	const nextNullPage = connection.prepare(
		`${query} AND ((tag_number IS NULL AND id > ?) OR tag_number IS NOT NULL) ORDER BY tag_number ASC, id ASC LIMIT 256`,
	);
	let buffer = new Uint8Array(65_536);
	for (;;) {
		if (request.test?.pageDelayMs) await delay(request.test.pageDelayMs);
		const started = performance.now();
		let rows: Record<string, unknown>[];
		connection.exec("BEGIN");
		try {
			// Initialized writers install the full-row TEMP revision triggers; durable
			// tags_version also covers legacy status/identity writes. Raw metadata
			// edits without those triggers (for example manual sqlite3) are outside
			// this cache contract. data_version would reject unrelated sessions too.
			const stamp = sample(connection);
			if (!sampledGeneration) {
				sampledGeneration = true;
				generation = stamp;
			} else if (
				stamp.revision !== generation.revision ||
				stamp.durable !== generation.durable
			)
				throw new StaleGeneration("session tags changed between pages");
			// Canonical (tag_number, id) order also applies to fallback metadata.
			// context-handler.ts discards these rows after synchronizing before
			// adoption-revision capture; fallback-tag-probes-pi.ts asks only
			// whether a matching row exists. Neither selects a first match.
			rows = (
				cursor
					? cursor.tag_number === null
						? nextNullPage.all(request.sessionId, cursor.id)
						: nextPage.all(request.sessionId, cursor.tag_number, cursor.id)
					: firstPage.all(request.sessionId)
			) as Record<string, unknown>[];
			connection.exec("COMMIT");
		} catch (error) {
			connection.exec("ROLLBACK");
			throw error;
		} finally {
			maxReadTransactionMs = Math.max(
				maxReadTransactionMs,
				performance.now() - started,
			);
		}
		// SQLite has released the read transaction before any packet/credit wait.
		let used = 0;
		let packetRows = 0;
		const flush = async () => {
			if (used === 0) return;
			const bytes = buffer.buffer;
			packetCount++;
			packetBytes += used;
			const returned = await send({
				...envelope(),
				type: "packet",
				stream: kind,
				bytes,
				byteLength: used,
				rows: packetRows,
			});
			buffer = new Uint8Array(returned!);
			used = 0;
			packetRows = 0;
		};
		for (const raw of rows) {
			// Advance over raw SQL rows even when the shared mapper rejects one.
			cursor = { tag_number: raw.tag_number, id: raw.id as number };
			const normalized = kind === "tags" ? normalizeTagSnapshotRow(raw) : raw;
			const row =
				kind === "tags" && normalized && request.projection === "pass"
					? projectPiPassTag(normalized as PiSnapshotTag)
					: normalized;
			if (!row) continue;
			for (const operation of operations(
				row as unknown as Record<string, unknown>,
			)) {
				const encoded = encodePiHydrationOperation(operation);
				if (encoded.length + 4 > 65_536)
					throw new Error("field fragment exceeds packet limit");
				if (used + encoded.length + 4 > buffer.length || packetRows === 256)
					await flush();
				new DataView(buffer.buffer).setUint32(used, encoded.length);
				used += 4;
				buffer.set(encoded, used);
				used += encoded.length;
				if (operation.type === "row" || operation.type === "row-end") {
					packetRows++;
					rowsSent++;
				}
			}
		}
		await flush();
		if (rows.length < 256) break;
	}
	await send({ ...envelope(), type: "end", stream: kind, rows: rowsSent });
}

// The job runs outside module evaluation on purpose. Every packet waits for
// the parent's ACK, and some Bun releases (1.3.14 confirmed) deliver no
// parent-to-worker message until the worker's entry module has finished
// evaluating. A top-level `await` on this job would therefore wait forever
// for its first ACK. Starting the job without awaiting it lets evaluation
// end immediately; run() catches its own failures and reports them.
const run = async () => {
	try {
		if (request.test?.openDelayMs) await delay(request.test.openDelayMs);
		db = new Database(request.path, { readonly: true });
		opened = true;
		db.exec(
			"PRAGMA query_only = ON; PRAGMA busy_timeout = 50; PRAGMA cache_size = -1024",
		);
		generationStatement = db.prepare(`SELECT
		COALESCE((SELECT value FROM schema_migrations_meta WHERE key = ?), '0') AS revision,
		COALESCE((SELECT tags_version FROM session_meta WHERE session_id = ?), 0) AS durable`);
		const version = getPersistedSchemaVersion(db);
		persistedVersion = version;
		if (version > LATEST_SUPPORTED_VERSION)
			throw new UnsupportedSchema(
				`shared database schema v${version} is newer than this build supports (v${LATEST_SUPPORTED_VERSION}); update and restart this host`,
			);
		await stream("tags");
		await stream("fallback");
		if (request.test?.crash === "before-end")
			throw new Error("injected worker crash before completion");
		const final = sample(db);
		if (
			final.revision !== generation.revision ||
			final.durable !== generation.durable
		)
			throw new StaleGeneration("session tags changed after final page");
		db.close();
		db = undefined;
		port.postMessage({
			...envelope(),
			type: "done",
			maxReadTransactionMs,
			packetCount,
			packetBytes,
		} satisfies PiHydrationMessage);
		if (request.test?.crash === "after-end") process.exitCode = 1;
	} catch (error) {
		port.postMessage({
			...envelope(),
			type: "failed",
			code:
				error instanceof StaleGeneration
					? "stale"
					: error instanceof UnsupportedSchema
						? "schema"
						: opened
							? "failed"
							: "open",
			persistedVersion,
			supportedVersion: LATEST_SUPPORTED_VERSION,
			reason: error instanceof Error ? error.message : String(error),
		} satisfies PiHydrationMessage);
	} finally {
		db?.close();
		// Removes the close listener before closing the port: Bun 1.3.14 keeps
		// the thread alive otherwise, and the owner waits for this exit.
		closePort();
	}
};

void run();
