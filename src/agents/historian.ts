import type { AgentConfig } from "@opencode-ai/sdk";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "../hooks/magic-context/compartment-prompt";
import { createAgentToolAllowlist } from "../shared/permission-compat";
import type { AgentMode, AgentPromptMetadata } from "./types";

const MODE: AgentMode = "subagent";

export const HISTORIAN_AGENT = "historian";

export const HISTORIAN_PROMPT_METADATA: AgentPromptMetadata = {
    category: "utility",
    cost: "CHEAP",
    promptAlias: "Historian",
    triggers: [],
};

export function createHistorianAgent(model: string): AgentConfig {
    const restrictions = createAgentToolAllowlist([]);

    return {
        description:
            "Condenses long coding sessions into durable compartments and facts for magic context. Use when background history summarization needs a stable, low-noise representation of completed work. (Historian - Magic Context)",
        mode: MODE,
        model,
        temperature: 0.1,
        maxTokens: 16384,
        ...restrictions,
        prompt: COMPARTMENT_AGENT_SYSTEM_PROMPT,
    };
}

createHistorianAgent.mode = MODE;
