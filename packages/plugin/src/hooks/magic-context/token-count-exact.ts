/**
 * Exact token counts without ai-tokenizer's two superlinear paths.
 *
 * ai-tokenizer splits text into pieces with its pattern regex and merges each
 * piece's bytes with byte-pair encoding. Two parts of that are superlinear:
 *
 * - Its merge loop scans every remaining pair to find the next merge and
 *   splices arrays after each one, which is quadratic in the piece length.
 *   Ordinary prose and code split into short pieces, but a run of letters,
 *   digits, spaces or punctuation with nothing to split it (a minified line, a
 *   padded log, a long `=====` rule) is one piece: 40,000 characters took about
 *   0.75 s, and 1 MB would take minutes.
 * - Its merge cache evicts its oldest entry with `map.keys().next()` after
 *   deleting from the front of a `Map`, which in JavaScriptCore walks past every
 *   earlier deletion. Text whose pieces rarely repeat (base64 in a data URL, a
 *   hex dump, random identifiers) evicts on nearly every piece once the cache
 *   is full: 2 MB of base64 in tool output took tens of seconds to count.
 *
 * {@link encodeTokensExactly} replays the library's ordinary encoding loop with
 * its own merge and cache: pieces are merged in the library's order (lowest
 * rank first, leftmost on ties), with a heap for long pieces, and merged pieces
 * are kept in a two-generation cache that never deletes single entries. The
 * tokens are the library's. If the tokenizer object does not have the
 * internals this relies on, it counts with the library unchanged.
 */

const NO_RANK = 4294967295;
/** Pieces longer than this many bytes are merged with a heap rather than by scanning. */
const LONG_PIECE_BYTES = 256;
/** Merged pieces kept per cache generation; at most twice this many are retained. */
const MERGE_CACHE_GENERATION = 50_000;

type BinaryRankEntry = [ArrayLike<number>, number];

/** The ai-tokenizer `Tokenizer` fields and methods the exact count relies on. */
interface TokenizerInternals {
    encode: (text: string, allowedSpecial: string) => number[];
    patternRegex: RegExp;
    stringRankEncoder: Record<string, number>;
    binaryFirstByteIndex: Array<BinaryRankEntry[] | null>;
}

function hasInternals(tokenizer: unknown): tokenizer is TokenizerInternals {
    const value = tokenizer as Partial<TokenizerInternals> | null;
    return (
        !!value &&
        value.patternRegex instanceof RegExp &&
        value.patternRegex.global &&
        typeof value.stringRankEncoder === "object" &&
        value.stringRankEncoder !== null &&
        Array.isArray(value.binaryFirstByteIndex)
    );
}

const textEncoder = new TextEncoder();
// The library decodes with the default decoder (which drops a leading BOM)
// after its own validity check; both are reproduced so lookups match.
const textDecoder = new TextDecoder("utf-8");

/** The library's UTF-8 validity check, reproduced so the same slices decode. */
function isValidUtf8(bytes: Uint8Array): boolean {
    let index = 0;
    while (index < bytes.length) {
        const first = bytes[index] as number;
        let size = 0;
        let codePoint = 0;
        if (first <= 127) {
            size = 1;
            codePoint = first;
        } else if ((first & 224) === 192) {
            size = 2;
            codePoint = first & 31;
            if (first <= 193) return false;
        } else if ((first & 240) === 224) {
            size = 3;
            codePoint = first & 15;
        } else if ((first & 248) === 240) {
            size = 4;
            codePoint = first & 7;
            if (first > 244) return false;
        } else return false;
        if (index + size > bytes.length) return false;
        for (let offset = 1; offset < size; offset += 1) {
            const byte = bytes[index + offset] as number;
            if ((byte & 192) !== 128) return false;
            codePoint = (codePoint << 6) | (byte & 63);
        }
        if (size === 2 && codePoint < 128) return false;
        if (size === 3 && codePoint < 2048) return false;
        if (size === 4 && codePoint < 65536) return false;
        if (codePoint >= 55296 && codePoint <= 57343) return false;
        if (codePoint > 1114111) return false;
        index += size;
    }
    return true;
}

