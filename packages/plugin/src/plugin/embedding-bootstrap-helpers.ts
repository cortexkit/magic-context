import { createHash } from "node:crypto";

import type { EmbeddingConfig } from "../config/schema/magic-context";
import {
    getProjectEmbeddingSnapshot,
    registerProjectInObservationMode,
} from "../features/magic-context/memory/embedding";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";

export type LoadOutcome =
    | "ok"
    | "project-file-parse-error"
    | "project-file-io-error"
    | "schema-recovery"
    | "substitution-failure";

export interface EmbeddingLoadResultDetailed<TConfig extends { embedding: EmbeddingConfig }> {
    config: TConfig;
    loadOutcome: LoadOutcome;
    sources: {
        userConfig: LoadOutcome;
        projectConfig: LoadOutcome;
    };
    substitutionFailures: Array<{ keyPath: string; source: "user" | "project"; message: string }>;
    recoveredTopLevelKeys: string[];
}

export const EMBEDDING_AFFECTING_KEYS = new Set([
    "embedding.api_key",
    "embedding.endpoint",
    "embedding.model",
    "embedding.provider",
]);

export const EMBEDDING_AFFECTING_TOP_LEVEL_KEYS = new Set(["embedding", "memory", "experimental"]);

const EMBEDDING_WARNING_TERMS = ["api_key", "endpoint", "model", "provider", "embedding"];
const loggedFailureSignatures = new Map<string, Set<string>>();

function sha256Prefix(value: string, length = 16): string {
    return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function warningLooksEmbeddingRelated(message: string): boolean {
    const lower = message.toLowerCase();
    return EMBEDDING_WARNING_TERMS.some((term) => lower.includes(term));
}

export function isConfigLoadUntrusted(
    detailed: EmbeddingLoadResultDetailed<{ embedding: EmbeddingConfig }>,
): boolean {
    if (
        detailed.sources.userConfig === "project-file-parse-error" ||
        detailed.sources.userConfig === "project-file-io-error" ||
        detailed.sources.projectConfig === "project-file-parse-error" ||
        detailed.sources.projectConfig === "project-file-io-error"
    ) {
        return true;
    }

    for (const failure of detailed.substitutionFailures) {
        if (EMBEDDING_AFFECTING_KEYS.has(failure.keyPath)) {
            return true;
        }
        if (failure.keyPath === "<unknown>" && warningLooksEmbeddingRelated(failure.message)) {
            return true;
        }
    }

    for (const recoveredKey of detailed.recoveredTopLevelKeys) {
        if (EMBEDDING_AFFECTING_TOP_LEVEL_KEYS.has(recoveredKey)) {
            return true;
        }
    }

    return false;
}

export function describeFailure(
    detailed: EmbeddingLoadResultDetailed<{ embedding: EmbeddingConfig }>,
): string {
    const parts: string[] = [];
    for (const [source, outcome] of Object.entries(detailed.sources)) {
        if (outcome !== "ok") {
            parts.push(`${source}=${outcome}`);
        }
    }
    if (detailed.substitutionFailures.length > 0) {
        parts.push(
            `substitution=${detailed.substitutionFailures
                .map((failure) => `${failure.source}:${failure.keyPath}`)
                .join(",")}`,
        );
    }
    if (detailed.recoveredTopLevelKeys.length > 0) {
        parts.push(`recovered=${detailed.recoveredTopLevelKeys.join(",")}`);
    }
    return parts.length > 0 ? parts.join("; ") : detailed.loadOutcome;
}

export function logConfigFailureOnce(
    projectIdentity: string,
    detailed: EmbeddingLoadResultDetailed<{ embedding: EmbeddingConfig }>,
): void {
    const signature = sha256Prefix(
        JSON.stringify({
            outcomes: detailed.sources,
            substitutions: detailed.substitutionFailures
                .map((failure) => `${failure.source}:${failure.keyPath}:${failure.message}`)
                .sort(),
            recoveredTopLevelKeys: [...detailed.recoveredTopLevelKeys].sort(),
        }),
    );
    const existing = loggedFailureSignatures.get(projectIdentity) ?? new Set<string>();
    if (existing.has(signature)) return;
    existing.add(signature);
    loggedFailureSignatures.set(projectIdentity, existing);
    log(
        `[mc][embedding] config load untrusted, preserving last-known-good for ${projectIdentity} — ${describeFailure(detailed)}`,
    );
}

export function handleUntrustedLoad(
    db: Database,
    projectIdentity: string,
    directory: string,
    detailed: EmbeddingLoadResultDetailed<{ embedding: EmbeddingConfig }>,
): boolean {
    const prior = getProjectEmbeddingSnapshot(projectIdentity);
    if (prior && !prior.runtimeFingerprint.startsWith("observation:")) {
        logConfigFailureOnce(projectIdentity, detailed);
        return true;
    }

    registerProjectInObservationMode(
        db,
        projectIdentity,
        directory,
        detailed.config.embedding,
        describeFailure(detailed),
    );
    return true;
}

export function _resetEmbeddingConfigFailureLogsForTests(): void {
    loggedFailureSignatures.clear();
}
