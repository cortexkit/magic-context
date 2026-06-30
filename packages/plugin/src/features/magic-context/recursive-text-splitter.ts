/**
 * Minimal synchronous port of LangChain's `RecursiveCharacterTextSplitter`.
 *
 * Vendored (not depended on) so the plugin install stays lean and free of the
 * supply-chain surface of the full `@langchain/textsplitters` package (whose
 * bundled dist tripped an org Socket "obfuscated code" alert — a false positive
 * on minified output, but a policy blocker). We only need the recursive
 * character split for one job: cutting a single oversized canonical line down
 * to a token budget. The Document/metadata/language-preset/token machinery in
 * the upstream package is irrelevant here, so this keeps just the core
 * algorithm (`splitOnSeparator` + `mergeSplits` + `_splitText`) and makes it
 * synchronous (our `lengthFunction` is a sync tokenizer).
 *
 * Algorithm and separator hierarchy ported faithfully from
 * `@langchain/textsplitters` v1.0.1 (`text_splitter.ts`), MIT-licensed
 * (LangChain, Inc.). Behavior matches upstream for `keepSeparator: false`,
 * `chunkOverlap: 0`, which is all this call site uses.
 */

/** Length of a piece of text, in whatever unit the caller measures (tokens). */
export type LengthFunction = (text: string) => number;

export interface RecursiveCharacterSplitOptions {
    /** Max length (in `lengthFunction` units) of an emitted chunk. */
    chunkSize: number;
    /** Length function; defaults to character count. */
    lengthFunction?: LengthFunction;
    /** Separator hierarchy, tried in order; "" means split into characters. */
    separators?: string[];
}

const DEFAULT_SEPARATORS = ["\n\n", "\n", " ", ""];

function splitOnSeparator(text: string, separator: string): string[] {
    const splits = separator ? text.split(separator) : text.split("");
    return splits.filter((s) => s !== "");
}

/**
 * Greedily pack `splits` into chunks no larger than `chunkSize` (measured by
 * `lengthFunction`), joining with `separator`. Ported from upstream
 * `mergeSplits` with `chunkOverlap = 0` (so the overlap shift loop reduces to
 * "drain currentDoc once the running total exceeds the budget").
 */
function mergeSplits(
    splits: string[],
    separator: string,
    chunkSize: number,
    lengthFunction: LengthFunction,
): string[] {
    const docs: string[] = [];
    const currentDoc: string[] = [];
    let total = 0;
    const joinDocs = (docsToJoin: string[]): string | null => {
        const joined = docsToJoin.join(separator).trim();
        return joined === "" ? null : joined;
    };
    for (const d of splits) {
        const len = lengthFunction(d);
        if (total + len + currentDoc.length * separator.length > chunkSize) {
            if (currentDoc.length > 0) {
                const doc = joinDocs(currentDoc);
                if (doc !== null) docs.push(doc);
                // chunkOverlap = 0: upstream's drain loop condition
                // `while (total > chunkOverlap || ...)` reduces to `while (total > 0)`,
                // i.e. fully flush the accumulated window before starting the next.
                while (total > 0 && currentDoc.length > 0) {
                    total -= lengthFunction(currentDoc[0]);
                    currentDoc.shift();
                }
            }
        }
        currentDoc.push(d);
        total += len;
    }
    const doc = joinDocs(currentDoc);
    if (doc !== null) docs.push(doc);
    return docs;
}

function splitTextRecursive(
    text: string,
    separators: string[],
    chunkSize: number,
    lengthFunction: LengthFunction,
): string[] {
    const finalChunks: string[] = [];
    // Pick the finest separator that occurs in `text`; "" forces a char split.
    let separator = separators[separators.length - 1];
    let newSeparators: string[] | undefined;
    for (let i = 0; i < separators.length; i += 1) {
        const s = separators[i];
        if (s === "") {
            separator = s;
            break;
        }
        if (text.includes(s)) {
            separator = s;
            newSeparators = separators.slice(i + 1);
            break;
        }
    }

    const splits = splitOnSeparator(text, separator);
    let goodSplits: string[] = [];
    // keepSeparator = false → join merged pieces with the separator.
    for (const s of splits) {
        if (lengthFunction(s) < chunkSize) {
            goodSplits.push(s);
        } else {
            if (goodSplits.length) {
                finalChunks.push(...mergeSplits(goodSplits, separator, chunkSize, lengthFunction));
                goodSplits = [];
            }
            if (!newSeparators) {
                // No finer separator left — emit as-is (caller applies a hard
                // char-budget guard for the degenerate token-dense case).
                finalChunks.push(s);
            } else {
                finalChunks.push(
                    ...splitTextRecursive(s, newSeparators, chunkSize, lengthFunction),
                );
            }
        }
    }
    if (goodSplits.length) {
        finalChunks.push(...mergeSplits(goodSplits, separator, chunkSize, lengthFunction));
    }
    return finalChunks;
}

/**
 * Recursively split `text` into chunks no larger than `chunkSize` (measured by
 * `lengthFunction`), preferring the coarsest separator that keeps chunks under
 * budget and falling back through the separator hierarchy down to characters.
 * Synchronous.
 */
export function recursiveCharacterSplit(
    text: string,
    options: RecursiveCharacterSplitOptions,
): string[] {
    const chunkSize = options.chunkSize;
    const lengthFunction = options.lengthFunction ?? ((t: string) => t.length);
    const separators = options.separators ?? DEFAULT_SEPARATORS;
    if (text.length === 0) return [];
    return splitTextRecursive(text, separators, chunkSize, lengthFunction);
}
