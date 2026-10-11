/// <reference path="./rescore-prompt-text.d.ts" />
import { createHash, randomUUID } from "node:crypto";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import { renderSeedExamplesBlock, selectSeeds } from "./reference-retrieval";
import source from "./rescore-prompt.source.md" with { type: "text" };

export const RESCORE_SYSTEM_PROMPT = source.trim();
export const RESCORE_FRAMING =
    "Judge every candidate independently. Return exactly the requested handles as JSON, without rewriting any candidate.";
export const RESCORE_PROMPT_HASH = createHash("sha256")
    .update(`${RESCORE_SYSTEM_PROMPT}\n\0${RESCORE_FRAMING}`)
    .digest("hex");
export type RescoreScore = { handle: string; importance: number; reason: string };
export type RescoreCandidate = { handle: string; title: string; episode_type: string; p1: string };

export function rescoreCandidate(
    row: Compartment,
    handle: string = randomUUID(),
): RescoreCandidate {
    return { handle, title: row.title, episode_type: row.episodeType ?? "", p1: row.p1 ?? "" };
}

export function buildRescorePrompt(candidates: RescoreCandidate[], key: string, batch: number) {
    const seeds = selectSeeds(key, batch, 3);
    return {
        seedIds: seeds.map((seed) => createHash("sha256").update(seed.block).digest("hex")),
        prompt: `${renderSeedExamplesBlock(seeds)}\n\n<candidates>\n${JSON.stringify(candidates)}\n</candidates>\n${RESCORE_FRAMING}`,
    };
}

export function validateRescoreScores(text: string, handles: string[]): RescoreScore[] {
    // Error messages deliberately omit the response: reasons are private staging data.
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("Invalid score JSON");
    }
    const remaining = new Set(handles);
    if (
        !Array.isArray(value) ||
        value.length !== handles.length ||
        remaining.size !== handles.length
    ) {
        throw new Error("Invalid score count");
    }
    const scores: RescoreScore[] = [];
    for (const item of value) {
        if (
            !item ||
            typeof item !== "object" ||
            Object.keys(item).sort().join(",") !== "handle,importance,reason" ||
            typeof item.handle !== "string" ||
            !remaining.delete(item.handle) ||
            !Number.isInteger(item.importance) ||
            item.importance < 1 ||
            item.importance > 100 ||
            typeof item.reason !== "string" ||
            !item.reason.trim() ||
            item.reason.length > 300 ||
            /[\r\n]/.test(item.reason)
        ) {
            throw new Error("Invalid, duplicate or unsolicited score");
        }
        scores.push({
            handle: item.handle,
            importance: item.importance,
            reason: item.reason.trim(),
        });
    }
    if (remaining.size) throw new Error("Missing score handles");
    return scores;
}
