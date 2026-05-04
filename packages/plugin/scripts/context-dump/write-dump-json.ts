import { createWriteStream } from "node:fs"
import type { DumpMessage, DumpStats, PendingOpRow, TransformDiagnostics } from "./types"

function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: string): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(chunk, "utf-8", (error) => {
			if (error) {
				reject(error)
				return
			}
			resolve()
		})
	})
}

async function writeMessageArrayPretty(
	stream: ReturnType<typeof createWriteStream>,
	messages: DumpMessage[],
	indent: string,
): Promise<void> {
	if (messages.length === 0) {
		return
	}

	await writeChunk(stream, "\n")

	for (let index = 0; index < messages.length; index += 1) {
		const suffix = index === messages.length - 1 ? "" : ","
		const prettyMessage = JSON.stringify(messages[index], null, 2).replace(/\n/g, `\n${indent}`)
		await writeChunk(stream, `${indent}${prettyMessage}${suffix}\n`)
	}
}

export async function writeDumpJsonFile(params: {
	outputPath: string
	sessionId: string
	timestamp: string
	originalMessages: DumpMessage[]
	transformedMessages: DumpMessage[]
	stats: DumpStats
	pendingOps?: PendingOpRow[]
	diagnostics: TransformDiagnostics
}): Promise<void> {
	const { outputPath, sessionId, timestamp, originalMessages, transformedMessages, stats, pendingOps, diagnostics } =
		params

	const stream = createWriteStream(outputPath, { encoding: "utf-8" })

	try {
		await writeChunk(stream, "{\n")
		await writeChunk(stream, `  "session_id": ${JSON.stringify(sessionId)},\n`)
		await writeChunk(stream, `  "timestamp": ${JSON.stringify(timestamp)},\n`)
		await writeChunk(stream, `  "message_count": ${stats.messageCount},\n`)
		await writeChunk(stream, '  "original": {\n')
		await writeChunk(stream, `    "total_chars": ${stats.originalTotalChars},\n`)
		await writeChunk(stream, `    "total_tokens": ${stats.originalTotalTokens},\n`)
		await writeChunk(stream, '    "messages": [')
		await writeMessageArrayPretty(stream, originalMessages, "      ")
		await writeChunk(stream, "    ]\n")
		await writeChunk(stream, "  },\n")
		await writeChunk(stream, '  "transformed": {\n')
		await writeChunk(stream, `    "total_chars": ${stats.transformedTotalChars},\n`)
		await writeChunk(stream, `    "total_tokens": ${stats.transformedTotalTokens},\n`)
		await writeChunk(stream, '    "messages": [')
		await writeMessageArrayPretty(stream, transformedMessages, "      ")
		await writeChunk(stream, "    ]\n")
		await writeChunk(stream, "  },\n")
		await writeChunk(stream, `  "compression_ratio": ${JSON.stringify(stats.compressionRatio)},\n`)
		await writeChunk(stream, `  "per_message_sizes": ${JSON.stringify(stats.perMessageSizes, null, 2).replace(/\n/g, "\n  ")},\n`)
		await writeChunk(stream, `  "per_message_cache": ${JSON.stringify(stats.perMessageCache, null, 2).replace(/\n/g, "\n  ")},\n`)
		await writeChunk(
			stream,
			`  "transform_diagnostics": ${JSON.stringify(diagnostics, null, 2).replace(/\n/g, "\n  ")},\n`,
		)
		await writeChunk(stream, `  "pending_ops": ${JSON.stringify(pendingOps ?? [], null, 2).replace(/\n/g, "\n  ")}\n`)
		await writeChunk(stream, "}\n")
	} finally {
		await new Promise<void>((resolve, reject) => {
			stream.end((error?: Error | null) => {
				if (error) {
					reject(error)
					return
				}
				resolve()
			})
		})
	}
}
