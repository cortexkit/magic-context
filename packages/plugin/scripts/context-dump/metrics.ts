import Tokenizer from "ai-tokenizer"
import * as claude from "ai-tokenizer/encoding/claude"
import type { DumpMessage, DumpStats, DumpMessageCacheEntry } from "./types"

const TAG_PREFIX_PATTERN = /^§\d+§ /
const tokenizer = new Tokenizer(claude)

function stringifyForCharCount(value: unknown): string {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

function countChars(value: unknown): number {
	return stringifyForCharCount(value).length
}

function countApproxTokens(value: unknown): number {
	return tokenizer.count(stringifyForCharCount(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function countTagPrefixOverhead(message: DumpMessage): number {
	let overhead = 0
	for (const part of message.parts) {
		if (!isRecord(part)) continue
		if (part.type === "text" && typeof part.text === "string") {
			const match = part.text.match(TAG_PREFIX_PATTERN)
			if (match) overhead += match[0].length
		}
		if (part.type === "tool" && isRecord(part.state) && typeof part.state.output === "string") {
			const match = part.state.output.match(TAG_PREFIX_PATTERN)
			if (match) overhead += match[0].length
		}
	}
	return overhead
}

function stripTagPrefixes(message: DumpMessage): DumpMessage {
	return {
		...message,
		parts: message.parts.map((part) => {
			if (!isRecord(part)) return part

			const clonedPart: Record<string, unknown> = { ...part }

			if (clonedPart.type === "text" && typeof clonedPart.text === "string") {
				clonedPart.text = clonedPart.text.replace(TAG_PREFIX_PATTERN, "")
			}

			if (clonedPart.type === "tool" && isRecord(clonedPart.state) && typeof clonedPart.state.output === "string") {
				clonedPart.state = {
					...clonedPart.state,
					output: clonedPart.state.output.replace(TAG_PREFIX_PATTERN, ""),
				}
			}

			return clonedPart
		}),
	}
}

function messageIdentity(message: DumpMessage, fallbackIndex: number): { id: string; role: string } {
	const id = typeof message.info.id === "string" ? message.info.id : `message_${fallbackIndex + 1}`
	const role = typeof message.info.role === "string" ? message.info.role : "unknown"
	return { id, role }
}

export function buildDumpStats(originalMessages: DumpMessage[], transformedMessages: DumpMessage[]): DumpStats {
	const transformedById = new Map<string, DumpMessage>()
	for (const msg of transformedMessages) {
		const id = typeof msg.info.id === "string" ? msg.info.id : null
		if (id) transformedById.set(id, msg)
	}

	const perMessageSizes = originalMessages.map((original, index) => {
		const { id, role } = messageIdentity(original, index)
		const transformed = transformedById.get(id) ?? null
		const rawChars = transformed ? countChars(transformed) : 0
		const overhead = transformed ? countTagPrefixOverhead(transformed) : 0

		return {
			id,
			role,
			original_chars: countChars(original),
			transformed_chars: rawChars - overhead,
		}
	})

	let prevCacheRead = 0
	const perMessageCache: DumpMessageCacheEntry[] = originalMessages
		.filter((msg) => msg.info.role === "assistant" && isRecord(msg.info.tokens))
		.map((msg, index) => {
			const { id } = messageIdentity(msg, index)
			const tokens = msg.info.tokens as Record<string, unknown>
			const error = msg.info.error;
			const cache = isRecord(tokens.cache) ? tokens.cache : {}
			const total = typeof tokens.total === "number" ? tokens.total : 0
			const input = typeof tokens.input === "number" ? tokens.input : 0
			const output = typeof tokens.output === "number" ? tokens.output : 0
			const cacheRead = typeof cache.read === "number" ? cache.read : 0
			const cacheWrite = typeof cache.write === "number" ? cache.write : 0
			const cacheBust = prevCacheRead > 0 && cacheRead < prevCacheRead && (!error || error.name != "MessageAbortedError")
			prevCacheRead = cacheRead

			const time = isRecord(msg.info.time) ? msg.info.time : {}
			const timeCompleted = typeof time.completed === "number" ? time.completed : null

			const STRUCTURAL_TYPES = new Set(["step-start", "step-finish", "meta"])
			const partTypes = msg.parts
				.filter((p) => isRecord(p) && typeof p.type === "string" && !STRUCTURAL_TYPES.has(p.type as string))
				.map((p) => (p as Record<string, unknown>).type as string)
			const uniquePartTypes = [...new Set(partTypes)].join(", ")

			return {
				id,
				role: "assistant" as const,
				total,
				input,
				output,
				cache_read: cacheRead,
				cache_write: cacheWrite,
				cache_bust: cacheBust,
				time_completed: timeCompleted,
				part_types: uniquePartTypes,
			}
		})

	const originalTotalChars = perMessageSizes.reduce((sum, item) => sum + item.original_chars, 0)
	const transformedTotalChars = perMessageSizes.reduce((sum, item) => sum + item.transformed_chars, 0)
	const originalTotalTokens = originalMessages.reduce((sum, message) => sum + countApproxTokens(message), 0)
	const transformedTotalTokens = originalMessages.reduce((sum, original, index) => {
		const { id } = messageIdentity(original, index)
		const transformed = transformedById.get(id)
		if (!transformed) return sum
		return sum + countApproxTokens(stripTagPrefixes(transformed))
	}, 0)
	const compressionRatio =
		originalTotalChars > 0 ? `${Math.round((1 - transformedTotalChars / originalTotalChars) * 100)}%` : "0%"

	return {
		messageCount: originalMessages.length,
		originalTotalChars,
		transformedTotalChars,
		originalTotalTokens,
		transformedTotalTokens,
		compressionRatio,
		perMessageSizes,
		perMessageCache,
	}
}