/** The library's binary search over byte-keyed ranks, reproduced. */
function binarySearchBytes(sorted: BinaryRankEntry[], key: Uint8Array): number {
    let low = 0;
    let high = sorted.length - 1;
    while (low <= high) {
        const mid = (low + high) >>> 1;
        const midKey = (sorted[mid] as BinaryRankEntry)[0];
        let compare = 0;
        const shared = Math.min(midKey.length, key.length);
        for (let index = 0; index < shared; index += 1) {
            compare = (midKey[index] as number) - (key[index] as number);
            if (compare !== 0) break;
        }
        if (compare === 0) compare = midKey.length - key.length;
        if (compare === 0) return (sorted[mid] as BinaryRankEntry)[1];
        if (compare < 0) low = mid + 1;
        else high = mid - 1;
    }
    return -1;
}

function rankOf(tokenizer: TokenizerInternals, slice: Uint8Array): number {
    if (isValidUtf8(slice)) {
        const rank = tokenizer.stringRankEncoder[textDecoder.decode(slice)];
        if (rank !== undefined) return rank;
    }
    const bucket = tokenizer.binaryFirstByteIndex[slice[0] as number];
    if (bucket !== null && bucket !== undefined) {
        const rank = binarySearchBytes(bucket, slice);
        if (rank !== -1) return rank;
    }
    return NO_RANK;
}

/**
 * The library's merge for a short piece, reproduced: repeatedly merge the
 * adjacent pair whose joined bytes have the lowest rank, the leftmost such pair
 * on ties, until no pair has a rank.
 */
function mergeByScanning(tokenizer: TokenizerInternals, bytes: Uint8Array): number[] {
    const starts: number[] = [];
    const ranks: number[] = [];
    const pairRank = (index: number): number => {
        const end = starts[index + 2];
        return end === undefined
            ? NO_RANK
            : rankOf(tokenizer, bytes.subarray(starts[index] as number, end));
    };
    for (let index = 0; index <= bytes.length; index += 1) starts.push(index);
    for (let index = 0; index < starts.length; index += 1) ranks.push(pairRank(index));
    while (starts.length > 1) {
        let minRank = NO_RANK;
        let minIndex = -1;
        for (let index = 0; index < ranks.length - 1; index += 1) {
            if ((ranks[index] as number) < minRank) {
                minRank = ranks[index] as number;
                minIndex = index;
            }
        }
        if (minIndex === -1) break;
        starts.splice(minIndex + 1, 1);
        ranks.splice(minIndex, 1);
        ranks[minIndex] = pairRank(minIndex);
        if (minIndex > 0) ranks[minIndex - 1] = pairRank(minIndex - 1);
    }
    const tokens: number[] = [];
    for (let index = 0; index < starts.length - 1; index += 1) {
        const rank = rankOf(
            tokenizer,
            bytes.subarray(starts[index] as number, starts[index + 1] as number),
        );
        if (rank !== NO_RANK) tokens.push(rank);
    }
    return tokens;
}

/**
 * The same merge as {@link mergeByScanning} in O(n log n): a heap ordered by
 * rank, then by position, picks the pair the scan would pick.
 */
