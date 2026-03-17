export interface SidekickConfig {
    enabled: boolean;
    endpoint: string;
    model: string;
    api_key: string;
    max_tool_calls: number;
    timeout_ms: number;
    system_prompt?: string;
}

export type OpenAIMessageRole = "system" | "user" | "assistant" | "tool";

export interface OpenAIChatToolFunction {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface OpenAIChatTool {
    type: "function";
    function: OpenAIChatToolFunction;
}

export interface OpenAIChatToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}

export interface OpenAIChatMessage {
    role: OpenAIMessageRole;
    content: string | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAIChatToolCall[];
}

export interface OpenAIChatCompletionChoice {
    message: OpenAIChatMessage;
    finish_reason: string | null;
}

export interface OpenAIChatCompletionUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}

export interface OpenAIChatCompletionResponse {
    choices: OpenAIChatCompletionChoice[];
    usage?: OpenAIChatCompletionUsage;
}

export interface SidekickRunState {
    ranSessions: Set<string>;
}
