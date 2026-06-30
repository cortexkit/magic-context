import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    buildCanonicalChunkTextFromFts,
    buildCompartmentSummaryFallbackText,
    canonicalizeInMemoryChunkTextForEmbedding,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    replaceCompartmentChunkEmbeddings,
    type SaveCompartmentChunkEmbeddingInput,
} from "./compartment-chunk-embedding";
import {
    embedBatchForProject,
    getProjectChunkEmbeddingModelId,
    getProjectEmbeddingMaxInputTokens,
} from "./project-embedding-registry";

/**
 * Compartment chunk embedding (v2).
 *
 * Each compartment's raw `[ordinal] U:/A:` conversational text (TC: tool
 * summaries stripped) is embedded — whole-compartment when it fits the
 * provider's input window, otherwise windowed — and stored in
 * `compartment_chunk_embeddings`. This is the semantic substrate for ctx_search
 * over session history.
 *
 * The older per-compartment `p1_embedding` (summary vector) was retired once
 * chunk embeddings landed: it had no remaining reader (search uses chunks), and
 * the only prospective consumer — dreamer cross-compartment linking — does not
 * exist yet and can derive its own representation when built. The
 * `compartments.p1_embedding` column is left inert; dreamer v2 decides whether
 * to repopulate or drop it.
 *
 * Fire-and-forget + best-effort: a missing/slow embedding provider must never
 * block or fail a historian publish. Gated by `memory.enabled` so a memory-off
 * user never hits the embedding endpoint.
 */

export interface CompartmentChunkToEmbed {
    id: number;
    startMessage: number;
    endMessage: number;
    /** Optional publish-time chunk text. When present, TC: tool summaries are stripped. */
    sourceChunkText?: string;
}

export async function embedAndStoreCompartmentChunks(
    db: Database,
    sessionId: string,
    projectPath: string,
    compartments: readonly CompartmentChunkToEmbed[],
): Promise<void> {
    if (compartments.length === 0) return;
    const maxInputTokens = getProjectEmbeddingMaxInputTokens(projectPath);

    for (const compartment of compartments) {
        try {
            const fromMemory = compartment.sourceChunkText
                ? canonicalizeInMemoryChunkTextForEmbedding(
                      compartment.sourceChunkText,
                      compartment.startMessage,
                      compartment.endMessage,
                  )
                : "";
            const canonicalText =
                fromMemory ||
                buildCanonicalChunkTextFromFts(
                    db,
                    sessionId,
                    compartment.startMessage,
                    compartment.endMessage,
                ) ||
                buildCompartmentSummaryFallbackText(db, compartment.id);
            if (canonicalText.length === 0) continue;

            const windows = chunkCanonicalText(
                canonicalText,
                compartment.startMessage,
                compartment.endMessage,
                maxInputTokens,
            );
            if (windows.length === 0) continue;

            const currentModelId = getProjectChunkEmbeddingModelId(projectPath);
            if (
                currentModelId !== "off" &&
                chunkEmbeddingWindowsAreCurrent(
                    db,
                    compartment.id,
                    currentModelId,
                    windows,
                    projectPath,
                )
            ) {
                continue;
            }

            const result = await embedBatchForProject(
                projectPath,
                windows.map((window) => window.text),
            );
            if (!result) continue;
            if (
                chunkEmbeddingWindowsAreCurrent(
                    db,
                    compartment.id,
                    currentModelId,
                    windows,
                    projectPath,
                )
            ) {
                continue;
            }

            const rows: SaveCompartmentChunkEmbeddingInput[] = [];
            for (const [index, window] of windows.entries()) {
                const vector = result.vectors[index];
                if (!vector) continue;
                rows.push({
                    compartmentId: compartment.id,
                    sessionId,
                    projectPath,
                    window,
                    modelId: currentModelId,
                    vector,
                });
            }
            if (rows.length === windows.length) {
                replaceCompartmentChunkEmbeddings(db, rows);
            }
        } catch (error) {
            sessionLog(
                sessionId,
                `compartment chunk embedding failed for compartment ${compartment.id}:`,
                error,
            );
        }
    }
}
