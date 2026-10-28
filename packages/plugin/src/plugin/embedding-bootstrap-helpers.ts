import { createHash } from "node:crypto";

import type { EmbeddingConfig } from "../config/schema/magic-context";
import {
    getProjectEmbeddingSnapshot,
    markProjectLoadUntrusted,
    registerProjectInObservationMode,
} from "../features/magic-context/memory/embedding";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";

export type LoadOutcome =
    | "ok"
    | "project-file-parse-error"
    | "project-file-io-error"
    | "legacy-config-unmigrated"
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
    /** Exact recovered leaves, or a parent path when its entire block was replaced. */
    recoveredFieldPaths?: string[];
}

export const EMBEDDING_AFFECTING_KEYS = new Set([
    "embedding.api_key",
    "embedding.endpoint",
    "embedding.model",
    "embedding.provider",
    // input_type changes the embedding vector space (it's part of the registry's
    // identity fingerprint), and truncate changes request behavior — a failed or
    // untrusted load involving either must keep last-known-good/observation mode,
    // not let a broken value re-register mid-session.
    "embedding.input_type",
    "embedding.truncate",
    // max_input_tokens and document_prefix affect stored chunk vectors;
    // query_input_type and query_instruction affect live query vectors. A failed
    // substitution on any of them must not register a bogus runtime or model identity.
    "embedding.max_input_tokens",
    "embedding.query_input_type",
    "embedding.query_instruction",
    "embedding.document_prefix",
    "embedding.fallback_provider",
    // Runtime/dtype can select a different local vector space.
    "embedding.local_runtime",
    "embedding.local_dtype",
    "subc.connection_file",
    "shadow_embedding.enabled",
    // Recovered feature flags can activate a stale-identity GC scope.
    "memory.enabled",
    "memory.git_commit_indexing.enabled",
    // This permission controls which directory can become the project identity.
    "allow_home_project",
]);

// A `{env:VAR}` / `{file:path}` token left LITERAL in the resolved config.
// Project-level config never expands these (security), so a project that puts a
// token in an embedding field produces a literal string the registry would hash
// into a BOGUS provider/chunk identity — registering it would clear the untrusted
// latch and let GC reap the real model's vectors. Detect and treat as untrusted.
const LITERAL_CONFIG_TOKEN_RE = /\{(?:env|file):[^}]+\}/;

function affectsEmbeddingRegistration(path: string): boolean {
    return [...EMBEDDING_AFFECTING_KEYS].some(
        (field) => field === path || field.startsWith(`${path}.`),
    );
}

export function untrustedConfigFieldPaths(
    detailed: EmbeddingLoadResultDetailed<{ embedding: EmbeddingConfig }>,
): string[] {
    // Older callers may only supply root keys. A replaced parent must remain
    // untrusted because recovery can reset an identity-bearing child within it.
    const paths = (detailed.recoveredFieldPaths ?? detailed.recoveredTopLevelKeys).filter(
        affectsEmbeddingRegistration,
    );
    paths.push(
        ...detailed.substitutionFailures
            .map((failure) => failure.keyPath)
            .filter(affectsEmbeddingRegistration),
    );
    for (const [key, value] of Object.entries(detailed.config.embedding)) {
        if (typeof value === "string" && LITERAL_CONFIG_TOKEN_RE.test(value)) {
            paths.push(`embedding.${key}`);
        }
    }
    return [...new Set(paths)].sort();
}

const EMBEDDING_WARNING_TERMS = [
    "api_key",
    "endpoint",
    "model",
    "provider",
    "embedding",
    "input_type",
    "truncate",
    "subc",
    "shadow_embedding",
];
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
        detailed.sources.userConfig === "legacy-config-unmigrated" ||
        detailed.sources.projectConfig === "project-file-parse-error" ||
        detailed.sources.projectConfig === "project-file-io-error" ||
        detailed.sources.projectConfig === "legacy-config-unmigrated"
    ) {
        return true;
    }

    for (const failure of detailed.substitutionFailures) {
        if (failure.keyPath === "<unknown>" && warningLooksEmbeddingRelated(failure.message)) {
            return true;
        }
    }

    if (untrustedConfigFieldPaths(detailed).length > 0) return true;

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
    const recovered = detailed.recoveredFieldPaths ?? detailed.recoveredTopLevelKeys;
    if (recovered.length > 0) {
        parts.push(`recovered=${recovered.join(",")}`);
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
            recoveredFieldPaths: detailed.recoveredFieldPaths?.slice().sort(),
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
    // Latch the project as untrusted so the stale-identity GC is suppressed for
    // it until a trusted config re-registers. This holds whether we keep the
    // prior last-known-good registration or fall through to observation mode —
    // in both states the on-disk config is broken/mid-migration and must not
    // drive embedding deletion.
    markProjectLoadUntrusted(projectIdentity);

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
        untrustedConfigMemoryMessage(detailed),
    );
    return true;
}

function untrustedConfigMemoryMessage(
    detailed: EmbeddingLoadResultDetailed<{ embedding: EmbeddingConfig }>,
): string {
    const fields = untrustedConfigFieldPaths(detailed);
    const cause =
        fields.length > 0
            ? `has invalid embedding or project identity settings: ${fields.join(", ")}`
            : Object.values(detailed.sources).includes("legacy-config-unmigrated")
              ? "is awaiting config migration"
              : Object.values(detailed.sources).some(
                      (source) =>
                          source === "project-file-parse-error" ||
                          source === "project-file-io-error",
                  )
                ? "could not be read or parsed"
                : "has invalid embedding settings";
    return `Cross-session memory is off for this project because magic-context.jsonc ${cause}.`;
}

export function _resetEmbeddingConfigFailureLogsForTests(): void {
    loggedFailureSignatures.clear();
}
