import { Database } from "../../src/shared/sqlite"
import { applyTransforms } from "./apply-transforms"
import { buildDumpStats } from "./metrics"
import { createDumpFilePath, resolveContextDatabasePath, resolveOpenCodeDatabasePath } from "./database-paths"
import { readContextMetadata } from "./read-context-metadata"
import { readOpenCodeSessionMessages } from "./read-opencode-session"
import { stripMetadata } from "./strip-metadata"
import { writeDumpJsonFile } from "./write-dump-json"
import type { DumpMessage, DumpMessageCacheEntry, PendingOpRow, TransformDiagnostics } from "./types"
import { prepareCompartmentInjection, renderCompartmentInjection } from "../../src/hooks/magic-context/inject-compartments"
import type { MessageLike } from "../../src/hooks/magic-context/tag-messages"

const HISTORIAN_BUST_WINDOW_MS = 5 * 60 * 1000

interface ContextDumpBust {
	time: string
	parts: string
	cache_read: number
	cache_write: number
	classification: string
	detail: string
}

export interface ContextDumpResult {
	sessionId: string
	outputPath: string
	openCodeDbPath: string
	contextDbPath: string
	originalChars: number
	transformedChars: number
	originalTokens: number
	transformedTokens: number
	compressionRatio: string
	messageCount: number
	cacheBustCount: number
	lastBusts: ContextDumpBust[]
	pendingOps: PendingOpRow[]
	diagnostics: TransformDiagnostics
}

function getMessageInfoString(message: DumpMessage | undefined, key: string): string | null {
	if (!message) return null
	const value = message.info[key]
	return typeof value === "string" && value.length > 0 ? value : null
}

