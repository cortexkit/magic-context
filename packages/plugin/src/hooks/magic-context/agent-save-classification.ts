/**
 * Where a `ctx_memory` save happened, so the historian can score the saved memory
 * (an agent-memory classification item, see memory/turn-two-scoring.ts).
 *
 * Only an enabled lane, whose historian runs turn two, scores agent saves. A lane is
 * dormant (`resolveTurnOneLane`) until its profile is authorized, and every
 * production lane is dormant today. In that case no classification item is
 * enqueued; the background dreamer classifier scores the saved memory instead.
 */
import {
    resolveTurnOneLane,
    type TurnOneLane,
} from "../../features/magic-context/memory/turn-one-publication";
import { readRawSessionMessageOrdinalById } from "./read-session-chunk";

export interface AgentSaveLocation {
    sessionId: string;
    /** The message that carries the tool call. */
    messageId?: string;
    /** The tool call's id, unique within the session. */
    callId?: string;
}

export function agentSaveClassificationAnchor(
    location: AgentSaveLocation,
    lane?: TurnOneLane,
): { toolCallPartId: string; saveOrdinal: number } | null {
    if (resolveTurnOneLane(lane) !== "enabled") return null;
    const toolCallPartId = location.callId ?? location.messageId;
    if (!toolCallPartId || !location.messageId) return null;
    // The save ordinal S is the ordinal of the message holding the tool call; the
    // excerpt the historian scores from spans the messages around it.
    const saveOrdinal = readRawSessionMessageOrdinalById(location.sessionId, location.messageId);
    return saveOrdinal === null ? null : { toolCallPartId, saveOrdinal };
}
