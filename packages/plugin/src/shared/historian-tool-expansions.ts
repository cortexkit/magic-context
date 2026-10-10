import defaults from "./historian-tool-defaults.json";
import previewDefaults from "./historian-tool-preview-defaults.json";
import { renderToolTemplate, type ToolExpansionMap } from "./historian-tool-template";

export { defaults as DEFAULT_TOOL_EXPANSIONS };

// Room actions, private-message addresses and board lanes have multiple input
// shapes. Derive readable labels only for built-ins; configured template overrides
// keep the unmodified tool input.
function builtinInput(tool: string, input: unknown): unknown {
    if (!input || typeof input !== "object") return input;
    const i = input as Record<string, unknown>;
    if (tool === "peer_send") {
        const external = i.external as Record<string, unknown> | undefined;
        const recipient = i.reply_to_pmid
            ? `reply to ${i.reply_to_pmid}`
            : i.agent || i.agent_id
              ? `to ${i.agent || i.agent_id}`
              : external?.session_id || i.session_id
                ? `to session ${external?.session_id || i.session_id}`
                : "to unknown recipient";
        return { ...i, recipient };
    }
    if (tool === "room") {
        return {
            ...i,
            room_label: i.room_id || i.title,
            room_detail:
                i.action === "create" || i.action === "invite"
                    ? `invitees: ${renderToolTemplate("${input.invitees}", i)}`
                    : i.text,
        };
    }
    if (tool === "board") {
        return {
            ...i,
            board_lane: i.lane ? ` ${i.lane}` : "",
            ops: Array.isArray(i.ops)
                ? i.ops.map((op) =>
                      op && typeof op === "object"
                          ? {
                                ...op,
                                lane_label:
                                    typeof op.lane === "string"
                                        ? op.lane
                                        : op.lane?.title || op.lane?.id,
                            }
                          : op,
                  )
                : i.ops,
        };
    }
    return input;
}

export function expandToolPart(
    part: unknown,
    overrides?: ToolExpansionMap,
    legacyPreview = false,
): string | null {
    if (!part || typeof part !== "object") return null;
    const p = part as Record<string, unknown>;
    if (p.type !== "tool" || typeof p.tool !== "string") return null;
    const builtinDefaults = legacyPreview ? previewDefaults : defaults;
    const overridden = overrides && Object.hasOwn(overrides, p.tool);
    const template = overridden
        ? overrides[p.tool]
        : Object.hasOwn(builtinDefaults, p.tool)
          ? builtinDefaults[p.tool as keyof typeof defaults]
          : undefined;
    if (typeof template !== "string") return null;
    const state = p.state as Record<string, unknown> | undefined;
    const input = overridden || legacyPreview ? state?.input : builtinInput(p.tool, state?.input);
    return renderToolTemplate(template, input, state?.output ?? state?.error, legacyPreview);
}
