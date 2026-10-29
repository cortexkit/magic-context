import { V2_MEMORY_CATEGORIES } from "../../features/magic-context/memory/constants";
import { log } from "../../shared/logger";
import { unescapeXml } from "../../shared/xml-unescape";

export interface ParsedCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    /** v2: P1 tier text (mirror). v1/flat: the flat compartment body. */
    content: string;
    /** v2 paraphrase tiers (model B). Undefined for v1/flat compartments. p4 may be "" (self-close). */
    p1?: string;
    p2?: string;
    p3?: string;
    p4?: string;
    /** v2 decay-rate signal (1-100). Undefined for v1/flat. */
    importance?: number;
    /** v2 comma-separated activity types. Undefined for v1/flat. */
    episodeType?: string;
}

export interface ParsedFact {
    category: string;
    content: string;
    /**
     * Source anchor written as a `[at_compartment=N messages=A-B]` bullet prefix.
     * Absent when the bullet carries no anchor or says `at_compartment=unknown`.
     * `compartmentIndex` is 1-based into the returned (start-sorted) compartments.
     */
    anchor?: ParsedFactAnchor;
}

export interface ParsedFactAnchor {
    compartmentIndex: number;
    /** The printed `[A]`/`[A-B]` range the fact cites; absent when none was written. */
    startOrdinal?: number;
    endOrdinal?: number;
    /** Disjoint source ranges; single-range anchors retain the legacy fields only. */
    ranges?: Array<{ startOrdinal: number; endOrdinal: number }>;
}

/**
 * A historian-extracted event (v2). Two kinds today — `causal_incident` and
 * `trajectory_correction` — but parsed kind-agnostically: `kind` is the element
 * name and `fields` holds every child element verbatim. v2.0 STORES events
 * (E2 events table) but does NOT render them; parsing kind-agnostically means a
 * future event-kind or field addition needs no parser change.
 */
export interface ParsedEvent {
    kind: string;
    /** 1-based compartment index the event anchors to (`at_compartment="N"`); null if absent/invalid. */
    atCompartment: number | null;
    /** child element name → text content (e.g. summary, before_strategy, evidence). */
    fields: Record<string, string>;
}

export interface ParsedPrimerCandidate {
    question: string;
    /** 1-based index into the publish's emitted compartments
     *  (`<primer at_compartment="N">`), matching the SAME convention as
     *  `<events>` anchoring. Undefined for the legacy bullet form, in which case
     *  emission falls back to the chunk span. */
    originCompartmentIndex?: number;
}

export interface ParsedCompartmentOutput {
    compartments: ParsedCompartment[];
    facts: ParsedFact[];
    droppedFactBlocks: number;
    droppedFacts: number;
    events: ParsedEvent[];
    unprocessedFrom: number | null;
    userObservations: string[];
    primerCandidates: ParsedPrimerCandidate[];
}

