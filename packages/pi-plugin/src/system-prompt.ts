/**
 * Pi-side system prompt injector.
 *
 * Hooks `before_agent_start` to append a `<magic-context>` block to the
 * fully-assembled system prompt. The block carries:
 *
 *   - `<project-memory>`: project-scoped memories (categorized, budget-trimmed)
 *   - `<project-docs>`: dreamer-maintained ARCHITECTURE.md and STRUCTURE.md
 *     from the project root (when present)
 *
 * Spike scope (Step 4a): no compartments, no session facts, no key files,
 * no user profile. Those depend on the message-transform pipeline (Step 4b)
 * or pi-plugin dreamer/historian wiring (Step 5+). Cross-harness memory
 * sharing means a memory written from OpenCode in this project shows up
 * here on the next agent turn.
 *
 * Cache stability is intentionally not a concern at this stage — Pi doesn't
 * use Anthropic-style prompt caching the same way OpenCode does. We re-read
 * docs and re-fetch memories each turn. If/when this becomes a real cost,
 * we can add cache-aware blocks similar to OpenCode's `memory_block_cache`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getMemoriesByProject,
	type Memory,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type {
	ContextDatabase,
	SessionFact,
} from "@magic-context/core/features/magic-context/storage";
import { renderMemoryBlock } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { log } from "@magic-context/core/shared/logger";

const DOC_FILES = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;

/** Approx ~4000 token budget for memories — matches OpenCode default. */
const DEFAULT_MEMORY_BUDGET_CHARS = 4000 * 3.5;

/**
 * Read project docs from `directory`. Returns the assembled XML block or null.
 */
function readProjectDocs(directory: string): string | null {
	const sections: string[] = [];

	for (const filename of DOC_FILES) {
		const filePath = join(directory, filename);
		try {
			if (existsSync(filePath)) {
				const content = readFileSync(filePath, "utf-8").trim();
				if (content.length > 0) {
					sections.push(`<${filename}>\n${content}\n</${filename}>`);
				}
			}
		} catch (error) {
			log(`[magic-context-pi] failed to read ${filename}:`, error);
		}
	}

	if (sections.length === 0) return null;
	return `<project-docs>\n${sections.join("\n\n")}\n</project-docs>`;
}

/**
 * Trim memories by total content length so the injected `<project-memory>`
 * block stays under a rough char budget. This is intentionally simpler than
 * the OpenCode-side trimming logic — the spike just proves that memories
 * appear in Pi context. Real budget math, utility tiers, and cache
 * stability can move in once the Pi-side pipeline matures.
 */
function trimMemoriesByCharBudget(
	memories: Memory[],
	budget: number,
): Memory[] {
	const sorted = [...memories].sort((a, b) => {
		// permanent first
		if (a.status === "permanent" && b.status !== "permanent") return -1;
		if (b.status === "permanent" && a.status !== "permanent") return 1;
		// shorter first (fit more)
		return a.content.length - b.content.length;
	});

	const result: Memory[] = [];
	let used = 0;
	for (const m of sorted) {
		const cost = m.content.length + 16; // rough overhead for "- " + tags amortized
		if (used + cost > budget) break;
		result.push(m);
		used += cost;
	}
	return result;
}

export interface BuildMagicContextBlockOptions {
	db: ContextDatabase;
	cwd: string;
	/** When true, include `<project-memory>` in the block. */
	memoryEnabled: boolean;
	/** When true, include `<project-docs>` (reads ARCHITECTURE.md / STRUCTURE.md from cwd). */
	injectDocs: boolean;
	/** Char budget for the rendered `<project-memory>` block. */
	memoryBudgetChars?: number;
}

/**
 * Build the `<magic-context>...</magic-context>` block to append to the
 * system prompt for one Pi agent turn. Returns null if there's nothing to
 * inject.
 */
export function buildMagicContextBlock(
	opts: BuildMagicContextBlockOptions,
): string | null {
	const sections: string[] = [];

	if (opts.memoryEnabled) {
		const projectIdentity = resolveProjectIdentity(opts.cwd);
		const allMemories = getMemoriesByProject(opts.db, projectIdentity);
		if (allMemories.length > 0) {
			const trimmed = trimMemoriesByCharBudget(
				allMemories,
				opts.memoryBudgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS,
			);
			const memoryBlock = renderMemoryBlock(trimmed);
			if (memoryBlock) sections.push(memoryBlock);
		}
	}

	if (opts.injectDocs) {
		const docsBlock = readProjectDocs(opts.cwd);
		if (docsBlock) sections.push(docsBlock);
	}

	if (sections.length === 0) return null;

	return `<magic-context>\n${sections.join("\n\n")}\n</magic-context>`;
}

// --- session facts helper, unused for now but exported for Step 4b ---
export function _hasSessionFacts(facts: SessionFact[]): boolean {
	return facts.length > 0;
}
