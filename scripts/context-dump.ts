#!/usr/bin/env bun
import { runContextDump } from "./context-dump/run-context-dump"

function usage(): string {
	return "Usage: bun run scripts/context-dump.ts <session_id>"
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	if (args.length !== 1) {
		throw new Error(`${usage()}\n\nExpected exactly 1 argument: session_id`)
	}

	const sessionId = args[0]
	const result = await runContextDump(sessionId)

	console.log(`Context dump written to: ${result.outputPath}`)
	console.log(`Session: ${result.sessionId}`)
	console.log(`Messages: ${result.messageCount}`)
	console.log(`Original chars: ${result.originalChars}`)
	console.log(`Transformed chars: ${result.transformedChars}`)
	console.log(`Original tokens (approx): ${result.originalTokens}`)
	console.log(`Transformed tokens (approx): ${result.transformedTokens}`)
	console.log(`Compression ratio: ${result.compressionRatio}`)
	console.log(`Cache busts: ${result.cacheBustCount}`)
	console.log(`Exact tag matches: ${result.diagnostics.exactMatchCount}`)
	console.log(`Ordinal fallback matches: ${result.diagnostics.ordinalFallbackCount}`)
	console.log(`Dropped tags without targets: ${result.diagnostics.missingDroppedTags.length}`)
	if (result.diagnostics.missingDroppedTags.length > 0) {
		const byType = new Map<string, number>()
		for (const tag of result.diagnostics.missingDroppedTags) {
			byType.set(tag.type, (byType.get(tag.type) ?? 0) + 1)
		}
		console.log(
			`Missing dropped tags by type: ${[...byType.entries()].map(([type, count]) => `${type}=${count}`).join(", ")}`,
		)
	}
	console.log()
	if (result.lastBusts.length > 0) {
		console.log(`Last ${result.lastBusts.length} cache busts:`)
		console.log("  " + "Time".padEnd(22) + "Read".padStart(10) + "Write".padStart(10) + "  Parts")
		console.log("  " + "-".repeat(70))
		for (const bust of result.lastBusts) {
			console.log(
				"  " +
					bust.time.padEnd(22) +
					String(bust.cache_read).padStart(10) +
					String(bust.cache_write).padStart(10) +
					"  " +
					bust.parts,
			)
			console.log(`    Probable: ${bust.classification} - ${bust.detail}`)
		}
	}
	if (result.pendingOps.length > 0) {
		console.log()
		console.log(`Pending operations: ${result.pendingOps.length}`)
		const drops = result.pendingOps.filter((op) => op.operation === "drop")
		if (drops.length > 0)
			console.log(`  Drops: ${drops.length} (tags: ${drops.map((d) => d.tagNumber).join(", ")})`)
	}
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(`context-dump failed: ${message}`)
	process.exitCode = 1
})
