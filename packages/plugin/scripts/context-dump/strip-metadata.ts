import type { DumpMessage } from "./types"

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stripMetadataValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripMetadataValue)
	}

	if (isRecord(value)) {
		const result: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) {
			if (key === "metadata") continue
			result[key] = stripMetadataValue(child)
		}
		return result
	}

	return value
}

function stripPatchParts(messages: DumpMessage[]): DumpMessage[] {
	return messages.map((message) => ({
		...message,
		parts: message.parts.filter((part) => !isRecord(part) || part.type !== "patch"),
	}))
}

function stripInfoSummaryDiffs(messages: DumpMessage[]): DumpMessage[] {
	return messages.map((message) => {
		if (!isRecord(message.info) || !isRecord(message.info.summary)) return message
		const { diffs: _diffs, ...restSummary } = message.info.summary as Record<string, unknown>
		return {
			...message,
			info: {
				...message.info,
				summary: Object.keys(restSummary).length > 0 ? restSummary : undefined,
			},
		}
	})
}

export function stripMetadata(messages: DumpMessage[]): DumpMessage[] {
	let result = messages.map((message) => stripMetadataValue(message) as DumpMessage)
	result = stripPatchParts(result)
	result = stripInfoSummaryDiffs(result)
	return result
}
