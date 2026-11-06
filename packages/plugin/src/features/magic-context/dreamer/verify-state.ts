import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { Database } from "../../../shared/sqlite";
import type { Memory } from "../memory";
import { resolveGitTopLevel } from "../memory/verification-paths";

export function verificationMetadata(memory: Memory): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(memory.metadataJson ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            return parsed as Record<string, unknown>;
    } catch {
        // Old malformed metadata must not prevent recording a new verdict.
    }
    return {};
}

/** Include file names and missing files, so remapping, deletion and recreation
 * reopen a skipped claim. Hash bytes rather than git times: an unchanged dirty
 * working tree must not cause the same inconclusive question on every run. */
export async function verificationFilesFingerprint(
    directory: string,
    files: readonly string[],
): Promise<string | null> {
    const root = (await resolveGitTopLevel(directory)) ?? path.resolve(directory);
    const hash = createHash("sha256");
    for (const file of [...new Set(files)].sort()) {
        const absolute = path.resolve(root, file);
        const withinRoot = (candidate: string) => {
            const relative = path.relative(root, candidate);
            return (
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative)
            );
        };
        if (!withinRoot(absolute)) return null;
        hash.update(JSON.stringify(file));
        try {
            if (!withinRoot(await realpath(absolute))) return null;
            hash.update(
                createHash("sha256")
                    .update(await readFile(absolute))
                    .digest("hex"),
            );
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
            hash.update("missing");
        }
    }
    return hash.digest("hex");
}

export function recordVerificationVerdict(
    db: Database,
    memory: Memory,
    verdict: "verified" | "update" | "archive" | "skip",
    at: number,
    fingerprint: string | null = null,
): void {
    const metadata = verificationMetadata(memory);
    delete metadata.dreamerVerifySkip;
    if (verdict === "skip" && fingerprint) {
        metadata.dreamerVerifySkip = { contentHash: memory.normalizedHash, fingerprint, at };
    }
    metadata.dreamerVerifyVerdict = verdict;
    metadata.dreamerVerifyAttemptedAt = at;
    db.prepare("UPDATE memories SET metadata_json = ? WHERE id = ?").run(
        JSON.stringify(metadata),
        memory.id,
    );
}
