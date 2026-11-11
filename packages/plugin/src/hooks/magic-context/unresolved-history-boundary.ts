import type { Database } from "../../shared/sqlite";
import { renderUserFacingFailure } from "../../shared/user-facing-codes";
import type { PrefixTrimRefusal } from "./inject-compartments";
import { hasRawSessionMessageById } from "./read-session-chunk";

/** A summary boundary omitted from a request is missing only if the store no longer holds its row. */
export function storedHistoryBoundaryPresence(
    db: Database,
    sessionId: string,
): boolean | undefined {
    try {
        const row = db
            .prepare(
                "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { id?: string | null } | undefined;
        return row?.id ? hasRawSessionMessageById(sessionId, row.id) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Why the summarized history could not be cut out of the request: the prefix
 * trim's own reason, or a boundary row the host store no longer holds (the
 * history-boundary repair re-anchors that one on a later pass).
 */
export type HistoryBoundaryRefusalCause = PrefixTrimRefusal | "boundary-missing-from-store";

/**
 * What changes the state on the next send. `send-again`: overflow recovery is
 * armed or still making progress, so the next pass summarizes and drops more.
 * `flush`: recovery already ran on this state and could not make room, or the
 * request size could not be measured with confidence.
 */
export type HistoryBoundaryRefusalRemedy = "send-again" | "flush";

const CAUSE_SENTENCES: Record<HistoryBoundaryRefusalCause, string> = {
    "unidentified-message":
        "The conversation holds a message without an id (often one added by another plugin), so Magic Context could not tell which messages its history summary already covers.",
    "boundary-not-in-request":
        "The message the history summary ends on is in the host's store but not in the loaded conversation, so Magic Context could not tell which loaded messages the summary already covers.",
    "boundary-unordered":
        "The message the history summary ends on is not in the loaded conversation, and the host's store could not place it in order against the messages that are.",
    "boundary-missing-from-store":
        "The message the history summary ends on is no longer in the host's store.",
};

/** The text a person sees for this refusal, on every platform alike. */
export function historyBoundaryRefusalText(
    cause: HistoryBoundaryRefusalCause | undefined,
    remedy: HistoryBoundaryRefusalRemedy,
): string {
    const failure = renderUserFacingFailure(
        remedy === "send-again" ? "history_boundary_recovering" : "history_boundary_unresolved",
        "plain",
    );
    return cause ? `${CAUSE_SENTENCES[cause]} ${failure}` : failure;
}

/**
 * The transform could not cut the conversation at the history boundary, and
 * the uncut request is larger than the model's context window. Sending it
 * would only earn a provider rejection, so the pass stops here: the messages
 * wrapper replays the last good request when it can and otherwise refuses the
 * turn with this message.
 */
export class UnresolvedHistoryBoundaryError extends Error {
    readonly code = "UNRESOLVED_HISTORY_BOUNDARY";
    readonly recoverable = true;

    constructor(
        readonly estimatedTokens: number,
        readonly contextLimitTokens: number,
        readonly refusalCause?: HistoryBoundaryRefusalCause,
        readonly remedy: HistoryBoundaryRefusalRemedy = "flush",
    ) {
        super(historyBoundaryRefusalText(refusalCause, remedy));
        this.name = "UnresolvedHistoryBoundaryError";
    }
}

/** The cause a person is told: a missing boundary row outranks the trim's own reason. */
export function historyBoundaryRefusalCause(
    trimRefusal: PrefixTrimRefusal | null | undefined,
    boundaryInStore: boolean | undefined,
): HistoryBoundaryRefusalCause | undefined {
    if (boundaryInStore === false) return "boundary-missing-from-store";
    return trimRefusal ?? undefined;
}
