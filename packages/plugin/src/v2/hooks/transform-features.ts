import type { MagicContextPluginConfig } from "../../config";
import {
    userObservationCollectionEnabled,
    userObservationsRequested,
} from "../../features/magic-context/dreamer/task-config";
import { resolveProjectIdentityForSession } from "../../features/magic-context/memory/project-identity";
import { maybeAutoEmbedSessionBackfill } from "../../hooks/magic-context/auto-embed-session";
import { cavemanWordRulesForLanguage } from "../../hooks/magic-context/caveman";
import type { EmbedHistoryDeps } from "../../hooks/magic-context/embed-history-runner";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";

/** Use the same boot-resolved feature controls as the OpenCode 1 transform. */
export function createV2TransformFeatureDeps(
    config: MagicContextPluginConfig,
    compactionOff: boolean,
    directory: string,
    ensureProjectRegistered = ensureProjectRegisteredFromOpenCodeDirectory,
) {
    return {
        protectedTools: config.protected_tools,
        commitClusterTrigger: config.commit_cluster_trigger,
        allowHomeProject: config.allow_home_project,
        injectDocs: config.dreamer?.inject_docs !== false,
        memoryConfig: {
            enabled: config.memory.enabled,
            injectionBudgetTokens: config.memory.injection_budget_tokens,
            autoPromote: config.memory.auto_promote,
        },
        ensureProjectRegistered,
        historyBudgetPercentage: config.history_budget_percentage,
        experimentalUserMemories: userObservationCollectionEnabled(config.dreamer),
        userObservationsRequested: userObservationsRequested(config.dreamer),
        experimentalTemporalAwareness: config.temporal_awareness === true,
        muralEnabled: config.mural?.enabled === true,
        autoSearch: {
            enabled: config.memory.auto_search?.enabled ?? true,
            scoreThreshold: config.memory.auto_search?.score_threshold ?? 0.6,
            minPromptChars: config.memory.auto_search?.min_prompt_chars ?? 20,
            directory,
            ensureProjectRegistered,
            wordRules: cavemanWordRulesForLanguage(config.language),
        },
        cavemanTextCompression: compactionOff
            ? undefined
            : config.caveman_text_compression?.enabled === true
              ? {
                    enabled: true,
                    minChars: config.caveman_text_compression.min_chars ?? 500,
                    wordRules: cavemanWordRulesForLanguage(config.language),
                }
              : undefined,
    } satisfies Partial<TransformDeps>;
}

/** Share automatic drain scheduling and retry semantics with OpenCode 1 and Pi. */
export function createV2AutoEmbedSession(
    deps: EmbedHistoryDeps,
    ensureProjectRegistered = ensureProjectRegisteredFromOpenCodeDirectory,
): NonNullable<TransformDeps["maybeAutoEmbedSession"]> {
    return (sessionId, owner) => {
        const directory = deps.resolveDirectory(sessionId);
        const projectIdentity = owner
            ? owner.projectIdentity
            : resolveProjectIdentityForSession(directory, deps.allowHomeProject);
        if (!projectIdentity) return;
        maybeAutoEmbedSessionBackfill(
            {
                db: deps.db,
                projectIdentity,
                ensureRegistered: async () => {
                    await ensureProjectRegistered(directory, deps.db);
                    deps.onDirectoryResolved?.(sessionId, directory);
                },
            },
            sessionId,
        );
    };
}