// Open tag matched separately from the body so attributes (start/end/title/
// episode_type/importance) can appear in ANY order — LLM output is not
// attribute-order-stable. Group 1 = full attribute string. Quoted attribute
// values are consumed whole, so a raw `>` inside one (a title like
// "Migrate store -> SQLite") does not end the open tag. A value may not span a
// line, so a stray unbalanced quote cannot swallow the body. The body and its
// closing tag are located procedurally in findCompartmentElements.
const COMPARTMENT_OPEN_REGEX = /<compartment\s+((?:[^>"]|"[^"\n]*")*?)\s*>/g;
const COMPARTMENT_CLOSE_TAG = "</compartment>";
// What may follow a compartment's real closing tag: the next compartment, the
// end of the compartment list or document, or one of the output's own blocks.
// A `</compartment>` written as text inside a body is followed by more prose.
const COMPARTMENT_CLOSE_FOLLOWER_REGEX =
    /^\s*(?:$|<(?:compartment\s|\/compartments\s*>|\/output\s*>|(?:facts|events|meta|user_observations|primer_candidates|unprocessed_from)\s*>))/;
// Self-closing v2 compartments are invalid (a compartment must have ≥1 tier or
// flat content), so we only match the paired form above.
const ATTR_START_REGEX = /\bstart="(\d+)"/;
const ATTR_END_REGEX = /\bend="(\d+)"/;
const ATTR_TITLE_REGEX = /\btitle="([^"]*)"/;
const ATTR_EPISODE_REGEX = /\bepisode_type="([^"]*)"/;
const ATTR_IMPORTANCE_REGEX = /\bimportance="(\d+)"/;
// Tier opener: matches `<p1>` / `<p1 >` (group 2 empty) or the self-close
// `<p4/>` / `<p4 />` (group 2 = "/" → ""). Group 1 = tier digit. The body that
// follows an opener is bounded procedurally in extractTiers rather than by an
// exact `</pN>` close, because some models mismatch the closing digit
// (e.g. `<p1>…</p2>`) or omit it.
const TIER_OPEN_REGEX = /<p(\d)\s*(\/?)>/g;
// A complete tier closing tag; group 1 = tier digit.
const TIER_CLOSE_REGEX = /<\/p(\d)\s*>/g;
// What may follow a tier's real closing tag: another tier tag or the end of the
// compartment. A tier tag written as text inside a body is followed by prose.
const TIER_CLOSE_FOLLOWER_REGEX = /^\s*(?:$|<\/?p\d\s*\/?>)/;
// Lenient fallback bounds: the start of any tier's closing tag (`</p1`…`</p9`),
// and the start of any tier's opening tag — the over-capture guard, so a tier
// body bounded leniently never swallows another tier's opener.
const TIER_CLOSE_ANY_REGEX = /<\/p\d/;
const TIER_OPEN_ANY_REGEX = /<p\d/;
const CATEGORY_BLOCK_REGEX = /<([A-Za-z_][A-Za-z0-9_-]*)>(.*?)<\/\1>/gs;
const HISTORIAN_CATEGORIES: ReadonlySet<string> = new Set(V2_MEMORY_CATEGORIES);
// A fact bullet's optional source-anchor prefix:
// `[at_compartment=N messages=A-B] text`, `[at_compartment=unknown] text`. Only
// ASCII space and tab separate its parts, and the text after it may hold any
// character, so JavaScript and Rust classify the same input the same way.
// Mirrors `side_channel_anchor_regex` in crates/mc-module/src/historian_validate.rs.
const FACT_ANCHOR_PREFIX_REGEX =
    /^[ \t]*[[(][ \t]*(?:at_compartment|origin_compartment)[ \t]*=[ \t]*"?([0-9]+|unknown)"?(?:[ \t]+messages[ \t]*=[ \t]*"?([0-9]+(?:[ \t]*-[ \t]*[0-9]+)?(?:[ \t]*,[ \t]*[0-9]+(?:[ \t]*-[ \t]*[0-9]+)?)*)"?)?[ \t]*[\])][ \t]*([\s\S]+)$/;
// Whitespace trimmed from fact text: Unicode White_Space without U+0085 (that is,
// JavaScript's `trim` set without U+FEFF). U+0085 and U+FEFF stay ordinary text, as
// in `is_fact_trim_char` in the Rust parser.
const FACT_TRIM_CHARS =
    "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const FACT_TRIM_START_REGEX = new RegExp(`^[${FACT_TRIM_CHARS}]+`);
const FACT_TRIM_END_REGEX = new RegExp(`[${FACT_TRIM_CHARS}]+$`);
const UNPROCESSED_REGEX = /<unprocessed_from>(\d+)<\/unprocessed_from>/;
const USER_OBSERVATIONS_REGEX = /<user_observations>(.*?)<\/user_observations>/s;
const USER_OBS_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;
const PRIMER_CANDIDATES_REGEX = /<primer_candidates>(.*?)<\/primer_candidates>/s;
// Preferred form: <primer at_compartment="N">question</primer>, where N is the
// 1-based index of the origin compartment in this output (the same convention
// as <events>). The legacy bullet form (*/-/1.) is still accepted and falls back
// to the chunk span at emission.
const PRIMER_ELEMENT_REGEX = /<primer\s+at_compartment="(\d+)"\s*>(.*?)<\/primer>/gs;
const PRIMER_ITEM_REGEX = /^\s*(?:\*|-|\d+\.)\s*(.+)$/gm;

