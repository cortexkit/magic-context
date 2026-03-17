import type { Database } from "bun:sqlite";
import { log } from "../../../shared/logger";
import { cosineSimilarity } from "../memory/cosine-similarity";
import { embed } from "../memory/embedding";
import { loadAllEmbeddings } from "../memory/storage-memory-embeddings";
import { searchMemoriesFTS } from "../memory/storage-memory-fts";
import { getMemoryById, updateMemoryRetrievalCount } from "../memory/storage-memory";
import type { Memory } from "../memory/types";
import { chatCompletions } from "./client";
import type { OpenAIChatMessage, OpenAIChatTool, SidekickConfig } from "./types";

const DEFAULT_SYSTEM_PROMPT = `You are a context retrieval agent. Given a user's message to an AI coding assistant, fetch relevant project memories and write a brief context note.

Rules:
- Use search_memory with different queries to find relevant facts. Prefer 2-3 targeted searches.
- Do NOT hallucinate or infer causality. Only report what the memories actually say.
- Do NOT try to solve the user's problem or give advice.
- Finish within 3 tool calls. After searching, write your context note immediately.

Your context note format:
- One sentence: what the user likely wants to do
- Bullet list: relevant memories grouped by topic (quote them, don't paraphrase)

Keep it under 200 words. Only include memories you actually found — never fabricate.`;

const SEARCH_TOOL: OpenAIChatTool = {
    type: "function",
    function: {
        name: "search_memory",
        description: "Search project memories with keyword and semantic retrieval.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Targeted search query for relevant project memories.",
                },
            },
            required: ["query"],
            additionalProperties: false,
        },
    },
};

interface SearchMemoryArgs {
    query: string;
}

function escapeXml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatMemories(memories: Memory[]): string {
    if (memories.length === 0) {
        return "No matching memories found.";
    }

    return memories
        .map(
            (memory, index) =>
                `${index + 1}. [${memory.category}] ${escapeXml(memory.content)} (project: ${memory.projectPath})`,
        )
        .join("\n");
}

function dedupeMemories(memories: Memory[]): Memory[] {
    const seen = new Set<number>();
    const deduped: Memory[] = [];

    for (const memory of memories) {
        if (seen.has(memory.id)) {
            continue;
        }

        seen.add(memory.id);
        deduped.push(memory);
    }

    return deduped;
}

async function searchMemoryTool(
    db: Database,
    projectPath: string,
    rawArgs: string,
): Promise<string> {
    let parsedArgs: SearchMemoryArgs;

    try {
        parsedArgs = JSON.parse(rawArgs) as SearchMemoryArgs;
    } catch {
        return "Invalid tool arguments.";
    }

    const query = parsedArgs.query?.trim();
    if (!query) {
        return "Missing query.";
    }

    const ftsResults = searchMemoriesFTS(db, projectPath, query, 8);
    const semanticResults: Array<{ memory: Memory; score: number }> = [];
    const embeddings = loadAllEmbeddings(db, projectPath);
    const queryEmbedding = embeddings.size > 0 ? await embed(query) : null;

    if (queryEmbedding) {
        for (const [memoryId, embedding] of embeddings) {
            const memory = getMemoryById(db, memoryId);
            if (!memory || memory.status === "archived") {
                continue;
            }

            const score = cosineSimilarity(queryEmbedding, embedding);
            if (score > 0) {
                semanticResults.push({ memory, score });
            }
        }

        semanticResults.sort((left, right) => right.score - left.score);
    }

    const combined = dedupeMemories([
        ...ftsResults,
        ...semanticResults.slice(0, 8).map((entry) => entry.memory),
    ]).slice(0, 8);

    for (const memory of combined) {
        updateMemoryRetrievalCount(db, memory.id);
    }

    return formatMemories(combined);
}

function getToolCallSummary(message: OpenAIChatMessage): string[] {
    return (message.tool_calls ?? []).map((toolCall) => toolCall.function.name);
}

export async function runSidekick(deps: {
    db: Database;
    projectPath: string;
    userMessage: string;
    config: SidekickConfig;
}): Promise<string | null> {
    try {
        const messages: OpenAIChatMessage[] = [
            {
                role: "system",
                content: deps.config.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
            },
            {
                role: "user",
                content: deps.userMessage,
            },
        ];

        const maxToolCalls = Math.max(0, deps.config.max_tool_calls);
        const maxIterations = maxToolCalls + 2;
        let toolIterations = 0;

        for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
            const tools = toolIterations < maxToolCalls ? [SEARCH_TOOL] : undefined;
            const response = await chatCompletions({
                endpoint: deps.config.endpoint,
                apiKey: deps.config.api_key,
                model: deps.config.model,
                messages,
                tools,
                timeoutMs: deps.config.timeout_ms,
                temperature: 0,
            });

            const choice = response.choices[0];
            if (!choice) {
                return null;
            }

            const assistantMessage = choice.message;
            log(
                `[magic-context] sidekick: iteration ${iteration}, tool_calls: ${JSON.stringify(getToolCallSummary(assistantMessage))}`,
            );

            messages.push(assistantMessage);

            const toolCalls = assistantMessage.tool_calls ?? [];
            if (toolCalls.length === 0) {
                const finalText = assistantMessage.content?.trim() ?? "";
                return finalText.length > 0 ? finalText : null;
            }

            if (toolIterations >= maxToolCalls) {
                return null;
            }

            toolIterations += 1;

            for (const toolCall of toolCalls) {
                let result = "Unsupported tool.";

                if (toolCall.function.name === "search_memory") {
                    result = await searchMemoryTool(
                        deps.db,
                        deps.projectPath,
                        toolCall.function.arguments,
                    );
                }

                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: result,
                });
            }
        }

        return null;
    } catch (error) {
        log("[magic-context] sidekick failed:", error);
        return null;
    }
}
