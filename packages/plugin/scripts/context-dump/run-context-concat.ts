/// <reference types="bun-types" />

import Tokenizer from "ai-tokenizer"
import * as claude from "ai-tokenizer/encoding/claude"
import { resolveOpenCodeDatabasePath } from "./database-paths"
import { readOpenCodeSessionMessages } from "./read-opencode-session"
import type { DumpMessage } from "./types"

const tokenizer = new Tokenizer(claude)

interface ConcatResult {
	sessionId: string
	totalMessages: number
	startIndex: number
	endIndex: number
	messagesWithContent: number
	totalTokens: number
	hasMore: boolean
	output: string
}

function countTokens(text: string): number {
	return tokenizer.count(text)
}

function extractTextParts(parts: unknown[]): string[] {
	const texts: string[] = []
	for (const part of parts) {
		if (part === null || typeof part !== "object") continue
		const p = part as Record<string, unknown>
		if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
			texts.push(p.text.trim())
		}
	}
	return texts
}

function countToolParts(parts: unknown[]): number {
	let count = 0
	for (const part of parts) {
		if (part === null || typeof part !== "object") continue
		const p = part as Record<string, unknown>
		if (p.type === "tool" || p.type === "tool-invocation" || p.type === "tool_use" || p.type === "tool_result") {
			count++
		}
	}
	return count
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1)
}

export function runContextConcat(sessionId: string, tokenBudget: number, offset = 0): ConcatResult {
	const opencodeDbPath = resolveOpenCodeDatabasePath()
	const allMessages = readOpenCodeSessionMessages(opencodeDbPath, sessionId)

	const lines: { index: number; text: string }[] = []
	let totalTokens = 0
	let messagesWithContent = 0
	let lastIndex = offset
	let pendingToolCount = 0
	let pendingToolFirstIndex = offset

	for (let i = offset; i < allMessages.length; i++) {
		const msg = allMessages[i] as DumpMessage
		const role = String(msg.info.role ?? "unknown")
		const texts = extractTextParts(msg.parts)
		const toolCount = countToolParts(msg.parts)

		if (toolCount > 0 && texts.length === 0 && role === "assistant") {
			if (pendingToolCount === 0) pendingToolFirstIndex = i
			pendingToolCount += toolCount
			lastIndex = i
			messagesWithContent++
			continue
		}

		if (pendingToolCount > 0) {
			const toolLine = `[${pendingToolFirstIndex}] Assistant: ${pendingToolCount} tool call${pendingToolCount > 1 ? "s" : ""}`
			const toolTokens = countTokens(toolLine)
			if (totalTokens + toolTokens > tokenBudget) break
			lines.push({ index: pendingToolFirstIndex, text: toolLine })
			totalTokens += toolTokens
			pendingToolCount = 0
		}

		if (texts.length === 0) continue

		const prefix = toolCount > 0 ? ` (+ ${toolCount} tool call${toolCount > 1 ? "s" : ""})` : ""
		const line = `[${i}] ${capitalize(role)}${prefix}: ${texts.join("\n")}`
		const lineTokens = countTokens(line)
		if (totalTokens + lineTokens > tokenBudget) break

		lines.push({ index: i, text: line })
		totalTokens += lineTokens
		messagesWithContent++
		lastIndex = i
	}

	if (pendingToolCount > 0) {
		const toolLine = `[${pendingToolFirstIndex}] Assistant: ${pendingToolCount} tool call${pendingToolCount > 1 ? "s" : ""}`
		const toolTokens = countTokens(toolLine)
		if (totalTokens + toolTokens <= tokenBudget) {
			lines.push({ index: pendingToolFirstIndex, text: toolLine })
			totalTokens += toolTokens
		}
	}

	return {
		sessionId,
		totalMessages: allMessages.length,
		startIndex: offset,
		endIndex: lastIndex,
		messagesWithContent,
		totalTokens,
		hasMore: lastIndex + 1 < allMessages.length,
		output: lines.map((l) => l.text).join("\n"),
	}
}