// Events: scan the <events>…</events> block (if any) for event elements. Kinds
// are parsed kind-agnostically — any element with an `at_compartment` attr is an
// event whose child elements become `fields`. v2.0 stores events; rendering is
// deferred (E2). Scoping to the <events> block prevents fact/compartment tags
// from being mis-read as events.
const FACTS_BLOCK_REGEX = /<facts>(.*?)<\/facts>/s;
const EVENTS_BLOCK_REGEX = /<events>(.*?)<\/events>/s;
const EVENT_ELEMENT_REGEX = /<([a-z_]+)\s+at_compartment="(\d+)"\s*>(.*?)<\/\1>/gs;
const EVENT_FIELD_REGEX = /<([a-z_]+)\s*>(.*?)<\/\1>/gs;

/** Index of the first match of `regex` in `s` at or after `from`, or -1. */
function searchFrom(s: string, regex: RegExp, from: number): number {
    const at = s.slice(from).search(regex);
    return at === -1 ? -1 : from + at;
}

function parseOrdinal(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : undefined;
}

/** Trim fact text the same way the Rust parser does; see `FACT_TRIM_CHARS`. */
export function trimFactText(text: string): string {
    return text.replace(FACT_TRIM_START_REGEX, "").replace(FACT_TRIM_END_REGEX, "");
}

/**
 * The bullet items of a fact category block, XML-unescaped. A bullet is one
 * `\n`-terminated line (the `\r` of a CRLF ending is dropped) that starts with `*`
 * after optional whitespace. U+2028, U+2029, U+0085 and a lone `\r` are ordinary
 * text inside a bullet, never a line end. `fact_items` in the Rust parser splits
 * the same way.
 */
function factItems(block: string): string[] {
    const items: string[] = [];
    for (const rawLine of block.split("\n")) {
        const line = rawLine.replace(FACT_TRIM_START_REGEX, "");
        if (!line.startsWith("*")) continue;
        const body = line.slice(1);
        const item = trimFactText(body);
        if (item) items.push(unescapeXml(item));
    }
    return items;
}

/**
 * Split a fact bullet's optional source-anchor prefix from its text. A bullet
 * without a prefix, or with `at_compartment=unknown`, has no anchor. The Rust
 * parser (`historian_validate::split_fact_anchor_prefix`) gives the same result.
 */
export function splitFactAnchorPrefix(text: string): {
    content: string;
    anchor?: ParsedFactAnchor;
} {
    const match = text.match(FACT_ANCHOR_PREFIX_REGEX);
    if (!match) return { content: trimFactText(text) };
    const content = trimFactText(match[3]);
    // An index or range past 2^53 rejects the whole anchor, as in Rust.
    const compartmentIndex = parseOrdinal(match[1]);
    if (compartmentIndex === undefined) return { content };
    if (match[2] === undefined) return { content, anchor: { compartmentIndex } };
    const parts = match[2].split(",");
    if (parts.length > 3) return { content };
    const ranges: Array<{ startOrdinal: number; endOrdinal: number }> = [];
    for (const part of parts) {
        const [start, end] = part.trim().split(/[ \t]*-[ \t]*/);
        const startOrdinal = parseOrdinal(start);
        const endOrdinal = end === undefined ? startOrdinal : parseOrdinal(end);
        if (startOrdinal === undefined || endOrdinal === undefined) return { content };
        ranges.push({ startOrdinal, endOrdinal });
    }
    return {
        content,
        anchor: { compartmentIndex, ...ranges[0], ...(ranges.length > 1 ? { ranges } : {}) },
    };
}

