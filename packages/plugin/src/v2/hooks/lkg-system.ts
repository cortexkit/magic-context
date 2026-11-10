import { createHash } from "node:crypto";
import type { LkgSlot } from "../../hooks/magic-context/lkg-slot";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { SessionContext, V2Message } from "./types";

type System = SessionContext["system"];
function identity(slot: LkgSlot): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                capturedAt: slot.capturedAt,
                captureSequence: slot.captureSequence,
                rowVersion: slot.rowVersion,
                modelKey: slot.modelKey,
                providerKey: slot.providerKey,
                inputIdSeq: slot.inputIdSeq,
                inputContentDigests: slot.inputContentDigests,
            }),
        )
        .update(slot.jsonPrefix)
        .digest("hex");
}

/**
 * The host checkpoint message a request was served with after a host fold, and
 * the summary text that the head message's baseline replaced inside it. A
 * replay puts the same checkpoint in front of the saved messages, so the
 * request starts with the bytes the saved request started with.
 */
export interface V2LkgCheckpointHead {
    checkpoint: V2Message;
    submitted: string;
    /** The history head recorded for a checkpoint that stores the note in
     * place of its head; absent when the stored text is the head itself. */
    head?: string;
}

/**
 * What the host handed the pass besides the messages the saved copy binds by
 * id and digest: its own system prompt and, after a host fold, its checkpoint
 * message (which the restore takes out of the messages, so no message digest
 * covers it).
 */
export interface V2LkgHostInput {
    system: System;
    checkpoint: V2Message | null;
}

/**
 * A message snapshot may replay only with the system and checkpoint head that
 * were served alongside it, and only when the host sent the same system prompt
 * and checkpoint message it sent then.
 */
export class V2LkgSystemReplay {
    private readonly systems = new BoundedSessionMap<{
        slot: string;
        input: string;
        served: System;
        head: V2LkgCheckpointHead | null;
    }>(1000);

    capture(
        sessionId: string,
        slot: LkgSlot,
        input: V2LkgHostInput,
        served: System,
        head: V2LkgCheckpointHead | null,
    ): void {
        this.systems.set(sessionId, {
            slot: identity(slot),
            input: hostInputKey(input),
            served: structuredClone(served),
            head: head ? structuredClone(head) : null,
        });
    }

    /**
     * Put the served system into `target` and return the checkpoint head to
     * apply (null when the saved request had none), or undefined when the saved
     * copy may not replay for this input.
     */
    restore(
        sessionId: string,
        slot: LkgSlot | undefined,
        input: V2LkgHostInput,
        target: System,
    ): { head: V2LkgCheckpointHead | null } | undefined {
        const saved = this.systems.get(sessionId);
        // Slot reads return copies. Match their content identity, not object identity.
        // After restart, the system served with the snapshot is unknown. A
        // successful transform must capture the system and messages together again.
        if (!slot || !saved || saved.slot !== identity(slot) || saved.input !== hostInputKey(input))
            return undefined;
        target.splice(0, target.length, ...structuredClone(saved.served));
        return { head: saved.head ? structuredClone(saved.head) : null };
    }
}

function hostInputKey(input: V2LkgHostInput): string {
    return JSON.stringify({ system: input.system, checkpoint: input.checkpoint });
}
