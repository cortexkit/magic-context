import { escapeXmlAttr, escapeXmlContent } from "../../features/magic-context/compartment-storage";
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
    memoryBlock?: string,
): string {
    const lines: string[] = [];

    // Project memories are read-only reference for deduplication — historian must not modify them
    if (memoryBlock) {
        lines.push(
            "<!-- Project memories below are READ-ONLY reference. Do NOT emit them in output. Drop any session fact already covered by a project memory. -->",
        );
        lines.push(memoryBlock);
        lines.push("");
    }

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
            "<!-- Rewrite all facts below into canonical present-tense operational form. Do not copy wording verbatim. Drop stale or task-local facts. Drop facts already covered by project memories above. -->",
        );
        lines.push("");
    }

    for (const [category, items] of factsByCategory) {
        lines.push(`<${category}>`);
        for (const item of items) lines.push(`* ${escapeXmlContent(item)}`);
        lines.push(`</${category}>`);
        lines.push("");
    }

    return lines.join("\n");
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