/** True when `inner` opens tier `digit` anywhere at or after `from`. */
function hasTierOpenerFrom(inner: string, digit: number, from: number): boolean {
    return new RegExp(`<p${digit}\\s*/?>`).test(inner.slice(from));
}

/**
 * Find the close of tier `digit` whose body starts at `bodyStart`, when the
 * tier is properly closed: the first `</pN>` with the same digit that is
 * followed only by another tier tag or the end of the compartment. Tier tags
 * before that close are body text (a summary that talks about `<p2>` tags),
 * unless one of them opens a tier that is not found anywhere else: then it is
 * really the next tier after an unclosed one (`<p1>alpha<p2>beta</p1>`), and
 * undefined sends the caller to the lenient bounds.
 */
function findMatchingTierClose(
    inner: string,
    bodyStart: number,
    digit: number,
    found: ReadonlyMap<number, string>,
): { start: number; end: number } | undefined {
    const closeRegex = new RegExp(TIER_CLOSE_REGEX.source, "g");
    closeRegex.lastIndex = bodyStart;
    for (let close = closeRegex.exec(inner); close; close = closeRegex.exec(inner)) {
        const end = close.index + close[0].length;
        if (Number(close[1]) !== digit) continue;
        if (!TIER_CLOSE_FOLLOWER_REGEX.test(inner.slice(end))) continue;
        const body = inner.slice(bodyStart, close.index);
        for (const open of body.matchAll(new RegExp(TIER_OPEN_REGEX.source, "g"))) {
            const other = Number(open[1]);
            const otherwiseMissing =
                other >= 1 &&
                other <= 4 &&
                other !== digit &&
                !found.has(other) &&
                !hasTierOpenerFrom(inner, other, end);
            if (otherwiseMissing) return undefined;
        }
        return { start: close.index, end };
    }
    return undefined;
}

/**
 * Extract the tier bodies from a compartment inner string, walking the tiers
 * in the order they appear. Each digit keeps its first occurrence; the map has
 * no entry for an absent tier and "" for a self-closed or empty one.
 *
 * A properly closed tier keeps any tier tags written inside it as text (see
 * findMatchingTierClose). Otherwise the parser is lenient about the close: an
 * opened `<pN>` is terminated by the NEXT closing tier tag of ANY digit
 * (`</p\d>`), because some models mismatch the close (observed: `<p1>…</p2>`).
 * If the model omitted the close entirely, the next opening tier tag — or the
 * end of the compartment — bounds the body instead.
 */
function extractTiers(inner: string): Map<number, string> {
    const tiers = new Map<number, string>();
    const openRegex = new RegExp(TIER_OPEN_REGEX.source, "g");
    let pos = 0;
    for (;;) {
        openRegex.lastIndex = pos;
        const open = openRegex.exec(inner);
        if (!open) break;
        const digit = Number(open[1]);
        const bodyStart = open.index + open[0].length;
        let bodyEnd = bodyStart;
        pos = bodyStart;
        // Self-close form (<p4/> or <p4 />) → empty tier.
        if (open[2] !== "/") {
            const close = findMatchingTierClose(inner, bodyStart, digit, tiers);
            if (close) {
                bodyEnd = close.start;
                pos = close.end;
            } else {
                // Lenient bounds: the next closing tier tag of any digit, or the
                // end of the compartment when there is none.
                const closeAt = searchFrom(inner, TIER_CLOSE_ANY_REGEX, bodyStart);
                bodyEnd = closeAt === -1 ? inner.length : closeAt;
                pos = closeAt === -1 ? inner.length : closeAt + 1;
                // Over-capture guard: never swallow a subsequent tier's opening
                // tag into this tier's content. If an opener appears before the
                // close, cut there and resume the walk at that opener.
                const openInside = searchFrom(
                    inner.slice(0, bodyEnd),
                    TIER_OPEN_ANY_REGEX,
                    bodyStart,
                );
                if (openInside !== -1) {
                    bodyEnd = openInside;
                    pos = openInside;
                }
            }
        }
        if (!tiers.has(digit)) {
            tiers.set(digit, unescapeXml(inner.slice(bodyStart, bodyEnd).trim()));
        }
    }
    return tiers;
}

