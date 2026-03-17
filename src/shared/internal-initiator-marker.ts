export const OMO_INTERNAL_INITIATOR_MARKER = "<!-- MAGIC_CONTEXT_INTERNAL_INITIATOR -->";

export function createInternalAgentTextPart(text: string): {
    type: "text";
    text: string;
} {
    return {
        type: "text",
        text: `${text}\n${OMO_INTERNAL_INITIATOR_MARKER}`,
    };
}
