import type { Database } from "bun:sqlite";
import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
import { getSessionNotes } from "../../features/magic-context/storage";
import type { CandidateCompartment } from "./compartment-runner-types";

export function buildExistingStateXml(
    compartments: Array<{
        startMessage: number;
        endMessage: number;
        startMessageId: string;
        endMessageId: string;
        title: string;
        content: string;
    }>,
    facts: Array<{ category: string; content: string }>,
    notes: string[],
): string {
    const lines: string[] = [];

    for (const c of compartments) {
        lines.push(
            `<compartment start="${c.startMessage}" end="${c.endMessage}" title="${escapeXmlAttr(c.title)}">`,
        );
        lines.push(escapeXmlContent(c.content));
        lines.push("</compartment>");
        lines.push("");
    }

    const factsByCategory = new Map<string, string[]>();
    for (const f of facts) {
        const existing = factsByCategory.get(f.category) ?? [];
        existing.push(f.content);
        factsByCategory.set(f.category, existing);
    }

    if (factsByCategory.size > 0) {
        lines.push(
            "<!-- Rewrite all facts below into canonical present-tense operational form. Do not copy wording verbatim. Drop stale or task-local facts. -->",
        );
        lines.push("");
    }

    for (const [category, items] of factsByCategory) {
        lines.push(`<${category}>`);
        for (const item of items) lines.push(`* ${escapeXmlContent(item)}`);
        lines.push(`</${category}>`);
        lines.push("");
    }

    if (notes.length > 0) {
        lines.push(
            "<!-- Rewrite notes into concise session scratchpad items only when they remain useful after updating compartments and facts. -->",
        );
        lines.push("");
        lines.push("<session_notes>");
        for (const note of notes) lines.push(`* ${escapeXmlContent(note)}`);
        lines.push("</session_notes>");
        lines.push("");
    }

    return lines.join("\n");
}

export function resolveNotesToPersist(
    db: Database,
    sessionId: string,
    snapshotNotes: string[],
    historianNotes: string[],
): string[] {
    const liveNotes = getSessionNotes(db, sessionId).map((note) => note.content);
    if (noteListsEqual(liveNotes, snapshotNotes)) {
        return historianNotes;
    }
    return liveNotes;
}

function noteListsEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

export function mergePriorCompartments(
    priorCompartments: Array<{
        startMessage: number;
        endMessage: number;
        startMessageId: string;
        endMessageId: string;
        title: string;
        content: string;
    }>,
    newCompartments: CandidateCompartment[],
): CandidateCompartment[] {
    return [
        ...priorCompartments.map((c, i) => ({
            sequence: i,
            startMessage: c.startMessage,
            endMessage: c.endMessage,
            startMessageId: c.startMessageId,
            endMessageId: c.endMessageId,
            title: c.title,
            content: c.content,
        })),
        ...newCompartments,
    ];
}
