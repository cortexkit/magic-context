import type { Config } from "@opencode-ai/sdk";

export const MAGIC_CONTEXT_COMMAND_NAMES = [
    "ctx-status",
    "ctx-recomp",
    "ctx-flush",
    "ctx-aug",
    "ctx-dream",
] as const;

export type MagicContextCommandName = (typeof MAGIC_CONTEXT_COMMAND_NAMES)[number];
export type BuiltinCommandConfig = NonNullable<Config["command"]>;
