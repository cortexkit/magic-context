import { createHash } from "node:crypto";
import type { V2Context, V2Message } from "../hooks/types";

export const foldDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export interface FoldIdentity {
    watermark: number;
    cutSeq?: number;
    submitted: string;
    submittedSha: string;
    rendered?: V2Message;
    renderedSha?: string;
    renderedSummary?: string;
    withoutRecentContext?: string;
    rejectedSha?: string;
    reason?: "host_rerender" | "host_cut_before_watermark" | "boot_recovery";
}

/** A host checkpoint has two identities: our submitted summary and its rendered wrapper.
 * GA provider compaction dispatches the hook before Started (mime-hxnftcv1.js:385/387);
 * the projector assigns seq from the later event (mime-26m96hf0.js:252-260).
 * Never predict that seq: persist a provisional source watermark, then bind the actual row.
 */
export class FoldOwner {
    private readonly pending = new Map<string, Promise<unknown>>();
    constructor(private readonly storage: V2Context["storage"]) {}
    private async serial<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.pending.get(sessionID) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        this.pending.set(sessionID, next);
        try {
            return await next;
        } finally {
            if (this.pending.get(sessionID) === next) this.pending.delete(sessionID);
        }
    }
    private key(sessionID: string) {
        return `fold/v1/${sessionID}`;
    }
    async read(sessionID: string): Promise<FoldIdentity | undefined> {
        return (await this.storage.get(this.key(sessionID))) as FoldIdentity | undefined;
    }
    async supply(args: {
        sessionID: string;
        watermark: number;
        runningCut?: number;
        materialize: () => string;
    }): Promise<FoldIdentity> {
        return this.serial(args.sessionID, async () => {
            const previous = await this.read(args.sessionID);
            const same =
                previous &&
                (args.runningCut !== undefined
                    ? previous.cutSeq === args.runningCut
                    : previous.cutSeq === undefined && previous.watermark === args.watermark);
            if (same) return previous;
            const submitted = args.materialize();
            const next: FoldIdentity = {
                watermark: args.watermark,
                cutSeq: args.runningCut,
                submitted,
                submittedSha: foldDigest(submitted),
            };
            await this.storage.set(this.key(args.sessionID), next);
            return next;
        });
    }
    async observe(args: {
        sessionID: string;
        cutSeq: number;
        summary: string;
        rendered: V2Message;
        onHard: (reason: NonNullable<FoldIdentity["reason"]>) => void;
    }): Promise<FoldIdentity> {
        return this.serial(args.sessionID, async () => {
            let state = await this.read(args.sessionID);
            // Discard a saved rendered checkpoint with a different message ID,
            // even if a revert lets the host reuse its sequence number.
            if (state?.rendered && state.rendered.id !== args.rendered.id) state = undefined;
            let changed = !state;
            const observedSha = foldDigest(JSON.stringify(args.rendered));
            const rendered = structuredClone(args.rendered);
            if (state?.withoutRecentContext && state.withoutRecentContext === rendered.id)
                stripCheckpointRecentContext(rendered, args.summary);
            const renderedSha = foldDigest(JSON.stringify(rendered));
            // An already-persisted checkpoint can predate the plugin's storage commit.
            // Recover its two identities without draining any pending operation twice.
            if (!state) {
                args.onHard("boot_recovery");
                state = {
                    watermark: args.cutSeq,
                    submitted: args.summary,
                    submittedSha: foldDigest(args.summary),
                    reason: "boot_recovery",
                };
            }
            const reason =
                args.cutSeq < state.watermark
                    ? "host_cut_before_watermark"
                    : state.submittedSha !== foldDigest(args.summary) ||
                        (state.renderedSha && state.renderedSha !== renderedSha)
                      ? "host_rerender"
                      : undefined;
            if (reason && state.rejectedSha !== observedSha) {
                args.onHard(reason);
                state.reason = reason;
                state.rejectedSha = observedSha;
                changed = true;
            }
            if (state.cutSeq === undefined && args.cutSeq >= state.watermark) {
                state.cutSeq = args.cutSeq;
                changed = true;
            }
            if (!state.rendered && reason !== "host_cut_before_watermark") {
                state.rendered = rendered;
                state.renderedSha = renderedSha;
                state.renderedSummary = args.summary;
                changed = true;
            }
            if (changed) await this.storage.set(this.key(args.sessionID), state);
            return state;
        });
    }

    async stripRecentContext(
        sessionID: string,
        checkpointID: string,
    ): Promise<FoldIdentity | undefined> {
        return this.serial(sessionID, async () => {
            const state = await this.read(sessionID);
            if (!state?.rendered || state.rendered.id !== checkpointID) return undefined;
            if (state.withoutRecentContext === checkpointID) return state;
            if (
                !stripCheckpointRecentContext(
                    state.rendered,
                    state.renderedSummary ?? state.submitted,
                )
            )
                return state;
            state.withoutRecentContext = checkpointID;
            state.renderedSha = foldDigest(JSON.stringify(state.rendered));
            // Keep rejection identity tied to the original host input. Trimming
            // the stored wrapper must not repeat its hard-rejection callback.
            await this.storage.set(this.key(sessionID), state);
            return state;
        });
    }
}

/** Remove the host's rendered recent transcript, preserving the supplied summary. */
export function stripCheckpointRecentContext(message: V2Message, summary: string): boolean {
    let changed = false;
    for (const part of message.content) {
        if (part.type !== "text" || typeof part.text !== "string") continue;
        const summaryStart = part.text.indexOf("<summary>");
        if (summaryStart < 0) continue;
        const summaryText = part.text.indexOf(summary, summaryStart + "<summary>".length);
        if (summaryText < 0) continue;
        const start =
            part.text.indexOf("</summary>", summaryText + summary.length) + "</summary>".length;
        const end = part.text.lastIndexOf("</conversation-checkpoint>");
        if (start < "</summary>".length || end < start) continue;
        const suffix = part.text.slice(start, end);
        if (!/^\s*<recent-context>[\s\S]*<\/recent-context>\s*$/.test(suffix)) continue;
        part.text = `${part.text.slice(0, start)}\n${part.text.slice(end)}`;
        changed = true;
    }
    if (changed && message.metadata && typeof message.metadata === "object") {
        const metadata = { ...(message.metadata as Record<string, unknown>) };
        // The host also carries its derived transcript outside the text part.
        // It must not survive in the saved checkpoint after the text is removed.
        delete metadata.recent;
        message.metadata = metadata;
    }
    return changed;
}