function formatRelativeDuration(deltaMs: number): string {
	if (deltaMs < 1000) return `${deltaMs}ms`
	const seconds = Math.round(deltaMs / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.round(minutes / 60)
	return `${hours}h`
}

function findRelevantHistorianWrite(
	bustTime: number | null,
	previousBustTime: number | null,
	historianWriteTimes: number[],
): number | null {
	if (bustTime === null) return null
	const lowerBound = Math.max(previousBustTime ?? 0, bustTime - HISTORIAN_BUST_WINDOW_MS)
	let matched: number | null = null
	for (const timestamp of historianWriteTimes) {
		if (timestamp <= lowerBound) continue
		if (timestamp > bustTime) break
		matched = timestamp
	}
	return matched
}


function classifyBust(
	entry: DumpMessageCacheEntry,
	previousEntry: DumpMessageCacheEntry | undefined,
	messageById: Map<string, DumpMessage>,
	historianWriteTimes: number[],
	previousBustTime: number | null,
): { classification: string; detail: string } {
	const message = messageById.get(entry.id)
	const previousMessage = previousEntry ? messageById.get(previousEntry.id) : undefined
	const currentVariant = getMessageInfoString(message, "variant")
	const previousVariant = getMessageInfoString(previousMessage, "variant")
	const currentParentId = getMessageInfoString(message, "parentID")
	const previousParentId = getMessageInfoString(previousMessage, "parentID")
	const historianWriteTime = findRelevantHistorianWrite(
		entry.time_completed,
		previousBustTime,
		historianWriteTimes,
	)

	if (entry.cache_read === 0 || (currentVariant && previousVariant && currentVariant !== previousVariant)) {
		return {
			classification: "system/variant flush",
			detail:
				currentVariant && previousVariant && currentVariant !== previousVariant
					? `variant changed ${previousVariant} -> ${currentVariant}`
					: "cache read reset to 0",
		}
	}

	if (historianWriteTime !== null && entry.time_completed !== null) {
		return {
			classification: "historian injection",
			detail: `${formatRelativeDuration(entry.time_completed - historianWriteTime)} after historian write`,
		}
	}

	if (currentParentId && previousParentId && currentParentId !== previousParentId) {
		return {
			classification: "sticky reminder / new turn",
			detail: "first assistant after a new user turn",
		}
	}

	if (currentParentId && currentParentId === previousParentId) {
		return {
			classification: "nudge anchor / same turn",
			detail: "same user turn, no historian write or full flush",
		}
	}

	return {
		classification: "unknown",
		detail: "insufficient turn metadata to infer cause",
	}
}

export async function runContextDump(sessionId: string): Promise<ContextDumpResult> {
	if (!sessionId.trim()) {
		throw new Error("session_id is required")
	}

	const openCodeDbPath = resolveOpenCodeDatabasePath()
	const contextDbPath = resolveContextDatabasePath()

	const originalMessages = stripMetadata(readOpenCodeSessionMessages(openCodeDbPath, sessionId))
	const transformedMessages = structuredClone(originalMessages)

	const { tags, pendingOps, sourceContents, isSubagent, historianWriteTimes } = readContextMetadata(
		contextDbPath,
		sessionId,
	)
	const contextDb = new Database(contextDbPath, { readonly: true })
	let diagnostics: TransformDiagnostics
	try {
		const preparedCompartmentInjection = isSubagent
			? null
			: prepareCompartmentInjection(contextDb, sessionId, transformedMessages as unknown as MessageLike[], true)
		const compartmentInjection = preparedCompartmentInjection
			? renderCompartmentInjection(sessionId, transformedMessages as unknown as MessageLike[], preparedCompartmentInjection)
			: { injected: false, compartmentEndMessage: -1, compartmentCount: 0, skippedVisibleMessages: 0 }
		diagnostics = applyTransforms(transformedMessages, tags, sourceContents, {
			exactMatchCount: 0,
			ordinalFallbackCount: 0,
			missingDroppedTags: [],
			compartmentInjection,
		})
	} finally {
		contextDb.close()
	}

	const timestamp = new Date().toISOString()
	const outputPath = await createDumpFilePath(sessionId, timestamp)
	const stats = buildDumpStats(originalMessages, transformedMessages)
	await writeDumpJsonFile({
		outputPath,
		sessionId,
		timestamp,
		originalMessages,
		transformedMessages,
		stats,
		pendingOps,
		diagnostics,
	})

	const messageById = new Map(
		originalMessages
			.map((message) => {
				const id = typeof message.info.id === "string" ? message.info.id : null
				return id ? ([id, message] as const) : null
			})
			.filter((entry): entry is readonly [string, DumpMessage] => entry !== null),
	)
	const busts = stats.perMessageCache.filter((c) => c.cache_bust && c.time_completed !== null)
	let previousBustTime: number | null = null
	const classifiedBusts = stats.perMessageCache.flatMap((entry, index) => {
		if (!entry.cache_bust || entry.time_completed === null) return []
		const previousEntry = index > 0 ? stats.perMessageCache[index - 1] : undefined
		const probableCause = classifyBust(
			entry,
			previousEntry,
			messageById,
			historianWriteTimes,
			previousBustTime,
		)
		//console.dir(entry);

		previousBustTime = entry.time_completed
		return [{ entry, probableCause }]
	})
	const lastBusts = classifiedBusts.slice(-10).map(({ entry, probableCause }) => {
		const time = entry.time_completed !== null
			? new Date(entry.time_completed).toISOString().replace("T", " ").slice(0, 19)
			: "unknown"
		return {
			time,
			parts: entry.part_types,
			cache_read: entry.cache_read,
			cache_write: entry.cache_write,
			classification: probableCause.classification,
			detail: probableCause.detail,
		}
	})

	return {
		sessionId,
		outputPath,
		openCodeDbPath,
		contextDbPath,
		originalChars: stats.originalTotalChars,
		transformedChars: stats.transformedTotalChars,
		originalTokens: stats.originalTotalTokens,
		transformedTokens: stats.transformedTotalTokens,
		compressionRatio: stats.compressionRatio,
		messageCount: stats.messageCount,
		cacheBustCount: busts.length,
		lastBusts,
		pendingOps,
		diagnostics,
	}
}
