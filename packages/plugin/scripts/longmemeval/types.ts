export const LONGMEMEVAL_QUESTION_TYPES = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "multi-session",
    "temporal-reasoning",
    "knowledge-update",
] as const;

export type LongMemEvalQuestionType = (typeof LONGMEMEVAL_QUESTION_TYPES)[number];

export type QuestionRunStatus =
    | "pending"
    | "replaying"
    | "waiting-between-sessions"
    | "asking-final-question"
    | "judging"
    | "completed"
    | "error";

export interface LongMemEvalTurn {
    role: string;
    content: string;
    has_answer?: boolean;
}

export interface LongMemEvalQuestion {
    question_id: string;
    question_type: LongMemEvalQuestionType;
    question: string;
    answer: string;
    question_date: string;
    haystack_dates: string[];
    haystack_session_ids: string[];
    answer_session_ids: string[];
    haystack_sessions: LongMemEvalTurn[][];
}

export interface TokenUsageStats {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export interface PricingConfig {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    reasoningPerMillionUsd?: number;
    cachedInputPerMillionUsd?: number;
    cacheWritePerMillionUsd?: number;
}

export interface JudgeConfig {
    model: string;
    apiKeyEnvVar: string;
    apiBaseUrl: string;
    timeoutMs: number;
    maxTokens: number;
    temperature: number;
    pricing: PricingConfig;
}

export interface RunnerPaths {
    outputDir: string;
    stateFile: string;
    resultsFile: string;
    summaryFile: string;
    logFile: string;
}

export interface RunnerConfig {
    datasetPath: string;
    projectDirectory: string;
    openCodeBaseUrl: string;
    openCodeRequestTimeoutMs: number;
    turnDelayMs: number;
    sessionDelayMs: number;
    finalQuestionDelayMs: number;
    parallelism: number;
    cleanupSessions: boolean;
    fastMode: boolean;
    resume: boolean;
    maxRequestAttempts: number;
    retryBaseDelayMs: number;
    openCodePricing: PricingConfig;
    questionPromptTemplate: string;
    selection: {
        start?: number;
        end?: number;
        types: LongMemEvalQuestionType[];
        questionIds: string[];
    };
    judge: JudgeConfig;
    paths: RunnerPaths;
    selectionSignature: string;
}

export interface OpenCodeSessionProgress {
    datasetSessionIndex: number;
    datasetSessionId: string;
    date: string;
    openCodeSessionId: string | null;
    bannerSent: boolean;
    nextTurnIndex: number;
    completed: boolean;
    recreatedCount: number;
}

export interface FinalQuestionProgress {
    openCodeSessionId: string | null;
    bannerSent: boolean;
    asked: boolean;
    answerText: string | null;
    recreatedCount: number;
}

export interface ErrorSnapshot {
    message: string;
    stack?: string;
    step: string;
    at: string;
}

export interface JudgeSnapshot {
    model: string;
    prompt: string;
    rawResponse: string;
    label: boolean;
}

export interface QuestionRunState {
    questionId: string;
    datasetIndex: number;
    questionType: LongMemEvalQuestionType;
    status: QuestionRunStatus;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    attemptCount: number;
    currentHaystackSessionIndex: number;
    currentTurnIndex: number;
    createdSessionIds: string[];
    haystackSessions: OpenCodeSessionProgress[];
    finalQuestion: FinalQuestionProgress;
    openCodeUsage: TokenUsageStats;
    judgeUsage: TokenUsageStats;
    openCodeActualCostUsd: number;
    openCodeEstimatedCostUsd: number;
    judgeEstimatedCostUsd: number;
    judge?: JudgeSnapshot;
    cleanupCompleted: boolean;
    lastError?: ErrorSnapshot;
}

export interface RunnerStateFile {
    version: number;
    selectionSignature: string;
    datasetPath: string;
    projectDirectory: string;
    createdAt: string;
    updatedAt: string;
    completedQuestionIds: string[];
    inProgress: Record<string, QuestionRunState>;
}

export interface JudgeResult {
    model: string;
    prompt: string;
    rawResponse: string;
    label: boolean;
    usage: TokenUsageStats;
    estimatedCostUsd: number;
}

export interface QuestionResultRecord {
    question_id: string;
    question_type: LongMemEvalQuestionType;
    dataset_index: number;
    question: string;
    correct_answer: string;
    question_date: string;
    hypothesis: string;
    judgment: "yes" | "no";
    score: 0 | 1;
    autoeval_label: {
        model: string;
        label: boolean;
    };
    answer_session_ids: string[];
    haystack_session_ids: string[];
    haystack_open_code_session_ids: string[];
    final_open_code_session_id: string | null;
    token_usage: {
        openCode: TokenUsageStats;
        judge: TokenUsageStats;
        total: TokenUsageStats;
    };
    costs: {
        openCodeActualUsd: number;
        openCodeEstimatedUsd: number;
        judgeEstimatedUsd: number;
        totalActualUsd: number;
        totalEstimatedUsd: number;
    };
    metadata: {
        startedAt: string;
        completedAt: string;
        attemptCount: number;
    };
}

export interface RunSummaryRow {
    category: string;
    correct: number;
    total: number;
    accuracy: number;
}

export interface RunSummary {
    generatedAt: string;
    datasetPath: string;
    selectionSignature: string;
    completedQuestions: number;
    selectedQuestions: number;
    pendingQuestions: number;
    rows: RunSummaryRow[];
    costs: {
        totalActualUsd: number;
        totalEstimatedUsd: number;
    };
    tokens: TokenUsageStats;
}

export function createEmptyTokenUsageStats(): TokenUsageStats {
    return {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
    };
}

export function addTokenUsage(
    left: TokenUsageStats,
    right: TokenUsageStats,
): TokenUsageStats {
    return {
        inputTokens: left.inputTokens + right.inputTokens,
        outputTokens: left.outputTokens + right.outputTokens,
        reasoningTokens: left.reasoningTokens + right.reasoningTokens,
        totalTokens: left.totalTokens + right.totalTokens,
        cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
        cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    };
}

export function isLongMemEvalQuestionType(value: string): value is LongMemEvalQuestionType {
    return LONGMEMEVAL_QUESTION_TYPES.includes(value as LongMemEvalQuestionType);
}
