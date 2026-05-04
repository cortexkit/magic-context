/// <reference types="bun-types" />
import { Database } from "bun:sqlite"
import type { ContextTagRow, PendingOpRow } from "./types"

interface RawTagRow {
	message_id: string
	type: string
	status: string
	tag_number: number
}

interface RawPendingOpRow {
	tag_id: number
	operation: string
	queued_at: number
}

interface RawSourceContentRow {
	tag_id: number
	content: string
}

interface RawSessionMetaRow {
	is_subagent: number | null
}

interface RawTimestampRow {
	ts: number
}

function isRawPendingOpRow(row: unknown): row is RawPendingOpRow {
	if (row === null || typeof row !== "object") return false
	const candidate = row as Record<string, unknown>
	return typeof candidate.tag_id === "number" && typeof candidate.operation === "string"
}

function isRawSourceContentRow(row: unknown): row is RawSourceContentRow {
	if (row === null || typeof row !== "object") return false
	const candidate = row as Record<string, unknown>
	return typeof candidate.tag_id === "number" && typeof candidate.content === "string"
}

function isRawSessionMetaRow(row: unknown): row is RawSessionMetaRow {
	if (row === null || typeof row !== "object") return false
	const candidate = row as Record<string, unknown>
	return candidate.is_subagent === null || typeof candidate.is_subagent === "number"
}

function isRawTimestampRow(row: unknown): row is RawTimestampRow {
	if (row === null || typeof row !== "object") return false
	const candidate = row as Record<string, unknown>
	return typeof candidate.ts === "number"
}

function isRawTagRow(row: unknown): row is RawTagRow {
	if (row === null || typeof row !== "object") return false
	const candidate = row as Record<string, unknown>
	return (
		typeof candidate.message_id === "string" &&
		typeof candidate.type === "string" &&
		typeof candidate.status === "string" &&
		typeof candidate.tag_number === "number"
	)
}

function normalizeTagType(value: string): ContextTagRow["type"] {
	if (value === "tool") return "tool"
	if (value === "file") return "file"
	if (value === "message") return "message"
	throw new Error(`Unsupported tag type in context dump: ${value}`)
}

function normalizeTagStatus(value: string): ContextTagRow["status"] {
	if (value === "dropped") return "dropped"
	if (value === "compacted") return "compacted"
	if (value === "active") return "active"
	throw new Error(`Unsupported tag status in context dump: ${value}`)
}

export function readContextMetadata(
	contextDbPath: string,
	sessionId: string,
): {
	tags: ContextTagRow[]
	pendingOps: PendingOpRow[]
	sourceContents: Map<number, string>
	isSubagent: boolean
	historianWriteTimes: number[]
} {
	const db = new Database(contextDbPath, { readonly: true })

	try {
		const tags = db
			.prepare(
				"SELECT message_id, type, status, tag_number FROM tags WHERE session_id = ? ORDER BY tag_number ASC, id ASC",
			)
			.all(sessionId)
			.filter(isRawTagRow)
			.map((row) => ({
				messageId: row.message_id,
				type: normalizeTagType(row.type),
				status: normalizeTagStatus(row.status),
				tagNumber: row.tag_number,
			}))

		const pendingOps: PendingOpRow[] = []
		try {
			const rows = db
				.prepare("SELECT tag_id, operation FROM pending_ops WHERE session_id = ?")
				.all(sessionId)
				.filter(isRawPendingOpRow)
			for (const row of rows) {
				pendingOps.push({ tagNumber: row.tag_id, operation: "drop", status: row.operation })
			}
		} catch {
			// pending_ops table may not exist in older databases
		}

		const sourceContents = new Map<number, string>()
		try {
			const rows = db
				.prepare("SELECT tag_id, content FROM source_contents WHERE session_id = ?")
				.all(sessionId)
				.filter(isRawSourceContentRow)
			for (const row of rows) {
				sourceContents.set(row.tag_id, row.content)
			}
		} catch {
			// source_contents table may not exist in older databases
		}

		let isSubagent = false
		try {
			const row = db.prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?").get(sessionId)
			if (isRawSessionMetaRow(row)) {
				isSubagent = row.is_subagent === 1
			}
		} catch {
			// session_meta table may not exist in older databases
		}

		const historianWriteTimes: number[] = []
		try {
			const rows = db
				.prepare(
					`SELECT ts FROM (
						SELECT created_at AS ts FROM compartments WHERE session_id = ?
						UNION
						SELECT updated_at AS ts FROM session_facts WHERE session_id = ?
					) ORDER BY ts ASC`,
				)
				.all(sessionId, sessionId)
				.filter(isRawTimestampRow)
			for (const row of rows) {
				historianWriteTimes.push(row.ts)
			}
		} catch {
			// historian tables may not exist in older databases
		}

		return { tags, pendingOps, sourceContents, isSubagent, historianWriteTimes }
	} finally {
		db.close(false)
	}
}