function mergeWithHeap(tokenizer: TokenizerInternals, bytes: Uint8Array): number[] {
    const length = bytes.length;
    // Boundaries 0..length; boundary `length` closes the last part.
    const next = new Int32Array(length + 1);
    const prev = new Int32Array(length + 1);
    const alive = new Uint8Array(length + 1).fill(1);
    const rank = new Float64Array(length + 1).fill(NO_RANK);
    for (let index = 0; index <= length; index += 1) {
        next[index] = index + 1;
        prev[index] = index - 1;
    }
    // Min-heap of (rank, boundary); stale entries are skipped when popped.
    const heapRank: number[] = [];
    const heapAt: number[] = [];
    const less = (a: number, b: number): boolean =>
        (heapRank[a] as number) < (heapRank[b] as number) ||
        (heapRank[a] === heapRank[b] && (heapAt[a] as number) < (heapAt[b] as number));
    const swap = (a: number, b: number): void => {
        [heapRank[a], heapRank[b]] = [heapRank[b] as number, heapRank[a] as number];
        [heapAt[a], heapAt[b]] = [heapAt[b] as number, heapAt[a] as number];
    };
    const push = (value: number, at: number): void => {
        heapRank.push(value);
        heapAt.push(at);
        let child = heapRank.length - 1;
        while (child > 0) {
            const parent = (child - 1) >> 1;
            if (!less(child, parent)) break;
            swap(child, parent);
            child = parent;
        }
    };
    const pop = (): void => {
        const last = heapRank.length - 1;
        swap(0, last);
        heapRank.pop();
        heapAt.pop();
        let parent = 0;
        for (;;) {
            const left = parent * 2 + 1;
            const right = left + 1;
            let smallest = parent;
            if (left < heapRank.length && less(left, smallest)) smallest = left;
            if (right < heapRank.length && less(right, smallest)) smallest = right;
            if (smallest === parent) break;
            swap(parent, smallest);
            parent = smallest;
        }
    };
    const pairRank = (at: number): number => {
        const middle = next[at] as number;
        if (middle >= length) return NO_RANK;
        return rankOf(tokenizer, bytes.subarray(at, next[middle] as number));
    };
    const update = (at: number): void => {
        rank[at] = pairRank(at);
        if (rank[at] !== NO_RANK) push(rank[at] as number, at);
    };
    for (let at = 0; at < length; at += 1) update(at);
    while (heapRank.length > 0) {
        const value = heapRank[0] as number;
        const at = heapAt[0] as number;
        pop();
        if (!alive[at] || rank[at] !== value) continue;
        const removed = next[at] as number;
        alive[removed] = 0;
        next[at] = next[removed] as number;
        prev[next[removed] as number] = at;
        update(at);
        if (at > 0) update(prev[at] as number);
    }
    const tokens: number[] = [];
    for (let at = 0; at < length; at = next[at] as number) {
        const value = rankOf(tokenizer, bytes.subarray(at, next[at] as number));
        if (value !== NO_RANK) tokens.push(value);
    }
    return tokens;
}

/** Two generations: a full current generation becomes the previous one, which is dropped whole. */
const mergeCaches = new WeakMap<
    TokenizerInternals,
    { current: Map<string, number[]>; previous: Map<string, number[]> }
>();
let mergedPieces = 0;

function mergePiece(tokenizer: TokenizerInternals, piece: string): number[] {
    let cache = mergeCaches.get(tokenizer);
    if (!cache) {
        cache = { current: new Map(), previous: new Map() };
        mergeCaches.set(tokenizer, cache);
    }
    let tokens = cache.current.get(piece);
    if (tokens) return tokens;
    tokens = cache.previous.get(piece);
    if (!tokens) {
        const bytes = textEncoder.encode(piece);
        mergedPieces += 1;
        tokens =
            bytes.length > LONG_PIECE_BYTES
                ? mergeWithHeap(tokenizer, bytes)
                : mergeByScanning(tokenizer, bytes);
    }
    if (cache.current.size >= MERGE_CACHE_GENERATION) {
        cache.previous = cache.current;
        cache.current = new Map();
    }
    cache.current.set(piece, tokens);
    return tokens;
}

/** @internal Pieces merged (cache misses) since the process started. */
export function getMergedPieceCountForTest(): number {
    return mergedPieces;
}

/**
 * The tokens `tokenizer.encode(text, "all")` gives, without the library's
 * quadratic merge or its merge cache. Exposed for the equivalence test.
 */
export function encodeTokensExactly(tokenizer: unknown, text: string): number[] {
    if (!hasInternals(tokenizer)) {
        return (tokenizer as TokenizerInternals).encode(text, "all");
    }
    // encode(text, "all") goes straight to the library's ordinary encoder; this
    // follows that encoder step for step.
    if (text.length < 10) {
        const direct = tokenizer.stringRankEncoder[text];
        if (direct !== undefined) return [direct];
    }
    const tokens: number[] = [];
    const regex = tokenizer.patternRegex;
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
        const piece = match[0];
        const direct = tokenizer.stringRankEncoder[piece];
        if (direct !== undefined) {
            tokens.push(direct);
            continue;
        }
        for (const token of mergePiece(tokenizer, piece)) tokens.push(token);
    }
    return tokens;
}

/** Same count as `tokenizer.encode(text, "all").length`, in time linear in the text. */
export function countTokensExactly(tokenizer: unknown, text: string): number {
    return encodeTokensExactly(tokenizer, text).length;
}
