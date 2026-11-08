export const CTX_REDUCE_DESCRIPTION = `Stamp an item on your desk as no longer needed for the work ahead. Not a delete: stamping QUEUES it, the item stays fully readable until Magic Context clears stamped items in one sweep, and the newest tags are protected so stamping recent output is harmless. A cleared item goes to the archive — a recent one leaves a \`[dropped §N§]\` placeholder, an older one leaves nothing — and \`ctx_expand(tag=N)\` is the way back. So the question before stamping is not "have I finished reading this?" but "does this need to stay on my desk for what comes next?" — a file you read and will keep editing stays; the grep that found it goes.

Stamp: file reads, search results and tool outputs the work ahead no longer needs; build/test output after you acted on it; repeated or redundant dumps; data written to disk; status/log output that only confirmed what you expected; a large block pasted inside a user message once you have used it; a notice in a \`<system-reminder>\` block (an inbox wake, a room digest, a worker's result) once you have acted on it.
Keep: the user's own messages (never stamp one for its directive), a notice that holds the user's answer to your question, your own conversation text, unresolved errors, raw evidence you haven't extracted yet, and outputs whose exact wording may still matter.

Look at each tag before stamping it; never blanket-stamp a range like "1-50". Many small targeted stamps beat one sweep. \`drop\` accepts "3-5", "1,2,9", "1-5,8,12-15".`;

export function formatCtxReduceReply(stampedCount: number, selfStampCount = 0): string {
    const parts: string[] = [];
    if (stampedCount > 0) {
        parts.push(`${stampedCount} tag${stampedCount === 1 ? "" : "s"} stamped.`);
    }
    if (selfStampCount > 0) {
        parts.push(
            selfStampCount === 1
                ? "1 was a ctx_reduce call; leave those alone, they are cleaned up automatically."
                : `${selfStampCount} were ctx_reduce calls; leave those alone, they are cleaned up automatically.`,
        );
    }
    return parts.join(" ");
}