/**
 * Extract all four tier bodies from a compartment's inner markup using the
 * rules above. Exposed for the v70 heal migration, which re-parses flat
 * `content` that the old strict parser stranded as legacy when a model
 * mismatched a tier's closing tag. Each tier is undefined when absent.
 */
export function extractTiersFromInner(inner: string): {
    p1?: string;
    p2?: string;
    p3?: string;
    p4?: string;
} {
    const tiers = extractTiers(inner);
    return { p1: tiers.get(1), p2: tiers.get(2), p3: tiers.get(3), p4: tiers.get(4) };
}

interface CompartmentElement {
    /** Offsets of the whole element in the parsed text. */
    start: number;
    end: number;
    attrs: string;
    inner: string;
}

/**
 * Locate every `<compartment …>…</compartment>` element in emission order. A
 * compartment ends at the first `</compartment>` before the next compartment's
 * open tag that is followed by output structure, so the closing tag written as
 * text inside a body does not end the compartment early. When no close
 * qualifies, the first `</compartment>` ends it, as a plain non-greedy match
 * would.
 */
function findCompartmentElements(text: string): CompartmentElement[] {
    const elements: CompartmentElement[] = [];
    const openRegex = new RegExp(COMPARTMENT_OPEN_REGEX.source, "g");
    let cursor = 0;
    for (;;) {
        openRegex.lastIndex = cursor;
        const open = openRegex.exec(text);
        if (!open) break;
        const bodyStart = open.index + open[0].length;
        const nextOpen = openRegex.exec(text);
        const windowEnd = nextOpen ? nextOpen.index : text.length;
        const firstClose = text.indexOf(COMPARTMENT_CLOSE_TAG, bodyStart);
        if (firstClose === -1) break;
        let closeAt = firstClose;
        for (
            let at = firstClose;
            at !== -1 && at < windowEnd;
            at = text.indexOf(COMPARTMENT_CLOSE_TAG, at + 1)
        ) {
            if (
                COMPARTMENT_CLOSE_FOLLOWER_REGEX.test(text.slice(at + COMPARTMENT_CLOSE_TAG.length))
            ) {
                closeAt = at;
                break;
            }
        }
        const end = closeAt + COMPARTMENT_CLOSE_TAG.length;
        elements.push({
            start: open.index,
            end,
            attrs: open[1],
            inner: text.slice(bodyStart, closeAt),
        });
        cursor = end;
    }
    return elements;
}

/**
 * The output with every compartment element removed. Side-channel blocks
 * (facts, events, observations, primers, meta) are read from this text, so a
 * compartment body that mentions `<facts>` or `<events>` cannot be mistaken
 * for the real block.
 */
function textOutsideCompartments(text: string, elements: readonly CompartmentElement[]): string {
    let outside = "";
    let last = 0;
    for (const element of elements) {
        outside += text.slice(last, element.start);
        last = element.end;
    }
    return outside + text.slice(last);
}

