import type { PromptSurfacePreset } from "../shared/prompt-surface";
import { NOTES_FILTER_DESCRIPTION } from "./ctx-note/constants";

export const FULL_PARAMETER_DESCRIPTIONS = {
    ctx_reduce: {
        drop: 'Tag IDs to drop: "3-5", "1,2,9", "1-5,8,12-15".',
    },
    ctx_expand: {
        tag: "Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone.",
        start: "First message ordinal of the range (a <session-history> heading's start, or a ctx_search hit), not a tag number.",
        end: "Last message ordinal of the range, inclusive, not a tag number.",
        verbose:
            "With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
        message:
            "Message ordinal from a <session-history> heading or a ctx_search hit, not a tag number. Returns that one message in full. Use alone.",
    },
    ctx_note: {
        action: "write | read | update | dismiss.",
        content:
            "Note text for write/update: first line is the title (under 80 chars), then the detail.",
        surface_condition:
            "Makes this a smart note: a condition an outside checker can verify on its own, periodically — repository state, releases, web pages, anything it can look up — never something only this conversation knows. The note is parked until the condition holds.",
        filter: "Read filter: all, active, pending (unsurfaced smart notes), ready, dismissed. Omitted, it shows active session notes plus every current smart note (pending included); active shows only notes whose stored status is active.",
        limit: "Rows per read (default 25).",
        offset: "Skip this many newest rows (default 0).",
        note_ids:
            "Note ids: one for update, 1–50 for dismiss, or 1–50 to read those notes in full. Write and a plain read take an empty list.",
    },
    ctx_memory: {
        action: "write | update | archive | merge | get",
        content: "The memory text — one standalone fact (write, update, merge).",
        category:
            "Kind of fact (required for write; on update/merge, pass the memory's current category to keep it).",
        ids: "Memory ids from <project-memory>: one for update, one or more for archive, two or more for merge, 1–20 for get.",
        reason: "Why it is being archived (optional).",
    },
    ctx_search: {
        query: "A natural-language question carrying the exact terms you expect in the answer.",
        limit: "Maximum results (default 10).",
        sources: "Restrict to these sources; omitting it or passing [] searches every source.",
        from: "Earliest date, YYYY-MM-DD (inclusive).",
        to: "Latest date, YYYY-MM-DD (inclusive; default open).",
    },
} as const;

export const LIGHT_PARAMETER_DESCRIPTIONS = {
    ctx_reduce: {
        drop: 'Tag IDs: "3-5", "1,2,9", "1-5,8,12-15".',
    },
    ctx_expand: {
        tag: "Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone.",
        start: "First message ordinal of the range (a <session-history> heading's start, or a ctx_search hit), not a tag number.",
        end: "Last message ordinal of the range, inclusive, not a tag number.",
        verbose: "With start/end: one entry per message with previews instead of the transcript.",
        message:
            "Message ordinal from a <session-history> heading or a ctx_search hit, not a tag number. Returns that one message in full. Use alone.",
    },
    ctx_note: {
        action: "write | read | update | dismiss.",
        content: "Note text: first line title (<80 chars), then detail.",
        surface_condition:
            "A condition an outside checker can verify on its own, periodically (repository, releases, web — anything it can look up); never something only this conversation knows.",
        filter: "Read filter: all, active, pending, ready, dismissed. Omitted: active notes plus every current smart note (pending included); active: only active-status notes.",
        limit: "Rows per read (default 25).",
        offset: "Skip newest rows (default 0).",
        note_ids:
            "One id for update, 1–50 for dismiss, or 1–50 to read those notes in full. Write and a plain read take an empty list.",
    },
    ctx_memory: {
        action: "write | update | archive | merge | get",
        content: "One standalone fact (write, update, merge).",
        category:
            "Kind of fact (required for write; on update/merge pass the current category to keep it).",
        ids: "Ids from <project-memory>: one for update, 1+ for archive, 2+ for merge, 1–20 for get.",
        reason: "Why it is archived (optional).",
    },
    ctx_search: {
        query: "A natural-language question carrying the exact terms you expect in the answer.",
        limit: "Maximum results (default 10).",
        sources: "Restrict to these sources; omit or [] for all.",
        from: "Earliest date, YYYY-MM-DD (inclusive).",
        to: "Latest date, YYYY-MM-DD (inclusive; default open).",
    },
} as const;

export type PromptSurfaceParameterToolId = keyof typeof FULL_PARAMETER_DESCRIPTIONS;

export function parameterDescriptionsFor(
    toolId: string,
    preset: PromptSurfacePreset,
    smartNotesEnabled = true,
): Readonly<Record<string, string>> | undefined {
    const descriptions =
        preset === "light" ? LIGHT_PARAMETER_DESCRIPTIONS : FULL_PARAMETER_DESCRIPTIONS;
    const selected = descriptions[toolId as PromptSurfaceParameterToolId];
    if (toolId === "ctx_note" && !smartNotesEnabled) {
        const { surface_condition: _condition, ...plain } = descriptions.ctx_note;
        return { ...plain, filter: NOTES_FILTER_DESCRIPTION };
    }
    return selected;
}

export function applyJsonSchemaParameterDescriptions(
    toolId: string,
    input: unknown,
    preset: PromptSurfacePreset,
    smartNotesEnabled = true,
): void {
    const descriptions = parameterDescriptionsFor(toolId, preset, smartNotesEnabled);
    if (!descriptions || !input || typeof input !== "object") return;
    const properties = (input as { properties?: unknown }).properties;
    if (!properties || typeof properties !== "object") return;
    for (const [name, description] of Object.entries(descriptions)) {
        const property = (properties as Record<string, unknown>)[name];
        if (property && typeof property === "object") {
            (property as { description?: string }).description = description;
        }
    }
}
