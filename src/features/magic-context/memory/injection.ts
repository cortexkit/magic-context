import type { Database } from "bun:sqlite";
import { log } from "../../../shared/logger";
import { CATEGORY_PRIORITY } from "./constants";
import { getMemoriesByProject } from "./storage-memory";
import type { Memory, MemoryCategory } from "./types";

function escapeXml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
}

function renderMemoryBlock(memoriesByCategory: Map<MemoryCategory, Memory[]>): string | null {
    const sections: string[] = [];

    for (const category of CATEGORY_PRIORITY) {
        const memories = memoriesByCategory.get(category);
        if (!memories || memories.length === 0) {
            continue;
        }

        sections.push(
            `<${category}>`,
            ...memories.map((memory) => `- ${escapeXml(memory.content)}`),
            `</${category}>`,
        );
    }

    if (sections.length === 0) {
        return null;
    }

    return `<project-memory>\n${sections.join("\n")}\n</project-memory>`;
}

function groupMemoriesByCategory(memories: Memory[]): Map<MemoryCategory, Memory[]> {
    const memoriesByCategory = new Map<MemoryCategory, Memory[]>();

    for (const memory of memories) {
        const existing = memoriesByCategory.get(memory.category);
        if (existing) {
            existing.push(memory);
            continue;
        }

        memoriesByCategory.set(memory.category, [memory]);
    }

    return memoriesByCategory;
}

function dedupeMemories(memories: Memory[]): Memory[] {
    const seen = new Set<string>();
    const deduped: Memory[] = [];

    for (const memory of memories) {
        if (seen.has(memory.normalizedHash)) {
            continue;
        }

        seen.add(memory.normalizedHash);
        deduped.push(memory);
    }

    return deduped;
}

/**
 * Build the <project-memory> XML injection block from stored memories.
 * Returns null if no memories are available for the project.
 *
 * Budget is in approximate tokens (~3.5 chars per token).
 */
export function buildMemoryInjectionBlock(
    db: Database,
    projectPath: string,
    budgetTokens: number,
): string | null {
    const mergedMemories = dedupeMemories([
        ...getMemoriesByProject(db, projectPath, ["active", "permanent"]),
        ...getMemoriesByProject(db, "__global__", ["active", "permanent"]),
    ]);

    if (mergedMemories.length === 0) {
        return null;
    }

    const memoriesByCategory = groupMemoriesByCategory(mergedMemories);
    let block = renderMemoryBlock(memoriesByCategory);

    if (!block) {
        return null;
    }

    const initialTokens = estimateTokens(block);
    if (initialTokens <= budgetTokens) {
        return block;
    }

    for (let priorityIndex = CATEGORY_PRIORITY.length - 1; priorityIndex >= 0; priorityIndex -= 1) {
        const category = CATEGORY_PRIORITY[priorityIndex]!;
        const memories = memoriesByCategory.get(category);
        if (!memories || memories.length === 0) {
            continue;
        }

        const minimumToKeep = category === "USER_DIRECTIVES" ? 1 : 0;

        while (memories.length > minimumToKeep) {
            memories.pop();

            if (memories.length === 0) {
                memoriesByCategory.delete(category);
            }

            block = renderMemoryBlock(memoriesByCategory);
            if (!block) {
                return null;
            }

            if (estimateTokens(block) <= budgetTokens) {
                log(
                    `[magic-context] pruned project-memory block from ${initialTokens} to ${estimateTokens(block)} tokens`,
                );
                return block;
            }
        }
    }

    if (block && estimateTokens(block) < initialTokens) {
        log(
            `[magic-context] pruned project-memory block from ${initialTokens} to ${estimateTokens(block)} tokens`,
        );
    }

    return block;
}
