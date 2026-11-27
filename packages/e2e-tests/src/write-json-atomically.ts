import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Write JSON under its final name in one step, so a reader that polls for the
 * file and parses it at once never sees an empty or half-written file.
 */
export function writeJsonAtomically(path: string, value: unknown): void {
	// A rename is atomic only within one filesystem, so stage next to the target.
	// Tests and their in-host helper plugins watch these folders for files named
	// like `*-command.json` or `*-result-<n>.json`; the staging name matches none.
	const staging = join(dirname(path), `.mc-e2e-${randomUUID()}.tmp`);
	try {
		writeFileSync(staging, JSON.stringify(value));
		renameSync(staging, path);
	} catch (error) {
		rmSync(staging, { force: true });
		throw error;
	}
}
