export interface ParsedCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
}

export interface ParsedFact {
    category: string;
    content: string;
}

export interface ParsedCompartmentOutput {
    compartments: ParsedCompartment[];
    facts: ParsedFact[];
    unprocessedFrom: number | null;
    userObservations: string[];
}

const COMPARTMENT_REGEX =
    /<compartment\s+(?:id="[^"]*"\s+)?start="(\d+)"\s+end="(\d+)"\s+title="([^"]+)"\s*>(.*?)<\/compartment>/gs;
const CATEGORY_BLOCK_REGEX =
    /<(WORKFLOW_RULES|ARCHITECTURE_DECISIONS|CONSTRAINTS|CONFIG_DEFAULTS|KNOWN_ISSUES|ENVIRONMENT|NAMING|USER_PREFERENCES|USER_DIRECTIVES)>(.*?)<\/\1>/gs;
const FACT_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;
const UNPROCESSED_REGEX = /<unprocessed_from>(\d+)<\/unprocessed_from>/;
const USER_OBSERVATIONS_REGEX = /<user_observations>(.*?)<\/user_observations>/s;
const USER_OBS_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;

export function parseCompartmentOutput(text: string): ParsedCompartmentOutput {
    const compartments: ParsedCompartment[] = [];
    const facts: ParsedFact[] = [];

    for (const match of text.matchAll(COMPARTMENT_REGEX)) {
        const startMessage = parseInt(match[1], 10);
        const endMessage = parseInt(match[2], 10);
        const title = unescapeXml(match[3]);
        const content = unescapeXml(match[4].trim());

        if (!Number.isNaN(startMessage) && !Number.isNaN(endMessage) && title && content) {
            compartments.push({ startMessage, endMessage, title, content });
        }
    }

    for (const categoryMatch of text.matchAll(CATEGORY_BLOCK_REGEX)) {
        const category = categoryMatch[1];
        const blockContent = categoryMatch[2];
        for (const itemMatch of blockContent.matchAll(FACT_ITEM_REGEX)) {
            const content = unescapeXml(itemMatch[1].trim());
            if (content) {
                facts.push({ category, content });
            }
        }
    }

    const unprocessedMatch = text.match(UNPROCESSED_REGEX);
    const unprocessedFrom = unprocessedMatch ? parseInt(unprocessedMatch[1], 10) : null;

    const userObservations: string[] = [];
    const userObsMatch = text.match(USER_OBSERVATIONS_REGEX);
    if (userObsMatch) {
        for (const itemMatch of userObsMatch[1].matchAll(USER_OBS_ITEM_REGEX)) {
            const obs = unescapeXml(itemMatch[1].trim());
            if (obs) userObservations.push(obs);
        }
    }

    compartments.sort((a, b) => a.startMessage - b.startMessage);

    return { compartments, facts, unprocessedFrom, userObservations };
}

function unescapeXml(s: string): string {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}
