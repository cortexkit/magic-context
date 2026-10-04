/**
 * The context Magic Context hands Claude Code when a session starts, resumes,
 * is cleared or has just been compacted: usage guidance, the project's memory
 * and this session's notes.
 *
 * It is rendered with the same functions OpenCode and Pi use for `<project-memory>`
 * (selection by priority, a token budget, workspace sharing), so a memory reads the
 * same wherever it surfaces. Claude Code adds the text to the model's context
 * through the SessionStart hook's `additionalContext`.
 */

import { escapeXmlContent } from "@magic-context/core/features/magic-context/compartment-storage";
import {
    getMemoriesByProject,
    getMemoriesByProjects,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getSessionNotes } from "@magic-context/core/features/magic-context/storage";
import {
    DEFAULT_MEMORY_BUDGET_TOKENS,
    renderMemoryBlockV2,
    resolveWorkspaceRenderContext,
    sourceNamesForMemories,
    trimMemoriesToBudgetV2,
    trimWorkspaceMemoriesToBudgetV2,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import { renderGlance } from "@magic-context/core/tools/ctx-note/render";
import { buildGuidance } from "./guidance";
import { driftOf, isStale, listSkills } from "./operation-skills/store";
import type { Runtime } from "./runtime";
import type { ClaudeCodeSession } from "./session";

export type SessionStartSource = "startup" | "resume" | "clear" | "compact";

export interface SessionContext {
    text: string;
    memoryCount: number;
    noteCount: number;
    operationCount: number;
}

const MAX_NOTES_SHOWN = 10;
const MAX_OPERATIONS_SHOWN = 40;

function renderProjectMemory(
    runtime: Runtime,
    sessionId: string,
): { block: string; count: number } {
    const { db, config, projectPath } = runtime;
    if (!projectPath) return { block: "", count: 0 };
    const workspace = resolveWorkspaceRenderContext({ db, projectPath });
    const now = Date.now();
    const memories = workspace.isWorkspaced
        ? getMemoriesByProjects(
              db,
              workspace.expandedIdentities,
              ["active", "permanent"],
              now,
              workspace.ownIdentities,
              workspace.shareCategories,
          )
        : getMemoriesByProject(db, projectPath, ["active", "permanent"], now);
    if (memories.length === 0) return { block: "", count: 0 };

    const budget = config.memory?.injection_budget_tokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
    const renderOptions = {
        sourceNameByMemoryId: sourceNamesForMemories({ memories, projectPath, workspace }),
    };
    const trimmed = workspace.isWorkspaced
        ? trimWorkspaceMemoriesToBudgetV2(sessionId, memories, budget, workspace, renderOptions)
        : trimMemoriesToBudgetV2(sessionId, memories, budget);
    return {
        block: renderMemoryBlockV2(trimmed.renderOrder, "project-memory", renderOptions),
        count: trimmed.renderOrder.length,
    };
}

function renderSessionNotes(runtime: Runtime, sessionId: string): { block: string; count: number } {
    const notes = getSessionNotes(runtime.db, sessionId);
    if (notes.length === 0) return { block: "", count: 0 };
    const glance = renderGlance(
        notes.map((note) => ({ ...note, content: escapeXmlContent(note.content) })),
        { limit: MAX_NOTES_SHOWN, offset: 0, nowMs: Date.now() },
    );
    return {
        block: `<session-notes>\n${glance}\n</session-notes>`,
        count: notes.length,
    };
}

/**
 * The project's operation skills as one line per operation: the trigger, the
 * first API it calls and what it writes, so a matching request is recognised
 * without loading every skill.
 */
function renderProjectSkills(projectDir: string): { block: string; count: number } {
    const skills = listSkills(projectDir);
    const lines: string[] = [];
    let count = 0;
    for (const skill of skills) {
        lines.push(`${skill.name} — ${skill.title} (scope: ${skill.scope})`);
        for (const operation of skill.operations) {
            count++;
            if (count > MAX_OPERATIONS_SHOWN) continue;
            const api = operation.apis[0];
            const parts = [`${operation.trigger.kind} "${operation.trigger.label}"`];
            if (api)
                parts.push(`${api.method ? `${api.method.toUpperCase()} ` : ""}${api.endpoint}`);
            if (operation.writes.length > 0) {
                parts.push(`writes ${operation.writes.map((write) => write.target).join(", ")}`);
            }
            const stale = isStale(driftOf(projectDir, operation))
                ? " [files changed since verified]"
                : "";
            lines.push(`  - ${operation.id}: ${parts.join(" → ")}${stale}`);
        }
    }
    if (count === 0) return { block: "", count: 0 };
    if (count > MAX_OPERATIONS_SHOWN) {
        lines.push(`  … ${count - MAX_OPERATIONS_SHOWN} more (ctx_skill list)`);
    }
    return {
        block: `<project-skills>\n${escapeXmlContent(lines.join("\n"))}\n</project-skills>`,
        count,
    };
}

/**
 * Build the session-start context, or null when Magic Context is disabled for
 * this project.
 */
export function buildSessionContext(
    runtime: Runtime,
    session: ClaudeCodeSession,
    source: SessionStartSource,
): SessionContext | null {
    if (runtime.config.enabled !== true) return null;
    const memoryEnabled = runtime.config.memory?.enabled !== false;

    const memory = memoryEnabled
        ? renderProjectMemory(runtime, session.sessionId)
        : { block: "", count: 0 };
    const notes = renderSessionNotes(runtime, session.sessionId);
    const skills = renderProjectSkills(session.directory);

    const sections = [buildGuidance({ memoryEnabled })];
    if (source === "compact") {
        sections.push(
            "Claude Code just compacted this conversation. What it dropped is still retrievable: ctx_search finds it and ctx_expand returns the original wording. If the summary above holds durable facts or verified flows that are not saved yet, save them now (ctx_memory, ctx_skill).",
        );
    }
    if (skills.block) sections.push(skills.block);
    if (memory.block) sections.push(memory.block);
    else if (memoryEnabled) {
        sections.push(
            "<project-memory>\nNo memories are recorded for this project yet.\n</project-memory>",
        );
    }
    if (notes.block) sections.push(notes.block);

    return {
        text: `<magic-context>\n${sections.join("\n\n")}\n</magic-context>`,
        memoryCount: memory.count,
        noteCount: notes.count,
        operationCount: skills.count,
    };
}
