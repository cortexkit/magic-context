import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Historian state-file offloading.
 *
 * When the existing-state XML (prior compartments + facts + project memory)
 * exceeds {@link HISTORIAN_STATE_INLINE_THRESHOLD} characters, the historian
 * caller writes it to a temp file under {@link HISTORIAN_STATE_DIR} and the
 * prompt instructs the model to `Read this file first`. This avoids pushing
 * 100K+ chars of inline reference state through the model's input on long
 * sessions, which on some provider/model combinations (notably
 * github-copilot/gpt-5.4 via the openai-responses API) causes the model to
 * stall before emitting any output tokens.
 *
 * The caller MUST delete the file in finally{} via
 * {@link cleanupHistorianStateFile}.
 *
 * Shared between OpenCode (`compartment-runner-incremental.ts`,
 * `compartment-runner-recomp.ts`) and Pi (`pi-historian-runner.ts`).
 */
export const HISTORIAN_STATE_INLINE_THRESHOLD = 30_000;
export const HISTORIAN_STATE_DIR = join(tmpdir(), "magic-context-historian");

/**
 * When existingState is large, write it to a temp file and return the path.
 * Returns undefined when existingState is small enough to inline OR when
 * writing fails (in which case the caller should fall back to inline).
 */
export function maybeWriteHistorianStateFile(
    sessionId: string,
    existingState: string,
): string | undefined {
    if (existingState.length <= HISTORIAN_STATE_INLINE_THRESHOLD) return undefined;
    try {
        mkdirSync(HISTORIAN_STATE_DIR, { recursive: true });
        const path = join(HISTORIAN_STATE_DIR, `state-${sessionId}-${Date.now()}.xml`);
        writeFileSync(path, existingState, "utf8");
        return path;
    } catch {
        return undefined;
    }
}

/** Delete a previously written state file. Safe to call with undefined. */
export function cleanupHistorianStateFile(path: string | undefined): void {
    if (!path) return;
    try {
        unlinkSync(path);
    } catch {
        // best-effort cleanup
    }
}
