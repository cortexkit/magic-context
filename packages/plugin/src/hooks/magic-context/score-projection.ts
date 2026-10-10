import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    computeRescoreSourceIdentity,
    type RescoreSource,
} from "../../features/magic-context/rescore-identity";
import { getCompartments } from "../../features/magic-context/storage";
import type { Database } from "../../shared/sqlite";

/** Highest score-selection sequence included in the persisted m[0] bytes. */
export function readAppliedScoreWatermark(db: Database, sessionId: string): number {
    const row = db
        .prepare(
            "SELECT cached_m0_score_selection_watermark AS watermark FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { watermark: number } | null;
    return row?.watermark ?? 0;
}

interface SelectedScore {
    compartment_id: number;
    source_identity: string | null;
    new_importance: number | null;
}

/**
 * Project scores onto copies only. Call inside the input-acquisition transaction
 * so base rows, selected revision rows and the highest selection sequence share
 * a database snapshot. Undo to base or a source-identity mismatch uses the base
 * score, never the score from an earlier selection.
 */
export function projectCompartmentScores<T extends RescoreSource>(
    db: Database,
    sessionId: string,
    compartments: readonly T[],
    selector: "latest" | number,
): { compartments: T[]; watermark: number } {
    const watermark =
        selector === "latest"
            ? (
                  db
                      .prepare(
                          "SELECT COALESCE(MAX(sequence), 0) AS watermark FROM compartment_score_selections WHERE session_id = ?",
                      )
                      .get(sessionId) as { watermark: number }
              ).watermark
            : selector;
    if (watermark === 0)
        return { compartments: compartments.map((row) => ({ ...row })), watermark };
    const selections = db
        .prepare(`
        SELECT s.compartment_id, r.source_identity, r.new_importance
        FROM compartment_score_selections s
        LEFT JOIN compartment_score_revisions r
            ON r.id = s.revision_id AND r.session_id = s.session_id
                AND r.compartment_id = s.compartment_id
        WHERE s.session_id = ? AND s.sequence <= ?
            AND s.sequence = (
                SELECT MAX(latest.sequence) FROM compartment_score_selections latest
                WHERE latest.session_id = s.session_id
                    AND latest.compartment_id = s.compartment_id AND latest.sequence <= ?
            )
    `)
        .all(sessionId, watermark, watermark) as SelectedScore[];
    const byId = new Map(selections.map((selection) => [selection.compartment_id, selection]));
    return {
        watermark,
        compartments: compartments.map((row) => {
            const selection = byId.get(row.id);
            const importance =
                selection?.new_importance != null &&
                selection.source_identity === computeRescoreSourceIdentity(row)
                    ? selection.new_importance
                    : row.importance;
            return { ...row, importance };
        }),
    };
}

/**
 * Copy compartments with their latest valid scores for examples in the historian's
 * next summary prompt. This does not update the primary agent's cached m[0]/m[1].
 */
export function readEffectiveReferenceCompartments(
    db: Database,
    sessionId: string,
    sources?: readonly Compartment[],
): Compartment[] {
    return db
        .transaction(() => {
            const raw = getCompartments(db, sessionId);
            const projected = projectCompartmentScores(db, sessionId, raw, "latest").compartments;
            if (!sources) return projected;
            // A retained or staged reference can predate a source rewrite. Only use a
            // score if its full creation/source identity still belongs to that row.
            const scores = new Map(
                raw.map((row, i) => [computeRescoreSourceIdentity(row), projected[i].importance]),
            );
            return sources.map((row) => ({
                ...row,
                importance: scores.get(computeRescoreSourceIdentity(row)) ?? row.importance,
            }));
        })
        .deferred();
}
