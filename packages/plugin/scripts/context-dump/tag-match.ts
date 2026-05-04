import type { ContextTagRow } from "./types"

type TaggableType = "message" | "file"

interface ParsedContentId {
	messageId: string
	type: TaggableType
	partIndex: number
}

interface ScopedTag {
	tag: ContextTagRow
	partIndex: number
}

export interface TagMatchResult {
	tag: ContextTagRow
	matchedBy: "exact" | "ordinal"
}

function parseContentId(contentId: string): ParsedContentId | null {
	const match = /^(.*):(p|file)(\d+)$/.exec(contentId)
	if (!match) return null

	return {
		messageId: match[1],
		type: match[2] === "file" ? "file" : "message",
		partIndex: Number.parseInt(match[3], 10),
	}
}

export function createTagMatcher(tags: ContextTagRow[]) {
	const tagsByContentId = new Map(tags.map((tag) => [tag.messageId, tag] as const))
	const scopedTags = new Map<string, Record<TaggableType, ScopedTag[]>>()
	const usedTagNumbers = new Set<number>()

	for (const tag of tags) {
		const parsed = parseContentId(tag.messageId)
		if (!parsed) continue

		const entry = scopedTags.get(parsed.messageId) ?? { message: [], file: [] }
		entry[parsed.type].push({ tag, partIndex: parsed.partIndex })
		scopedTags.set(parsed.messageId, entry)
	}

	for (const entry of scopedTags.values()) {
		entry.message.sort((left, right) => left.partIndex - right.partIndex)
		entry.file.sort((left, right) => left.partIndex - right.partIndex)
	}

	return {
		getByContentId(contentId: string): ContextTagRow | undefined {
			const tag = tagsByContentId.get(contentId)
			if (tag) usedTagNumbers.add(tag.tagNumber)
			return tag
		},

		resolve(messageId: string, type: TaggableType, contentId: string, ordinal: number): TagMatchResult | null {
			const exact = tagsByContentId.get(contentId)
			if (exact) {
				usedTagNumbers.add(exact.tagNumber)
				return { tag: exact, matchedBy: "exact" }
			}

			const fallback = scopedTags.get(messageId)?.[type][ordinal]
			if (!fallback || usedTagNumbers.has(fallback.tag.tagNumber)) {
				return null
			}

			usedTagNumbers.add(fallback.tag.tagNumber)
			return { tag: fallback.tag, matchedBy: "ordinal" }
		},
	}
}
