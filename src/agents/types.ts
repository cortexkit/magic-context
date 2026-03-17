import type { AgentConfig } from "@opencode-ai/sdk";

export type AgentMode = "primary" | "subagent" | "all";

export interface AgentPromptMetadata {
    category: "exploration" | "specialist" | "advisor" | "utility";
    cost: "FREE" | "CHEAP" | "EXPENSIVE";
    triggers: Array<{ domain: string; trigger: string }>;
    useWhen?: string[];
    avoidWhen?: string[];
    dedicatedSection?: string;
    promptAlias?: string;
    keyTrigger?: string;
}

export type AgentFactory = ((model?: string) => AgentConfig) & {
    mode: AgentMode;
};