export function parseCompartmentOutput(text: string): ParsedCompartmentOutput {
    const compartments: ParsedCompartment[] = [];
    const facts: ParsedFact[] = [];
    let droppedFactBlocks = 0;
    let droppedFacts = 0;

    const elements = findCompartmentElements(text);
    for (const { attrs, inner } of elements) {
        const startMatch = attrs.match(ATTR_START_REGEX);
        const endMatch = attrs.match(ATTR_END_REGEX);
        const titleMatch = attrs.match(ATTR_TITLE_REGEX);
        if (!startMatch || !endMatch || !titleMatch) continue;

        const startMessage = parseInt(startMatch[1], 10);
        const endMessage = parseInt(endMatch[1], 10);
        const title = unescapeXml(titleMatch[1]);
        if (Number.isNaN(startMessage) || Number.isNaN(endMessage) || !title) continue;

        const episodeMatch = attrs.match(ATTR_EPISODE_REGEX);
        const importanceMatch = attrs.match(ATTR_IMPORTANCE_REGEX);
        const episodeType = episodeMatch ? unescapeXml(episodeMatch[1]) : undefined;
        const importance = importanceMatch ? parseInt(importanceMatch[1], 10) : undefined;

        // v2 tiered shape: at least <p1> present.
        const { p1, p2, p3, p4 } = extractTiersFromInner(inner);
        if (typeof p1 === "string" && p1.length > 0) {
            compartments.push({
                startMessage,
                endMessage,
                title,
                content: p1, // content mirrors P1 (fullest tier) for v2 rows
                p1,
                // Fall back denser→denser for any missing middle tier so storage
                // always has 4 non-undefined tiers; p4 may legitimately be "".
                p2: typeof p2 === "string" ? p2 : p1,
                p3: typeof p3 === "string" ? p3 : typeof p2 === "string" ? p2 : p1,
                p4: typeof p4 === "string" ? p4 : "",
                importance,
                episodeType,
            });
            continue;
        }

        // v1/flat shape (compressor output, legacy, or historian that didn't emit tiers).
        const content = unescapeXml(inner.trim());
        if (content) {
            compartments.push({
                startMessage,
                endMessage,
                title,
                content,
                importance,
                episodeType,
            });
        }
    }

    // Scope category extraction to the <facts> block. Category tags
    // (PROJECT_RULES, ARCHITECTURE, …) can legitimately appear inside <events>
    // field text or compartment bodies; scanning the whole response would
    // misread those as promotable facts. When there is no <facts> block we fall
    // back to scanning the full text for backward-compat with outputs that emit
    // bare category blocks (older/transition shapes) — but only outside the
    // events block, which we strip first to avoid the cross-read.
    // Every side channel is read outside the compartment elements.
    const outside = textOutsideCompartments(text, elements);
    const factsBlockMatch = outside.match(FACTS_BLOCK_REGEX);
    // When a <facts> block is present (the v2 norm), scope extraction to it.
    // The fallback (legacy/transition outputs with bare category blocks) strips
    // events and side channels first (compartment bodies are already gone) —
    // otherwise a category tag in narrative prose or metadata would be misread
    // as a fact.
    const factsScope = factsBlockMatch
        ? factsBlockMatch[1]
        : outside
              .replace(EVENTS_BLOCK_REGEX, "")
              .replace(/<(meta|user_observations|primer_candidates)>.*?<\/\1>/gs, "")
              .replace(/<\/?(?:output|compartments)>/g, "");
    for (const categoryMatch of factsScope.matchAll(CATEGORY_BLOCK_REGEX)) {
        const category = categoryMatch[1];
        const blockContent = categoryMatch[2];
        const items = factItems(blockContent);
        if (!HISTORIAN_CATEGORIES.has(category)) {
            if (items.length === 0) continue;
            droppedFactBlocks++;
            droppedFacts += items.length;
            log(`[historian] Dropped <facts> category ${category} (${items.length} facts)`);
            continue;
        }
        for (const item of items) {
            const { content, anchor } = splitFactAnchorPrefix(item);
            if (!content) continue;
            facts.push(anchor ? { category, content, anchor } : { category, content });
        }
    }

    const unprocessedMatch = outside.match(UNPROCESSED_REGEX);
    const unprocessedFrom = unprocessedMatch ? parseInt(unprocessedMatch[1], 10) : null;

    const userObservations: string[] = [];
    const userObsMatch = outside.match(USER_OBSERVATIONS_REGEX);
    if (userObsMatch) {
        for (const itemMatch of userObsMatch[1].matchAll(USER_OBS_ITEM_REGEX)) {
            const obs = unescapeXml(itemMatch[1].trim());
            if (obs) userObservations.push(obs);
        }
    }

    const primerCandidates: ParsedPrimerCandidate[] = [];
    const primerMatch = outside.match(PRIMER_CANDIDATES_REGEX);
    if (primerMatch) {
        const block = primerMatch[1];
        // Preferred: <primer at_compartment="N">…</primer> with origin ordinal.
        let sawElement = false;
        for (const el of block.matchAll(PRIMER_ELEMENT_REGEX)) {
            sawElement = true;
            const question = unescapeXml(el[2].trim());
            if (question) {
                primerCandidates.push({
                    question,
                    originCompartmentIndex: Number.parseInt(el[1], 10),
                });
            }
        }
        // Legacy bullet form (no origin tag) — only if no element form was used,
        // so an element-form question isn't also captured as a bullet line.
        if (!sawElement) {
            for (const itemMatch of block.matchAll(PRIMER_ITEM_REGEX)) {
                const question = unescapeXml(itemMatch[1].trim());
                if (question) primerCandidates.push({ question });
            }
        }
    }

    const events = parseEvents(outside);

    // Compartments are returned sorted by start, but `at_compartment` anchors
    // count compartments in the order the model emitted them. When the model
    // emits them out of order, re-point each in-range anchor at the same
    // compartment's sorted position, since every consumer indexes the sorted
    // list. Out-of-range anchors are left for validation to discard. The Rust
    // parser (`historian_validate::parse_compartment_output`) does the same.
    const sortedByStart = compartments
        .map((compartment, emitted) => ({ compartment, emitted }))
        .sort((a, b) => a.compartment.startMessage - b.compartment.startMessage);
    const sortedPosition: number[] = [];
    sortedByStart.forEach(({ emitted }, sorted) => {
        sortedPosition[emitted] = sorted + 1;
    });
    const remapAnchor = (anchor: number): number =>
        anchor >= 1 && anchor <= sortedPosition.length ? sortedPosition[anchor - 1] : anchor;

    return {
        compartments: sortedByStart.map(({ compartment }) => compartment),
        facts: facts.map((fact) =>
            fact.anchor
                ? {
                      ...fact,
                      anchor: {
                          ...fact.anchor,
                          compartmentIndex: remapAnchor(fact.anchor.compartmentIndex),
                      },
                  }
                : fact,
        ),
        droppedFactBlocks,
        droppedFacts,
        events: events.map((event) =>
            event.atCompartment === null
                ? event
                : { ...event, atCompartment: remapAnchor(event.atCompartment) },
        ),
        unprocessedFrom,
        userObservations,
        primerCandidates: primerCandidates.map((candidate) =>
            candidate.originCompartmentIndex === undefined
                ? candidate
                : {
                      ...candidate,
                      originCompartmentIndex: remapAnchor(candidate.originCompartmentIndex),
                  },
        ),
    };
}

/**
 * Parse the optional <events> block. Each direct child element with an
 * `at_compartment` attribute is an event; its own child elements become
 * `fields`. Kind-agnostic so new event kinds/fields need no parser change.
 * Returns [] when there is no <events> block (the common case).
 */
function parseEvents(text: string): ParsedEvent[] {
    const blockMatch = text.match(EVENTS_BLOCK_REGEX);
    if (!blockMatch) return [];
    const block = blockMatch[1];
    const events: ParsedEvent[] = [];
    for (const elMatch of block.matchAll(EVENT_ELEMENT_REGEX)) {
        const kind = elMatch[1];
        const atRaw = parseInt(elMatch[2], 10);
        const atCompartment = Number.isNaN(atRaw) ? null : atRaw;
        const fields: Record<string, string> = {};
        for (const fieldMatch of elMatch[3].matchAll(EVENT_FIELD_REGEX)) {
            const name = fieldMatch[1];
            const value = unescapeXml(fieldMatch[2].trim());
            if (value) fields[name] = value;
        }
        events.push({ kind, atCompartment, fields });
    }
    return events;
}
