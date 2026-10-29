import type { MagicContextConfig } from "./schema/magic-context";

type CommitIndexing = MagicContextConfig["memory"]["git_commit_indexing"];
const pausedRetention = new WeakSet<CommitIndexing>();
const RETENTION_FIELD = "memory.git_commit_indexing.max_commits";

/** Keep a defaulted cap useful for bounded reads without letting it delete stored history. */
export function applyCommitRetentionRecovery(
    config: MagicContextConfig,
    recoveredFieldPaths: readonly string[],
    warnings: string[],
): void {
    if (
        !recoveredFieldPaths.some(
            (path) => RETENTION_FIELD === path || RETENTION_FIELD.startsWith(`${path}.`),
        )
    )
        return;
    pausedRetention.add(config.memory.git_commit_indexing);
    const message = `${RETENTION_FIELD}: retention eviction is paused until the invalid value is fixed.`;
    const index = warnings.findIndex((warning) => warning.includes(RETENTION_FIELD));
    if (index >= 0) warnings[index] = `${warnings[index]} ${message}`;
    else warnings.push(message);
}

export function isCommitRetentionPaused(settings: CommitIndexing): boolean {
    return pausedRetention.has(settings);
}

/** Live sampling copies settings objects; recovery state must follow the sampled cap. */
export function copyCommitRetentionRecovery(from: CommitIndexing, to: CommitIndexing): void {
    if (pausedRetention.has(from)) pausedRetention.add(to);
    else pausedRetention.delete(to);
}
