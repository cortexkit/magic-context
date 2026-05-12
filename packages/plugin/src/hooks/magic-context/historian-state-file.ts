import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectMagicContextHistorianDir } from "../../shared/data-path";

/**
 * Historian state-file offloading.
 *
 * When the existing-state XML (prior compartments + facts + project memory)
 * exceeds {@link HISTORIAN_STATE_INLINE_THRESHOLD} characters, the historian
 * caller writes it to a temp file under the project-local historian dir
 * (`<project>/.opencode/magic-context/historian/`) and the prompt instructs
 * the model to `Read this file first`. This avoids pushing 100K+ chars of
 * inline reference state through the model's input on long sessions, which
 * on some provider/model combinations (notably github-copilot/gpt-5.4 via
 * the openai-responses API) causes the model to stall before emitting any
 * output tokens.
 *
 * The state file lives INSIDE the project directory rather than under
 * `os.tmpdir()` because OpenCode's `external_directory` permission system
 * asks the user before letting the historian subagent's Read tool open any
 * file outside the project. Anchoring under `<project>/.opencode/` keeps
 * the file inside the project boundary so historian runs never trigger a
 * permission prompt.
 *
 * The caller MUST delete the file in finally{} via
 * {@link cleanupHistorianStateFile}.
 *
 * Shared between OpenCode (`compartment-runner-incremental.ts`,
 * `compartment-runner-recomp.ts`) and Pi (`pi-historian-runner.ts`). The
 * directory is resolved from the project directory the caller passes in —
 * both harnesses already track this on their runner deps.
 */
export const HISTORIAN_STATE_INLINE_THRESHOLD = 30_000;

/**
 * When existingState is large, write it to a project-local file and return the
 * path. Returns undefined when existingState is small enough to inline OR when
 * writing fails (in which case the caller should fall back to inline).
 *
 * `directory` is the project directory; the helper writes under
 * `<directory>/.opencode/magic-context/historian/`. The dir is created
 * recursively on first write, so the call is safe on fresh projects that have
 * never had a `.opencode/` subtree.
 */
export function maybeWriteHistorianStateFile(
    sessionId: string,
    existingState: string,
    directory: string,
): string | undefined {
    if (existingState.length <= HISTORIAN_STATE_INLINE_THRESHOLD) return undefined;
    try {
        const dir = getProjectMagicContextHistorianDir(directory);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `state-${sessionId}-${Date.now()}.xml`);
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
