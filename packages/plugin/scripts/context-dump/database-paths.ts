import { existsSync, readdirSync, statSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getDataDir, getOpenCodeStorageDir } from "../../src/shared/data-path"

function listDatabaseFiles(dirPath: string, filePrefix: string): string[] {
	if (!existsSync(dirPath)) {
		return []
	}

	const files = readdirSync(dirPath)
		.filter((file) => file.endsWith(".db") && file.startsWith(filePrefix))
		.map((file) => join(dirPath, file))

	return files.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
}

export function resolveOpenCodeDatabasePath(): string {
	const explicit = process.env.OPENCODE_DB_PATH
	if (explicit && existsSync(explicit)) {
		return explicit
	}

	const dataDir = getDataDir()
	const opencodeRoot = join(dataDir, "opencode")
	const defaultDb = join(opencodeRoot, "opencode.db")
	if (existsSync(defaultDb)) {
		return defaultDb
	}

	const channelDbCandidates = listDatabaseFiles(opencodeRoot, "opencode")
	if (channelDbCandidates.length > 0) {
		return channelDbCandidates[0]
	}

	const storageDbCandidates = listDatabaseFiles(getOpenCodeStorageDir(), "")
	if (storageDbCandidates.length > 0) {
		return storageDbCandidates[0]
	}

	throw new Error(
		`Unable to locate OpenCode DB. Checked ${defaultDb}, channel DBs in ${opencodeRoot}, and storage DBs in ${getOpenCodeStorageDir()}`,
	)
}

export function resolveContextDatabasePath(): string {
	const contextDbPath = join(getOpenCodeStorageDir(), "plugin", "magic-context", "context.db")
	if (!existsSync(contextDbPath)) {
		throw new Error(`Context DB not found: ${contextDbPath}`)
	}
	return contextDbPath
}

function sanitizeTimestampForFilename(timestamp: string): string {
	return timestamp.replace(/:/g, "-").replace(/\./g, "-")
}

export async function createDumpFilePath(sessionId: string, timestamp: string): Promise<string> {
	const dumpDir = join(process.cwd(), ".opencode", "dumps")
	await mkdir(dumpDir, { recursive: true })

	const filename = `context-${sessionId}-${sanitizeTimestampForFilename(timestamp)}.json`
	return join(dumpDir, filename)
}
