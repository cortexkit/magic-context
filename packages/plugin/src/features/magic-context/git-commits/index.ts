export type { GitCommit, ReadGitCommitsOptions } from "./git-log-reader";
export { parseGitLogOutput, readGitCommits } from "./git-log-reader";
export {
    _resetIndexerGuards,
    embedUnembeddedCommits,
    type IndexCommitsOptions,
    type IndexCommitsResult,
    indexCommitsForProject,
} from "./indexer";
export {
    type GitCommitSearchHit,
    type SearchGitCommitsOptions,
    searchGitCommitsSync,
} from "./search-git-commits";
export {
    clearProjectCommitEmbeddings,
    countEmbeddedCommits,
    loadProjectCommitEmbeddings,
    loadUnembeddedCommits,
    saveCommitEmbedding,
} from "./storage-git-commit-embeddings";
export {
    enforceProjectCap,
    evictOldestCommits,
    getCommitBySha,
    getCommitCount,
    getLatestIndexedCommitTimeMs,
    type StoredGitCommit,
    upsertCommit,
    upsertCommits,
} from "./storage-git-commits";
