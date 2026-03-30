/// <reference types="bun-types" />
import { Database } from "bun:sqlite"
import type { DumpMessage, DumpMessageInfo } from "./types"

interface MessageRow {
	id: string
	data: string
}

interface PartRow {
	message_id: string
	data: string
}

function isMessageRow(row: unknown): row is MessageRow {
	if (row === null || typeof row !== "object") return false
	const candidate = row as Record<string, unknown>
	return typeof candidate.id === "string" && typeof candidate.data === "string"
}

function isPartRow(row: unknown): row is PartRow {
	if (row === null || typeof row !== "object") return false
	const candidate = row as Record<string, unknown>
	return typeof candidate.message_id === "string" && typeof candidate.data === "string"
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch (error) {
		throw new Error(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`)
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Expected object JSON in ${label}`)
	}

	return parsed as Record<string, unknown>
}

function parseJsonUnknown(value: string, label: string): unknown {
	try {
		return JSON.parse(value)
	} catch (error) {
		throw new Error(`Invalid JSON in ${label}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

export function readOpenCodeSessionMessages(opencodeDbPath: string, sessionId: string): DumpMessage[] {
	const db = new Database(opencodeDbPath, { readonly: true })

	try {
		const messageRows = db
			.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
			.all(sessionId)
			.filter(isMessageRow)

		if (messageRows.length === 0) {
			throw new Error(`No messages found for session ${sessionId}`)
		}

		const partRows = db
			.prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC")
			.all(sessionId)
			.filter(isPartRow)

		const partsByMessageId = new Map<string, unknown[]>()
		for (const part of partRows) {
			const list = partsByMessageId.get(part.message_id) ?? []
			list.push(parseJsonUnknown(part.data, `part:${part.message_id}`))
			partsByMessageId.set(part.message_id, list)
		}

		const messages: DumpMessage[] = []
		for (const row of messageRows) {
			const infoRecord = parseJsonRecord(row.data, `message:${row.id}`)
			const info: DumpMessageInfo = {
				...infoRecord,
				id: row.id,
			}
			if (typeof info.sessionID !== "string") {
				info.sessionID = sessionId
			}

			messages.push({
				info,
				parts: partsByMessageId.get(row.id) ?? [],
			})
		}

		return messages
	} finally {
		db.close(false)
	}
}
