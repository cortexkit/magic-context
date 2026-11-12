import type { Database } from "../../shared/sqlite";
import { type ReplayDocument, readReplayEnvelope } from "./storage-replay-document";

/**
 * Whether this session serves OpenCode 2 instruction rows that its history
 * summary already covers.
 *
 * OpenCode 2 stores instruction updates (the daily date line, a changed
 * AGENTS.md) as `system` rows and sends them without a message id. A history
 * summary is not proof that such an instruction survived, so every trim keeps
 * them. Sessions served before that rule cut a covered instruction row on most
 * passes; turning the rule on changes what they serve, so the switch is only
 * set on a pass that may rewrite the whole served prefix, and every later pass
 * reads it. Stored as its own namespace in the per-session replay document, so
 * no schema change is needed.
 */
const NAMESPACE = "hostInstructionRetention";

let enabled = true;

/** False only in tests that reproduce the serving of releases before this switch existed. */
export function hostInstructionRetentionEnabled(): boolean {
    return enabled;
}

export function setHostInstructionRetentionEnabledForTests(value: boolean): void {
    enabled = value;
}

export function isHostInstructionRetentionOn(db: Database, sessionId: string): boolean {
    const lane = readReplayEnvelope(db, sessionId)[NAMESPACE];
    return typeof lane === "object" && lane !== null && (lane as { on?: unknown }).on === true;
}

/**
 * Add a pass's instruction-row decisions to `doc`, the session's replay
 * document: the switch when `retention` is set, and whatever `record` adds (the
 * instruction rows the pass retires). The caller saves them in the same update
 * as the pass's other replay records, so a pass never saves one without the
 * other. False when the document already holds them.
 */
export function recordHostInstructionDecisions(
    doc: ReplayDocument,
    decisions: { retention: boolean; record?: (doc: ReplayDocument) => boolean },
): boolean {
    let changed = decisions.record?.(doc) ?? false;
    const lane = doc[NAMESPACE];
    if (
        decisions.retention &&
        !(typeof lane === "object" && lane !== null && (lane as { on?: unknown }).on === true)
    ) {
        doc.version = 2;
        doc[NAMESPACE] = { on: true };
        changed = true;
    }
    return changed;
}
