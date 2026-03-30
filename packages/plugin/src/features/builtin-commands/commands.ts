import type { BuiltinCommandConfig } from "./types";

export function getMagicContextBuiltinCommands(): BuiltinCommandConfig {
    return {
        "ctx-status": {
            template: "ctx-status",
            description: "Show magic context status, pending queue, cache TTL, and debug info",
        },
        "ctx-recomp": {
            template: "ctx-recomp",
            description:
                "Rebuild compartments and facts from raw history without publishing partial results",
        },
        "ctx-flush": {
            template: "ctx-flush",
            description: "Force-process all pending magic context operations immediately",
        },
        "ctx-aug": {
            template: "ctx-aug",
            description: "Augment your prompt with project memory context via sidekick agent",
        },
        "ctx-dream": {
            template: "ctx-dream",
            description: "Run the hidden dreamer maintenance pass for this project now",
        },
    };
}
