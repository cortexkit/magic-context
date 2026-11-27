import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Publish complete JSON to a polling test or host probe. */
export function writeJsonAtomically(path: string, value: unknown): void {
	// Keep the staging file on the same filesystem, with a name that won't match command or result scans.
	const staging = join(dirname(path), `.mc-e2e-${randomUUID()}.tmp`);
	try {
		writeFileSync(staging, JSON.stringify(value));
		renameSync(staging, path);
	} catch (error) {
		rmSync(staging, { force: true });
		throw error;
	}
}
