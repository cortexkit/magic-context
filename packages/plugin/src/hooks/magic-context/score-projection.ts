import type { Compartment } from "../../features/magic-context/compartment-storage";
import {
    computeRescoreSourceIdentity,
    type RescoreSource,
} from "../../features/magic-context/rescore-identity";
import { getCompartments } from "../../features/magic-context/storage";
import type { Database } from "../../shared/sqlite";

/**
 * `/ctx-rescore` stages new compartment importance scores as numbered selections; it
 * never rewrites the compartment rows. This returns the highest selection number that
 * the session's cached history head (the frozen m[0] block of the prompt) was rendered
 * with. Selections above it are still pending: they show up only when the next
 * cache-rebuilding history fold renders the head again, so a rescore never causes a
 * rebuild of its own.
 */
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
 * Returns copies of the compartments carrying their latest valid scores, for the
 * example summaries the historian sees in its next prompt. The stored rows and the
 * primary session's cached history head (m[0]/m[1]) are not touched, so this read
 * can never change what the main session sends.
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
            // The caller's reference rows may be older copies, and a compartment can be
            // rewritten in place (for example by /ctx-recomp) after a score was staged
            // for it. A staged score applies only while the row's identity (its id,
            // creation time, title and summary text) still matches the row it was
            // computed for; otherwise the reference keeps its own score.
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
