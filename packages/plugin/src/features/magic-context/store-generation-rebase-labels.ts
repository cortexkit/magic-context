/** Rewrite the renderer's canonical [N] and [N-M] tokens, not arbitrary numbers. */
export function rewriteMessageLabels(
    text: string,
    resolve: (ordinal: number) => number | undefined,
): { text: string; unchanged: number } {
    let unchanged = 0;
    const rewritten = text.replace(
        /(?<!\w)(?<!\[)\[([1-9]\d*)(?:-([1-9]\d*))?\](?!\w|\]|\[|\()/g,
        (label, first: string, last: string | undefined) => {
            const start = Number(first);
            const end = last === undefined ? start : Number(last);
            if (
                !Number.isSafeInteger(start) ||
                !Number.isSafeInteger(end) ||
                (last !== undefined && end <= start)
            ) {
                return label;
            }
            const mappedStart = resolve(start);
            const mappedEnd = resolve(end);
            if (
                mappedStart === undefined ||
                mappedEnd === undefined ||
                !Number.isSafeInteger(mappedStart) ||
                !Number.isSafeInteger(mappedEnd) ||
                mappedStart < 1 ||
                mappedEnd < mappedStart
            ) {
                unchanged += 1;
                return label;
            }
            return last === undefined ? `[${mappedStart}]` : `[${mappedStart}-${mappedEnd}]`;
        },
    );
    return { text: rewritten, unchanged };
}
