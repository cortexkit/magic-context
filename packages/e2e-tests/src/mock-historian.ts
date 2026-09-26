/**
 * Shared mock-historian payload builder for the e2e suite.
 *
 * The historian's output is validated before it is published (see
 * `validateHistorianOutput` in the plugin and `historian_validate.rs` in the
 * Rust module). Since strict tier validation landed, a compartment that lacks
 * the v2 paraphrase tiers is rejected: P1 is the required boundary, and a flat
 * v1-shaped compartment (bare prose, no `<p1>`) re-enters the retry chain and
 * never publishes. Every historian-publish e2e test therefore needs its mock
 * provider to answer with a valid v2 tiered compartment, or it times out
 * waiting for a publish that validation blocks.
 *
 * This helper emits the minimal valid v2 shape — a single compartment carrying
 * all four paraphrase tiers plus the `importance`/`episode_type` attributes and
 * the `<facts>`/`<events>` blocks — wrapped in the full `<output>` envelope with
 * a trailing `<unprocessed_from>` so the chunk reports as fully covered. It
 * mirrors the tiered fixture the cache-invariant tests already publish
 * successfully, so it satisfies both the TypeScript and Rust validation paths.
 */

export interface HistorianOrdinalRange {
    /** Lowest raw ordinal the `<new_messages>` block displays. */
    start: number;
    /** Highest raw ordinal the `<new_messages>` block displays. */
    end: number;
}

/**
 * Block headers as the historian prompt writes them: `[7] U:` for one message,
 * `[1-2] A:` when several raw ordinals share one rendered line. Anchoring to the
 * start of a line and requiring the role and colon keeps bracketed prose (a
 * message that mentions `m[0]`, say) out of the match.
 */
const BLOCK_HEADER = /^\[(\d+)(?:-(\d+))?\] [A-Z]+:/gm;

/**
 * Read the raw ordinal span the historian was asked to summarize out of its own
 * prompt, so a mock provider can answer with a compartment that covers it.
 *
 * Both ends of a header matter. The chunk reader keeps every raw ordinal in the
 * numbering but renders prose only for messages that have some, so a message
 * with no prose of its own — a Pi transcript system entry, a notification the
 * reader filters — is folded into the header of the line that follows it. Read
 * only the single-ordinal form and such a chunk looks like it begins at its
 * first talking message, and a compartment built from that leaves the ordinals
 * before it uncovered, which historian validation rejects as a gap.
 *
 * Pi chunks reach the historian that way routinely since 4c8ce36a1d, which gave
 * transcript system entries their own raw ordinal with no prose attached: a Pi
 * session whose transcript opens with one renders its first line as `[1-2] U:`.
 */
export function findHistorianOrdinalRange(
    body: Record<string, unknown>,
): HistorianOrdinalRange | null {
    const messages = (body.messages as Array<{ content?: unknown }> | undefined) ?? [];
    for (const message of messages) {
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks) {
            const text = (block as { text?: unknown } | null)?.text;
            if (typeof text !== "string" || !text.includes("<new_messages>")) continue;
            const opening = text.indexOf("<new_messages>");
            const closing = text.indexOf("</new_messages>");
            const scope = closing > opening ? text.slice(opening, closing) : text.slice(opening);
            const starts: number[] = [];
            const ends: number[] = [];
            for (const header of scope.matchAll(BLOCK_HEADER)) {
                const start = Number(header[1]);
                starts.push(start);
                ends.push(header[2] === undefined ? start : Number(header[2]));
            }
            if (starts.length > 0) return { start: Math.min(...starts), end: Math.max(...ends) };
        }
    }
    return null;
}

/**
 * {@link findHistorianOrdinalRange} for a request in any provider shape.
 *
 * The Anthropic lanes carry the prompt in `messages[].content[].text`; the
 * OpenCode 2 lane's mock speaks the OpenAI Responses API, which nests it
 * differently under `input`. This walks every string in the body and reads the
 * first one that carries a `<new_messages>` block, so one matcher answers the
 * historian on either lane.
 */
export function historianRangeInRequest(body: Record<string, unknown>): HistorianOrdinalRange | null {
    const texts: string[] = [];
    const visit = (value: unknown): void => {
        if (typeof value === "string") {
            if (value.includes("<new_messages>")) texts.push(value);
        } else if (Array.isArray(value)) {
            for (const item of value) visit(item);
        } else if (value && typeof value === "object") {
            for (const item of Object.values(value)) visit(item);
        }
    };
    visit(body.messages ?? body.input ?? []);
    for (const text of texts) {
        const range = findHistorianOrdinalRange({
            messages: [{ content: [{ type: "text", text }] }],
        });
        if (range) return range;
    }
    return null;
}

export interface MockHistorianPayloadOptions {
    /** First raw ordinal the compartment covers (`<compartment start="...">`). */
    start: number;
    /** Last raw ordinal the compartment covers (`<compartment end="...">`). */
    end: number;
    /** Compartment title attribute. */
    title: string;
    /** P1 tier text — the fullest paraphrase and the required v2 boundary. */
    body: string;
    /** P2 tier text (shorter paraphrase). Defaults to `body`. */
    p2?: string;
    /** P3 tier text (shortest paraphrase). Defaults to `body`. */
    p3?: string;
    /** v2 decay-rate attribute (1-100). Defaults to 50. */
    importance?: number;
    /** v2 episode_type attribute. Defaults to "feature". */
    episodeType?: string;
}

/**
 * Build a valid v2 tiered historian `<output>` payload covering `start`..`end`.
 *
 * P4 is emitted self-closed (`<p4/>`), which the parser treats as an empty tier
 * — a legal v2 shape. `<unprocessed_from>` is set to `end + 1` so the validator
 * sees the whole chunk as consumed.
 */
export function buildMockHistorianPayload(options: MockHistorianPayloadOptions): string {
    const { start, end, title, body } = options;
    const p2 = options.p2 ?? body;
    const p3 = options.p3 ?? body;
    const importance = options.importance ?? 50;
    const episodeType = options.episodeType ?? "feature";

    return [
        "<output>",
        "<compartments>",
        `<compartment start="${start}" end="${end}" title="${escapeXml(title)}" importance="${importance}" episode_type="${escapeXml(episodeType)}">`,
        `<p1>${escapeXml(body)}</p1>`,
        `<p2>${escapeXml(p2)}</p2>`,
        `<p3>${escapeXml(p3)}</p3>`,
        "<p4/>",
        "</compartment>",
        "</compartments>",
        "<facts></facts>",
        "<events></events>",
        `<unprocessed_from>${end + 1}</unprocessed_from>`,
        "</output>",
    ].join("\n");
}

/** Escape the five XML-special characters so arbitrary prose stays well-formed. */
function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
