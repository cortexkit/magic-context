/**
 * Seed assembly for the open-book refresh-primers investigation.
 *
 * The seed is ORIENTATION, not the answer source: it tells the investigator
 * WHERE the question arose and WHAT the main agent read — then the investigator
 * re-reads CURRENT source to ground the answer. Two structural guarantees make
 * "current source is truth, not the old chunk's conclusions" enforceable instead
 * of merely prompted:
 *
 *  1. The orientation seed renders ONLY `U:` (what was asked) and `TC:` (which
 *     files/symbols were read) lines — the assistant's old `A:` conclusions are
 *     NEVER rendered, so the model cannot paraphrase them. (The standard chunk
 *     formatter interleaves A: narrative with TC: in one block, so this needs a
 *     dedicated renderer, not a line filter.)
 *  2. TC: shows tool INPUTS only (no outputs) — already the formatter default.
 *
 * Raw availability: reading old origin raw works on OpenCode (compaction markers
 * filter summary rows, they don't delete message/part rows). When the raw range
 * is empty (deleted session, or Pi-only with no provider registered), we fall
 * back to a closed-book seed (origin compartment P1) rather than silently
 * proceeding with an empty orientation.
 */
import { askAnswerLines } from "../../../hooks/magic-context/ask-answer-notice";
import {
    cleanUserText,
    visitRawSessionMessages,
    visitRawSessionMessagesAsync,
} from "../../../hooks/magic-context/read-session-chunk";
import {
    estimateTokens,
    extractTexts,
    extractToolCallSummaries,
    hasMeaningfulUserText,
    normalizeText,
} from "../../../hooks/magic-context/read-session-formatting";
import type { RawMessage } from "../../../hooks/magic-context/read-session-raw";
import type { Database } from "../../../shared/sqlite";
import { getPrimerCandidatesByIds, type Primer, type PrimerCandidate } from "../storage-primers";

/** Token cap for the rendered orientation seed — a huge origin compartment must
 *  not blow the prompt; the investigator digs via tools, it does not need the
 *  whole chunk inline. */
export const PRIMER_SEED_CAP_TOKENS = 4000;

export interface PrimerSeed {
    /** "raw" = U:/TC: orientation from the origin compartment; "closed-book" =
     *  origin compartment P1 (raw unavailable). */
    kind: "raw" | "closed-book";
    /** The orientation block (already token-capped). */
    orientation: string;
    /** P1 of the immediately-preceding and -following compartments, for context. */
    prePost: string;
    /** Session + ordinal range the orientation came from (for logging). */
    sessionId: string | null;
}

interface CompartmentP1Row {
    sequence: number;
    start_message: number;
    end_message: number;
    title: string;
    p1: string | null;
    content: string | null;
}

/**
 * Render ONLY user text (`U:`) and tool-call summaries (`TC:`) for the raw
 * messages in [startOrdinal, endOrdinal]. Assistant narrative is structurally
 * excluded — there is no code path that emits an `A:` line here.
 *
 * The range is streamed page by page in the summary projection and reading
 * stops at the token cap, so a huge origin compartment (or a session with
 * thousands of multi-kilobyte tool outputs) never sits in memory at once.
 * Returns null when no message exists in the range.
 */
function renderUserAndToolOrientation(
    sessionId: string,
    startOrdinal: number,
    endOrdinal: number,
    capTokens: number,
): string | null {
    const renderer = orientationRenderer(capTokens);
    visitRawSessionMessages(sessionId, startOrdinal, endOrdinal, renderer.visit, {
        summary: true,
    });
    return renderer.result();
}

function orientationRenderer(capTokens: number) {
    const lines: string[] = [];
    let tokens = 0;
    let sawMessage = false;
    return {
        visit: (msg: RawMessage) => {
            sawMessage = true;
            const out: string[] = [];
            if (msg.role === "user" && hasMeaningfulUserText(msg.parts)) {
                const rawTexts = extractTexts(msg.parts);
                const parts = rawTexts
                    .map((t) => cleanUserText(t))
                    .map(normalizeText)
                    .filter((t) => t.length > 0);
                // The user's answer to a parked ask is the one thing cleaning
                // would drop, so its line follows the user's own words.
                parts.push(...rawTexts.flatMap((t) => askAnswerLines(t)).map(normalizeText));
                const text = parts.filter((t) => t.length > 0).join(" / ");
                if (text) out.push(`U: ${text}`);
            }
            // Tool-call inputs (no outputs) — what the agent looked at. Applies to
            // both assistant tool-use messages and tool-result user messages.
            for (const tc of extractToolCallSummaries(msg.parts)) out.push(tc);
            for (const line of out) {
                const lineTokens = estimateTokens(line);
                if (tokens + lineTokens > capTokens && lines.length > 0) {
                    lines.push(
                        "… (orientation truncated; investigate the current source directly)",
                    );
                    return false;
                }
                lines.push(line);
                tokens += lineTokens;
            }
            return true;
        },
        result: () => (sawMessage ? lines.join("\n") : null),
    };
}

/**
 * The candidate whose origin compartment seeds the investigation: the most
 * recent occurrence that belongs to the primer's own project. A candidate
 * recorded under another project is never used, so building a seed can never
 * read another project's session history.
 */
