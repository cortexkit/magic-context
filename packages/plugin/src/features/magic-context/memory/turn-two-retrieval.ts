/** Turn-two retrieval ranks relevant candidates, without filling empty slots with keyword noise. */
import type { Database } from "../../../shared/sqlite";
import { cosineSimilarity } from "./cosine-similarity";
import { getProjectEmbeddings } from "./embedding-cache";
import { NEIGHBOUR_SHORTLIST_CAP } from "./lifecycle-constants";
import { getMemoryById } from "./storage-memory";
import { searchMemoriesFTS } from "./storage-memory-fts";
import type { TurnTwoPromptNeighbour } from "./turn-two-envelope";

/** Embeds one query text under the project's current embedding model. */
export type TurnTwoQueryEmbedder = (
    text: string,
) => Promise<{ vector: Float32Array; modelId: string } | null>;

function neighbourOf(db: Database, id: number): TurnTwoPromptNeighbour | null {
    const memory = getMemoryById(db, id);
    if (!memory || memory.status === "archived") return null;
    const row = db.prepare("SELECT revision FROM memories WHERE id=?").get(id) as {
        revision: number;
    } | null;
    return {
        id: memory.id,
        revision: row?.revision ?? 1,
        category: memory.category,
        content: memory.content,
    };
}

export interface TurnTwoNeighbourResult {
    neighbours: TurnTwoPromptNeighbour[];
    lexicalOnly: boolean;
}

const STOP_WORDS = new Set(
    "a an the is are was were be been to of for in on at with by from and or not no it its this that as must should always never use only project user agent when after before every all can do does into than then same both".split(
        " ",
    ),
);
export const TURN_TWO_NEIGHBOUR_LIMIT = 3;
function terms(text: string): Set<string> {
    return new Set(
        (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
            (word) => word.length > 2 && !STOP_WORDS.has(word),
        ),
    );
}

/** Require substantial shared subject matter; a lone generic keyword is not a neighbour. */
export function rankTurnTwoNeighbours(
    fact: string,
    candidates: TurnTwoPromptNeighbour[],
    semanticScores = new Map<number, number>(),
): TurnTwoPromptNeighbour[] {
    const query = terms(fact);
    return candidates
        .map((neighbour) => {
            const words = terms(neighbour.content);
            const shared = [...query].filter((word) => words.has(word));
            const lexical = shared.length / Math.max(1, query.size);
            const semantic = semanticScores.get(neighbour.id) ?? 0;
            const relevant =
                (shared.length >= Math.min(2, query.size) && lexical >= 0.35 && query.size > 0) ||
                semantic >= 0.75;
            return { neighbour, score: Math.max(lexical, semantic), relevant };
        })
        .filter((entry) => entry.relevant)
        .sort((a, b) => b.score - a.score || a.neighbour.id - b.neighbour.id)
        .slice(0, TURN_TWO_NEIGHBOUR_LIMIT)
        .map((entry) => entry.neighbour);
}

export async function retrieveTurnTwoNeighbours(
    db: Database,
    projectPath: string,
    factText: string,
    embedQuery: TurnTwoQueryEmbedder | undefined,
): Promise<TurnTwoNeighbourResult> {
    const lexical = searchMemoriesFTS(db, projectPath, factText, NEIGHBOUR_SHORTLIST_CAP)
        .filter((memory) => memory.status !== "archived")
        .map((memory) => memory.id);
    let semantic: number[] | null = null;
    const semanticScores = new Map<number, number>();
    const query = embedQuery ? await embedQuery(factText).catch(() => null) : null;
    if (query) {
        const stored = getProjectEmbeddings(db, projectPath, query.modelId);
        if (stored.size > 0) {
            semantic = [...stored.entries()]
                .filter(([, entry]) => entry.embedding.length === query.vector.length)
                .map(([id, entry]) => ({
                    id,
                    score: cosineSimilarity(query.vector, entry.embedding),
                }))
                .sort((a, b) => b.score - a.score || a.id - b.id)
                .map((entry) => {
                    semanticScores.set(entry.id, entry.score);
                    return entry.id;
                });
        }
    }
    const ordered: number[] = [];
    const add = (id: number) => {
        if (ordered.length < NEIGHBOUR_SHORTLIST_CAP * 2 && !ordered.includes(id)) ordered.push(id);
    };
    for (const id of lexical) add(id);
    for (const id of semantic ?? []) {
        if (ordered.length >= NEIGHBOUR_SHORTLIST_CAP * 2) break;
        if (neighbourOf(db, id)?.id === id) add(id);
    }
    const neighbours = ordered.flatMap((id) => {
        const neighbour = neighbourOf(db, id);
        return neighbour && getMemoryById(db, id)?.projectPath === projectPath ? [neighbour] : [];
    });
    return {
        neighbours: rankTurnTwoNeighbours(factText, neighbours, semanticScores),
        lexicalOnly: semantic === null || semantic.length === 0,
    };
}
