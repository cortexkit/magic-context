import type {
    Compartment,
    CompartmentInput,
} from "../../features/magic-context/compartment-storage";

/** Carry the saved summary payload into a replacement set at a new sequence. */
export function compartmentToInput(c: Compartment, sequence: number): CompartmentInput {
    return {
        sequence,
        startMessage: c.startMessage,
        endMessage: c.endMessage,
        startMessageId: c.startMessageId,
        endMessageId: c.endMessageId,
        startBlockIndex: c.startBlockIndex,
        endBlockIndex: c.endBlockIndex,
        title: c.title,
        content: c.content,
        p1: c.p1,
        p2: c.p2,
        p3: c.p3,
        p4: c.p4,
        importance: c.importance,
        episodeType: c.episodeType,
    };
}