export function selectPrimerOriginCandidate(
    db: Database,
    primer: Primer,
): PrimerCandidate | undefined {
    return getPrimerCandidatesByIds(db, primer.sourceCandidateIds)
        .filter((candidate) => candidate.projectPath === primer.projectPath)
        .sort((a, b) => b.sourceMessageTime - a.sourceMessageTime || b.id - a.id)[0];
}
function loadPrePostP1(db: Database, sessionId: string, originStartMessage: number): string {
    const origin = db
        .prepare(
            "SELECT sequence FROM compartments WHERE session_id = ? AND start_message = ? ORDER BY sequence ASC LIMIT 1",
        )
        .get(sessionId, originStartMessage) as { sequence?: number } | undefined;
    if (typeof origin?.sequence !== "number") return "";
    const originSeq = origin.sequence;
    const rows = db
        .prepare(
            `SELECT sequence, start_message, end_message,
                    substr(title, 1, 512) AS title,
                    substr(p1, 1, 1200) AS p1, substr(content, 1, 1200) AS content
             FROM compartments
             WHERE session_id = ? AND sequence IN (?, ?)
             ORDER BY sequence ASC`,
        )
        .all(sessionId, originSeq - 1, originSeq + 1) as CompartmentP1Row[];
    if (rows.length === 0) return "";
    return rows
        .map((r) => {
            const body = (r.p1 ?? r.content ?? "").slice(0, 1200);
            const label = r.sequence < originSeq ? "before" : "after";
            return `- (${label}) ${r.title}: ${body}`;
        })
        .join("\n");
}

function closedBookOriginP1(
    db: Database,
    sessionId: string,
    originStartMessage: number,
): { orientation: string; sessionId: string } {
    const row = db
        .prepare(
            `SELECT substr(title, 1, 512) AS title,
                    substr(p1, 1, 2000) AS p1, substr(content, 1, 2000) AS content
             FROM compartments WHERE session_id = ? AND start_message = ? ORDER BY sequence ASC LIMIT 1`,
        )
        .get(sessionId, originStartMessage) as
        | { title?: string; p1?: string | null; content?: string | null }
        | undefined;
    const body = (row?.p1 ?? row?.content ?? "").slice(0, 2000);
    const orientation = row?.title ? `${row.title}: ${body}` : body;
    return { orientation, sessionId };
}

/**
 * Build the orientation seed for a primer from its most-recent same-project
 * occurrence's origin compartment. On Pi, a RawMessageProvider must be
 * registered for the session; Pi never falls back to OpenCode's store.
 */
export function buildPrimerSeed(db: Database, primer: Primer): PrimerSeed {
    return buildPrimerSeedUsing(
        db,
        selectPrimerOriginCandidate(db, primer),
        renderUserAndToolOrientation,
    );
}

/** Await historical messages, render U:/TC: orientation, and fall back to compartment P1 if absent. */
export async function buildPrimerSeedAsync(db: Database, primer: Primer): Promise<PrimerSeed> {
    const mostRecent = selectPrimerOriginCandidate(db, primer);
    let orientation: string | null = null;
    if (
        mostRecent &&
        typeof mostRecent.sourceCompartmentStart === "number" &&
        typeof mostRecent.sourceCompartmentEnd === "number"
    ) {
        try {
            const renderer = orientationRenderer(PRIMER_SEED_CAP_TOKENS);
            await visitRawSessionMessagesAsync(
                mostRecent.sessionId,
                mostRecent.sourceCompartmentStart,
                mostRecent.sourceCompartmentEnd,
                renderer.visit,
                { summary: true },
            );
            orientation = renderer.result();
        } catch {
            orientation = null;
        }
    }
    return buildPrimerSeedUsing(db, mostRecent, () => orientation);
}

function buildPrimerSeedUsing(
    db: Database,
    mostRecent: PrimerCandidate | undefined,
    render: typeof renderUserAndToolOrientation,
): PrimerSeed {
    // Most-recent occurrence drives the seed (freshest code context).
    if (
        !mostRecent ||
        typeof mostRecent.sourceCompartmentStart !== "number" ||
        typeof mostRecent.sourceCompartmentEnd !== "number"
    ) {
        return {
            kind: "closed-book",
            orientation: "",
            prePost: "",
            sessionId: null,
        };
    }

    const sessionId = mostRecent.sessionId;
    const start = mostRecent.sourceCompartmentStart;
    const end = mostRecent.sourceCompartmentEnd;

    let orientation: string | null = null;
    try {
        orientation = render(sessionId, start, end, PRIMER_SEED_CAP_TOKENS);
    } catch {
        orientation = null;
    }
    if (orientation === null) {
        // Deleted session, or Pi with no provider registered: do NOT proceed with
        // an empty orientation — fall back to the origin compartment's P1.
        const closed = closedBookOriginP1(db, sessionId, start);
        return {
            kind: "closed-book",
            orientation: closed.orientation,
            prePost: loadPrePostP1(db, sessionId, start),
            sessionId,
        };
    }

    return {
        kind: "raw",
        orientation,
        prePost: loadPrePostP1(db, sessionId, start),
        sessionId,
    };
}
