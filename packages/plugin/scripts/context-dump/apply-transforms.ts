import type { ContextTagRow, DumpMessage, TransformDiagnostics } from "./types"
import { createTagMatcher } from "./tag-match"
import {
	createToolDropTarget,
	extractToolCallObservation,
	ToolMutationBatch,
	type ToolCallIndex,
	type ToolDropResult,
} from "../../src/hooks/magic-context/tool-drop-target"
import { stripStructuralNoise } from "../../src/hooks/magic-context/strip-structural-noise"
import { stripClearedReasoning } from "../../src/hooks/magic-context/strip-content"
import type { MessageLike } from "../../src/hooks/magic-context/tag-messages"

interface TextPart {
	type: string
	text: string
}
interface ToolPart {
	type: string
	callID: string
	state: { output: string; input?: Record<string, unknown> }
}
interface FilePart {
	type: string
	url: string
}
interface ThinkingLikePart {
	type: string
	thinking?: string
	text?: string
}

interface TagTarget {
	setContent: (content: string) => boolean
	drop?: () => ToolDropResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function isTextPart(part: unknown): part is TextPart {
	return isRecord(part) && part.type === "text" && typeof part.text === "string"
}

function isToolPartWithOutput(part: unknown): part is ToolPart {
	if (!isRecord(part) || part.type !== "tool" || typeof part.callID !== "string") return false
	if (!isRecord(part.state)) return false
	return typeof part.state.output === "string"
}

function isThinkingPart(part: unknown): part is ThinkingLikePart {
	return isRecord(part) && (part.type === "thinking" || part.type === "reasoning")
}

function isFilePart(part: unknown): part is FilePart {
	return isRecord(part) && part.type === "file" && typeof part.url === "string"
}

function prependTag(tagId: number, value: string): string {
	const stripped = value.replace(/^§\d+§\s*/, "")
	return `§${tagId}§ ${stripped}`
}

export function applyTransforms(
	messages: DumpMessage[],
	tags: ContextTagRow[],
	sourceContents: Map<number, string> = new Map(),
	diagnostics: TransformDiagnostics = {
		exactMatchCount: 0,
		ordinalFallbackCount: 0,
		missingDroppedTags: [],
	},
): TransformDiagnostics {
	const matcher = createTagMatcher(tags)
	const targets = new Map<number, TagTarget>()
	const reasoningByMessage = new Map<DumpMessage, ThinkingLikePart[]>()
	const messageTagNumbers = new Map<DumpMessage, number>()
	const toolTagByCallId = new Map<string, number>()
	const toolThinkingByCallId = new Map<string, ThinkingLikePart[]>()
	const toolCallIndex: ToolCallIndex = new Map()
	const batch = new ToolMutationBatch(messages as unknown as MessageLike[])
	const visibleContentIds = new Set<string>()
	let exactMatchCount = 0
	let ordinalFallbackCount = 0

	let precedingThinkingParts: ThinkingLikePart[] = []

	for (const message of messages) {
		const messageId = typeof message.info.id === "string" ? message.info.id : null

		if (message.info.role === "user") {
			precedingThinkingParts = []
		}

		const messageThinkingParts = message.parts.filter(isThinkingPart)
		if (messageThinkingParts.length > 0) {
			reasoningByMessage.set(message, messageThinkingParts)
		}

		const messageHasTextPart = message.parts.some(isTextPart)
		let textOrdinal = 0
		let fileOrdinal = 0

		for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
			const part = message.parts[partIndex]

			const toolObservation = extractToolCallObservation(part)
			if (toolObservation) {
				const entry = toolCallIndex.get(toolObservation.callId) ?? { occurrences: [], hasResult: false }
				entry.occurrences.push({
					message: message as unknown as MessageLike,
					part,
					kind: toolObservation.kind,
				})
				if (toolObservation.kind === "result") entry.hasResult = true
				toolCallIndex.set(toolObservation.callId, entry)

				const existingTag = matcher.getByContentId(toolObservation.callId)
				if (existingTag) {
					toolTagByCallId.set(toolObservation.callId, existingTag.tagNumber)
					messageTagNumbers.set(message, Math.max(messageTagNumbers.get(message) ?? 0, existingTag.tagNumber))
					if (
						message.info.role === "tool" &&
						precedingThinkingParts.length > 0 &&
						!toolThinkingByCallId.has(toolObservation.callId)
					) {
						toolThinkingByCallId.set(toolObservation.callId, precedingThinkingParts)
					}
				}
			}

			if (messageId && isTextPart(part)) {
				visibleContentIds.add(`${messageId}:p${partIndex}`)
				const match = matcher.resolve(messageId, "message", `${messageId}:p${partIndex}`, textOrdinal)
				textOrdinal += 1
				if (!match) continue

				const tag = match.tag
				if (match.matchedBy === "exact") exactMatchCount += 1
				else ordinalFallbackCount += 1

				const sourceContent = sourceContents.get(tag.tagNumber)
				if (sourceContent !== undefined) {
					part.text = sourceContent
				}
				part.text = prependTag(tag.tagNumber, part.text)
				messageTagNumbers.set(message, Math.max(messageTagNumbers.get(message) ?? 0, tag.tagNumber))

				targets.set(tag.tagNumber, {
					setContent: (content: string) => {
						if (part.text === content) return false
						part.text = content
						for (const thinkingPart of messageThinkingParts) {
							if (thinkingPart.thinking !== undefined) thinkingPart.thinking = "[cleared]"
							if (thinkingPart.text !== undefined) thinkingPart.text = "[cleared]"
						}
						return true
					},
				})
				continue
			}

			if (isToolPartWithOutput(part)) {
				visibleContentIds.add(part.callID)
				const tag = matcher.getByContentId(part.callID)
				if (!tag) continue

				part.state.output = prependTag(tag.tagNumber, part.state.output)
				messageTagNumbers.set(message, Math.max(messageTagNumbers.get(message) ?? 0, tag.tagNumber))
				toolTagByCallId.set(part.callID, tag.tagNumber)
				if (precedingThinkingParts.length > 0 && !toolThinkingByCallId.has(part.callID)) {
					toolThinkingByCallId.set(part.callID, precedingThinkingParts)
				}
				continue
			}

			if (messageId && isFilePart(part)) {
				visibleContentIds.add(`${messageId}:file${partIndex}`)
				const match = matcher.resolve(messageId, "file", `${messageId}:file${partIndex}`, fileOrdinal)
				fileOrdinal += 1
				if (!match) continue

				const tag = match.tag
				if (match.matchedBy === "exact") exactMatchCount += 1
				else ordinalFallbackCount += 1

				messageTagNumbers.set(message, Math.max(messageTagNumbers.get(message) ?? 0, tag.tagNumber))
				targets.set(tag.tagNumber, {
					setContent: (content: string) => {
						const existingPart = message.parts[partIndex]
						if (isRecord(existingPart) && existingPart.type === "text" && existingPart.text === content) {
							return false
						}
						message.parts[partIndex] = { type: "text", text: content }
						return true
					},
				})
			}
		}

		if (message.info.role === "assistant" && !messageHasTextPart) {
			precedingThinkingParts = messageThinkingParts
		}
	}

	for (const [callId, tagNumber] of toolTagByCallId) {
		const thinkingParts = toolThinkingByCallId.get(callId) ?? []
		targets.set(tagNumber, createToolDropTarget(callId, thinkingParts, toolCallIndex, batch))
	}

	const missingDroppedTags = tags.filter(
		(tag) => tag.status === "dropped" && visibleContentIds.has(tag.messageId) && !targets.has(tag.tagNumber),
	)

	for (const tag of tags) {
		if (tag.status !== "dropped") continue

		const target = targets.get(tag.tagNumber)
		if (tag.type === "tool") {
			target?.drop?.()
		} else if (target) {
			target.setContent(`[dropped §${tag.tagNumber}§]`)
		}
	}

	batch.finalize()

	stripStructuralNoise(messages as unknown as MessageLike[])
	stripClearedReasoning(messages as unknown as MessageLike[])

	return {
		...diagnostics,
		exactMatchCount,
		ordinalFallbackCount,
		missingDroppedTags,
	}
}
