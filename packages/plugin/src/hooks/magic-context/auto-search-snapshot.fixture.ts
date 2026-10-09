import type { getProjectEmbeddingSnapshot } from "../../features/magic-context/memory/embedding";

/** A registered owner snapshot with no actual endpoint or credentials. */
export function autoSearchTestSnapshot(
    projectIdentity: string,
): NonNullable<ReturnType<typeof getProjectEmbeddingSnapshot>> {
    return {
        projectIdentity,
        sourceDirectory: "/synthetic-project",
        providerIdentity: "fixture-provider",
        runtimeFingerprint: "fixture-runtime",
        generation: 1,
        features: { memoryEnabled: true, gitCommitEnabled: false },
        enabled: true,
        historyEnabled: true,
        gitCommitEnabled: false,
        modelId: "fixture-provider",
        chunkModelId: "fixture-chunks",
        model: "fixture",
        provider: "local",
    };
}
