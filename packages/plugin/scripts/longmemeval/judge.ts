import { estimateCostFromPricing } from "./config";
import {
    createEmptyTokenUsageStats,
    type JudgeConfig,
    type JudgeResult,
    type LongMemEvalQuestion,
    type TokenUsageStats,
} from "./types";

const BASE_TEMPLATE =
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";

const TEMPORAL_TEMPLATE =
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";

const KNOWLEDGE_UPDATE_TEMPLATE =
    "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";

const PREFERENCE_TEMPLATE =
    "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";

const ABSTENTION_TEMPLATE =
    "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";

interface OpenAIChatCompletionResponse {
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: {
            cached_tokens?: number;
        };
        completion_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
    choices?: Array<{
        message?: {
            content?: string | Array<{ type?: string; text?: string }>;
        };
    }>;
}

function fillTemplate(template: string, question: string, answer: string, response: string): string {
    return template.replace("{}", question).replace("{}", answer).replace("{}", response);
}

export function buildJudgePrompt(question: LongMemEvalQuestion, response: string): string {
    if (question.question_id.endsWith("_abs")) {
        return fillTemplate(ABSTENTION_TEMPLATE, question.question, question.answer, response);
    }

    switch (question.question_type) {
        case "temporal-reasoning":
            return fillTemplate(TEMPORAL_TEMPLATE, question.question, question.answer, response);
        case "knowledge-update":
            return fillTemplate(KNOWLEDGE_UPDATE_TEMPLATE, question.question, question.answer, response);
        case "single-session-preference":
            return fillTemplate(PREFERENCE_TEMPLATE, question.question, question.answer, response);
        case "single-session-user":
        case "single-session-assistant":
        case "multi-session":
            return fillTemplate(BASE_TEMPLATE, question.question, question.answer, response);
    }
}

function getApiKey(config: JudgeConfig): string {
    const value = process.env[config.apiKeyEnvVar];
    if (!value) {
        throw new Error(`Missing judge API key in environment variable ${config.apiKeyEnvVar}`);
    }
    return value;
}

function extractResponseText(payload: OpenAIChatCompletionResponse): string {
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content === "string") {
        return content.trim();
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
            .trim();
    }
    return "";
}

function extractUsage(payload: OpenAIChatCompletionResponse): TokenUsageStats {
    const promptTokens = payload.usage?.prompt_tokens ?? 0;
    const completionTokens = payload.usage?.completion_tokens ?? 0;
    const reasoningTokens = payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const cacheReadTokens = payload.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const totalTokens = payload.usage?.total_tokens ?? promptTokens + completionTokens;

    return {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        reasoningTokens,
        totalTokens,
        cacheReadTokens,
        cacheWriteTokens: 0,
    };
}

export async function judgeAnswer(args: {
    config: JudgeConfig;
    question: LongMemEvalQuestion;
    hypothesis: string;
    signal?: AbortSignal;
}): Promise<JudgeResult> {
    const prompt = buildJudgePrompt(args.question, args.hypothesis);
    const response = await fetch(`${args.config.apiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${getApiKey(args.config)}`,
        },
        body: JSON.stringify({
            model: args.config.model,
            messages: [{ role: "user", content: prompt }],
            n: 1,
            temperature: args.config.temperature,
            max_tokens: args.config.maxTokens,
        }),
        signal: args.signal,
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Judge request failed (${response.status}): ${errorText}`);
    }

    const payload = (await response.json()) as OpenAIChatCompletionResponse;
    const rawResponse = extractResponseText(payload);
    const label = rawResponse.toLowerCase().includes("yes");
    const usage = payload.usage ? extractUsage(payload) : createEmptyTokenUsageStats();
    const estimatedCostUsd = estimateCostFromPricing(usage, args.config.pricing);

    return {
        model: args.config.model,
        prompt,
        rawResponse,
        label,
        usage,
        estimatedCostUsd,
    };
}
