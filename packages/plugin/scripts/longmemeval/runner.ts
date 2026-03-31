#!/usr/bin/env bun

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createOpencodeClient, type AssistantMessage, type Part } from "@opencode-ai/sdk";
import { parseRunnerConfig, printUsage, estimateCostFromPricing } from "./config";
import { judgeAnswer } from "./judge";
import {
    LONGMEMEVAL_QUESTION_TYPES,
    addTokenUsage,
    createEmptyTokenUsageStats,
    type LongMemEvalQuestion,
    type OpenCodeSessionProgress,
    type QuestionResultRecord,
    type QuestionRunState,
    type RunSummary,
    type RunSummaryRow,
    type RunnerConfig,
    type RunnerStateFile,
    type TokenUsageStats,
} from "./types";

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

interface SessionMessageShape {
    info?: {
        id?: string;
        role?: string;
        time?: { created?: number; completed?: number };
        cost?: number;
        tokens?: {
            input?: number;
            output?: number;
            reasoning?: number;
            cache?: {
                read?: number;
                write?: number;
            };
        };
        error?: unknown;
    };
    parts?: Part[] | unknown;
}

const STATE_FILE_VERSION = 1;
let writeQueue: Promise<void> = Promise.resolve();

function nowIso(): string {
    return new Date().toISOString();
}

function asError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

function logLine(message: string): void {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

async function ensureParentDirectory(filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await enqueueWrite(async () => {
        await ensureParentDirectory(filePath);
        const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
        await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        await rename(tempPath, filePath);
    });
}

async function appendLine(filePath: string, line: string): Promise<void> {
    await enqueueWrite(async () => {
        await ensureParentDirectory(filePath);
        let current = "";
        try {
            current = await readFile(filePath, "utf8");
        } catch (error) {
            const typed = asError(error);
            if ((typed as NodeJS.ErrnoException).code !== "ENOENT") {
                throw typed;
            }
        }

        const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
        await writeFile(tempPath, `${current}${line}\n`, "utf8");
        await rename(tempPath, filePath);
    });
}

async function appendLog(filePath: string, line: string): Promise<void> {
    await appendLine(filePath, `[${new Date().toISOString()}] ${line}`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = writeQueue.then(operation, operation);
    writeQueue = next.catch(() => undefined);
    await next;
}

async function sleepWithLog(config: RunnerConfig, label: string, delayMs: number): Promise<void> {
    if (delayMs <= 0) return;
    logLine(`${label}; sleeping ${delayMs}ms`);
    await appendLog(config.paths.logFile, `${label}; sleeping ${delayMs}ms`);
    await sleep(delayMs);
}

function extractAssistantTextFromParts(parts: unknown): string {
    if (!Array.isArray(parts)) return "";
    return parts
        .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
}

function extractUsageFromAssistantMessage(info: AssistantMessage | SessionMessageShape["info"]): TokenUsageStats {
    const inputTokens = info?.tokens?.input ?? 0;
    const outputTokens = info?.tokens?.output ?? 0;
    const reasoningTokens = info?.tokens?.reasoning ?? 0;
    const cacheReadTokens = info?.tokens?.cache?.read ?? 0;
    const cacheWriteTokens = info?.tokens?.cache?.write ?? 0;

    return {
        inputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens: inputTokens + outputTokens + reasoningTokens,
        cacheReadTokens,
        cacheWriteTokens,
    };
}

function createQuestionState(question: LongMemEvalQuestion, datasetIndex: number): QuestionRunState {
    const timestamp = nowIso();
    return {
        questionId: question.question_id,
        datasetIndex,
        questionType: question.question_type,
        status: "pending",
        startedAt: timestamp,
        updatedAt: timestamp,
        attemptCount: 0,
        currentHaystackSessionIndex: 0,
        currentTurnIndex: 0,
        createdSessionIds: [],
        haystackSessions: question.haystack_session_ids.map((datasetSessionId, index) => ({
            datasetSessionIndex: index,
            datasetSessionId,
            date: question.haystack_dates[index] ?? "unknown",
            openCodeSessionId: null,
            bannerSent: false,
            nextTurnIndex: 0,
            completed: false,
            recreatedCount: 0,
        })),
        finalQuestion: {
            openCodeSessionId: null,
            bannerSent: false,
            asked: false,
            answerText: null,
            recreatedCount: 0,
        },
        openCodeUsage: createEmptyTokenUsageStats(),
        judgeUsage: createEmptyTokenUsageStats(),
        openCodeActualCostUsd: 0,
        openCodeEstimatedCostUsd: 0,
        judgeEstimatedCostUsd: 0,
        cleanupCompleted: false,
    };
}

async function loadDataset(datasetPath: string): Promise<LongMemEvalQuestion[]> {
    const content = await readFile(datasetPath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
        throw new Error(`Dataset must be a JSON array: ${datasetPath}`);
    }
    return parsed as LongMemEvalQuestion[];
}

function selectQuestions(dataset: LongMemEvalQuestion[], config: RunnerConfig): Array<{
    question: LongMemEvalQuestion;
    datasetIndex: number;
}> {
    const typeSet = new Set(config.selection.types);
    const questionIdSet = new Set(config.selection.questionIds);
    const start = config.selection.start ?? 0;
    const end = config.selection.end ?? dataset.length;

    return dataset
        .map((question, datasetIndex) => ({ question, datasetIndex }))
        .filter(({ datasetIndex }) => datasetIndex >= start && datasetIndex < end)
        .filter(({ question }) => typeSet.has(question.question_type))
        .filter(({ question }) => questionIdSet.size === 0 || questionIdSet.has(question.question_id));
}

async function loadResultsMap(resultsFile: string): Promise<Map<string, QuestionResultRecord>> {
    try {
        const content = await readFile(resultsFile, "utf8");
        const map = new Map<string, QuestionResultRecord>();
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const parsed = JSON.parse(line) as QuestionResultRecord;
            map.set(parsed.question_id, parsed);
        }
        return map;
    } catch (error) {
        const typed = asError(error);
        if ((typed as NodeJS.ErrnoException).code === "ENOENT") {
            return new Map();
        }
        throw typed;
    }
}

async function loadState(config: RunnerConfig): Promise<RunnerStateFile> {
    if (!config.resume) {
        return {
            version: STATE_FILE_VERSION,
            selectionSignature: config.selectionSignature,
            datasetPath: config.datasetPath,
            projectDirectory: config.projectDirectory,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            completedQuestionIds: [],
            inProgress: {},
        };
    }

    try {
        const content = await readFile(config.paths.stateFile, "utf8");
        const parsed = JSON.parse(content) as RunnerStateFile;
        if (parsed.selectionSignature !== config.selectionSignature) {
            throw new Error(
                `Resume state does not match current selection. Existing selectionSignature=${parsed.selectionSignature}`,
            );
        }
        return parsed;
    } catch (error) {
        const typed = asError(error);
        if ((typed as NodeJS.ErrnoException).code === "ENOENT") {
            return {
                version: STATE_FILE_VERSION,
                selectionSignature: config.selectionSignature,
                datasetPath: config.datasetPath,
                projectDirectory: config.projectDirectory,
                createdAt: nowIso(),
                updatedAt: nowIso(),
                completedQuestionIds: [],
                inProgress: {},
            };
        }
        throw typed;
    }
}

async function persistState(config: RunnerConfig, state: RunnerStateFile): Promise<void> {
    state.updatedAt = nowIso();
    await writeJsonAtomic(config.paths.stateFile, state);
}

function createClient(config: RunnerConfig): OpencodeClient {
    return createOpencodeClient({
        baseUrl: config.openCodeBaseUrl,
        directory: config.projectDirectory,
        throwOnError: true,
    });
}

async function withRetry<T>(
    config: RunnerConfig,
    operationName: string,
    run: (attempt: number, signal: AbortSignal) => Promise<T>,
): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= config.maxRequestAttempts; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.openCodeRequestTimeoutMs);
        try {
            return await run(attempt, controller.signal);
        } catch (error) {
            lastError = asError(error);
            clearTimeout(timeout);
            if (attempt >= config.maxRequestAttempts) break;
            const retryDelay = config.retryBaseDelayMs * 2 ** (attempt - 1);
            logLine(
                `${operationName} failed on attempt ${attempt}/${config.maxRequestAttempts}: ${lastError.message}; retrying in ${retryDelay}ms`,
            );
            await sleep(retryDelay);
            continue;
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError ?? new Error(`${operationName} failed`);
}

async function createSession(
    client: OpencodeClient,
    config: RunnerConfig,
    title: string,
): Promise<string> {
    const response = await withRetry(config, `session.create:${title}`, (_attempt, signal) =>
        client.session.create({
            query: { directory: config.projectDirectory },
            body: { title },
            signal,
        }),
    );
    const sessionId = response.data?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error(`Session create returned invalid id for ${title}`);
    }
    return sessionId;
}

async function deleteSession(
    client: OpencodeClient,
    config: RunnerConfig,
    sessionId: string,
): Promise<void> {
    await withRetry(config, `session.delete:${sessionId}`, (_attempt, signal) =>
        client.session.delete({
            path: { id: sessionId },
            query: { directory: config.projectDirectory },
            signal,
        }),
    );
}

async function fetchMessages(
    client: OpencodeClient,
    config: RunnerConfig,
    sessionId: string,
): Promise<SessionMessageShape[]> {
    const response = await withRetry(config, `session.messages:${sessionId}`, (_attempt, signal) =>
        client.session.messages({
            path: { id: sessionId },
            query: { directory: config.projectDirectory },
            signal,
        }),
    );
    return Array.isArray(response.data) ? (response.data as SessionMessageShape[]) : [];
}

function findLatestAssistantMessage(messages: SessionMessageShape[]): SessionMessageShape | null {
    const assistantMessages = messages
        .filter((message) => message.info?.role === "assistant")
        .sort((left, right) => (right.info?.time?.created ?? 0) - (left.info?.time?.created ?? 0));
    return assistantMessages[0] ?? null;
}

async function sendPromptAndCapture(
    client: OpencodeClient,
    config: RunnerConfig,
    sessionId: string,
    text: string,
    options?: {
        system?: string;
        tools?: Record<string, boolean>;
        operationLabel?: string;
    },
): Promise<{ assistantText: string; usage: TokenUsageStats; actualCostUsd: number }> {
    const response = await withRetry(
        config,
        options?.operationLabel ?? `session.prompt:${sessionId}`,
        (_attempt, signal) =>
            client.session.prompt({
                path: { id: sessionId },
                query: { directory: config.projectDirectory },
                body: {
                    system: options?.system,
                    tools: options?.tools,
                    parts: [{ type: "text", text }],
                },
                signal,
            }),
    );

    const directData = response.data as SessionMessageShape | undefined;
    const directAssistantText = extractAssistantTextFromParts(directData?.parts);
    const directUsage = directData?.info ? extractUsageFromAssistantMessage(directData.info) : null;
    const directCost = typeof directData?.info?.cost === "number" ? directData.info.cost : null;

    if (directAssistantText.length > 0 && directUsage && directCost !== null) {
        return {
            assistantText: directAssistantText,
            usage: directUsage,
            actualCostUsd: directCost,
        };
    }

    const messages = await fetchMessages(client, config, sessionId);
    const latestAssistant = findLatestAssistantMessage(messages);
    if (!latestAssistant) {
        throw new Error(`No assistant message found after prompt in session ${sessionId}`);
    }
    if (latestAssistant.info?.error) {
        throw new Error(`Assistant returned an error for session ${sessionId}: ${JSON.stringify(latestAssistant.info.error)}`);
    }

    return {
        assistantText: extractAssistantTextFromParts(latestAssistant.parts),
        usage: extractUsageFromAssistantMessage(latestAssistant.info),
        actualCostUsd: typeof latestAssistant.info?.cost === "number" ? latestAssistant.info.cost : 0,
    };
}

function updateErrorState(questionState: QuestionRunState, step: string, error: unknown): void {
    const typed = asError(error);
    questionState.status = "error";
    questionState.updatedAt = nowIso();
    questionState.lastError = {
        message: typed.message,
        stack: typed.stack,
        step,
        at: questionState.updatedAt,
    };
}

function addOpenCodeUsage(questionState: QuestionRunState, usage: TokenUsageStats, actualCostUsd: number, config: RunnerConfig): void {
    questionState.openCodeUsage = addTokenUsage(questionState.openCodeUsage, usage);
    questionState.openCodeActualCostUsd += actualCostUsd;
    questionState.openCodeEstimatedCostUsd += estimateCostFromPricing(usage, config.openCodePricing);
}

function addJudgeUsage(questionState: QuestionRunState, usage: TokenUsageStats, estimatedCostUsd: number): void {
    questionState.judgeUsage = addTokenUsage(questionState.judgeUsage, usage);
    questionState.judgeEstimatedCostUsd += estimatedCostUsd;
}

function buildSessionBanner(date: string, datasetSessionId: string): string {
    return `--- Conversation recorded at ${date} (dataset session ${datasetSessionId}) ---`;
}

function buildFinalQuestionBanner(questionDate: string): string {
    return `--- Benchmark question session at ${questionDate} ---`;
}

async function ensureReplaySession(
    client: OpencodeClient,
    config: RunnerConfig,
    question: LongMemEvalQuestion,
    questionState: QuestionRunState,
    sessionProgress: OpenCodeSessionProgress,
    state: RunnerStateFile,
): Promise<string> {
    if (sessionProgress.openCodeSessionId) {
        return sessionProgress.openCodeSessionId;
    }

    const sessionId = await createSession(
        client,
        config,
        `longmemeval-${question.question_id}-haystack-${sessionProgress.datasetSessionIndex + 1}`,
    );
    sessionProgress.openCodeSessionId = sessionId;
    sessionProgress.recreatedCount += 1;
    if (!questionState.createdSessionIds.includes(sessionId)) {
        questionState.createdSessionIds.push(sessionId);
    }
    questionState.updatedAt = nowIso();
    state.inProgress[question.question_id] = questionState;
    await persistState(config, state);
    return sessionId;
}

async function ensureFinalQuestionSession(
    client: OpencodeClient,
    config: RunnerConfig,
    question: LongMemEvalQuestion,
    questionState: QuestionRunState,
    state: RunnerStateFile,
): Promise<string> {
    if (questionState.finalQuestion.openCodeSessionId) {
        return questionState.finalQuestion.openCodeSessionId;
    }

    const sessionId = await createSession(client, config, `longmemeval-${question.question_id}-question`);
    questionState.finalQuestion.openCodeSessionId = sessionId;
    questionState.finalQuestion.recreatedCount += 1;
    if (!questionState.createdSessionIds.includes(sessionId)) {
        questionState.createdSessionIds.push(sessionId);
    }
    questionState.updatedAt = nowIso();
    state.inProgress[question.question_id] = questionState;
    await persistState(config, state);
    return sessionId;
}

async function sendBannerIfNeeded(args: {
    client: OpencodeClient;
    config: RunnerConfig;
    sessionId: string;
    questionState: QuestionRunState;
    state: RunnerStateFile;
    questionId: string;
    bannerText: string;
    markBannerSent: () => void;
    alreadySent: boolean;
    operationLabel: string;
}): Promise<void> {
    if (args.alreadySent) return;
    const result = await sendPromptAndCapture(args.client, args.config, args.sessionId, args.bannerText, {
        operationLabel: args.operationLabel,
        tools: {},
    });
    addOpenCodeUsage(args.questionState, result.usage, result.actualCostUsd, args.config);
    args.markBannerSent();
    args.questionState.updatedAt = nowIso();
    args.state.inProgress[args.questionId] = args.questionState;
    await persistState(args.config, args.state);
}

async function replayHaystack(args: {
    client: OpencodeClient;
    config: RunnerConfig;
    question: LongMemEvalQuestion;
    questionState: QuestionRunState;
    state: RunnerStateFile;
}): Promise<void> {
    const { client, config, question, questionState, state } = args;

    for (let haystackIndex = questionState.currentHaystackSessionIndex; haystackIndex < question.haystack_sessions.length; haystackIndex += 1) {
        const datasetSession = question.haystack_sessions[haystackIndex] ?? [];
        const sessionProgress = questionState.haystackSessions[haystackIndex]!;
        if (sessionProgress.completed) {
            questionState.currentHaystackSessionIndex = haystackIndex + 1;
            questionState.currentTurnIndex = 0;
            continue;
        }

        questionState.status = "replaying";
        questionState.currentHaystackSessionIndex = haystackIndex;
        questionState.currentTurnIndex = sessionProgress.nextTurnIndex;
        questionState.updatedAt = nowIso();
        state.inProgress[question.question_id] = questionState;
        await persistState(config, state);

        const openCodeSessionId = await ensureReplaySession(client, config, question, questionState, sessionProgress, state);
        await sendBannerIfNeeded({
            client,
            config,
            sessionId: openCodeSessionId,
            questionState,
            state,
            questionId: question.question_id,
            bannerText: buildSessionBanner(sessionProgress.date, sessionProgress.datasetSessionId),
            markBannerSent: () => {
                sessionProgress.bannerSent = true;
            },
            alreadySent: sessionProgress.bannerSent,
            operationLabel: `banner:${question.question_id}:${haystackIndex}`,
        });

        for (let turnIndex = sessionProgress.nextTurnIndex; turnIndex < datasetSession.length; turnIndex += 1) {
            const turn = datasetSession[turnIndex]!;
            if (turn.role !== "user") {
                continue;
            }

            const result = await sendPromptAndCapture(client, config, openCodeSessionId, turn.content, {
                operationLabel: `replay:${question.question_id}:${haystackIndex}:${turnIndex}`,
                tools: {},
            });
            addOpenCodeUsage(questionState, result.usage, result.actualCostUsd, config);

            sessionProgress.nextTurnIndex = turnIndex + 1;
            questionState.currentTurnIndex = sessionProgress.nextTurnIndex;
            questionState.updatedAt = nowIso();
            state.inProgress[question.question_id] = questionState;
            await persistState(config, state);

            await sleepWithLog(
                config,
                `Question ${question.question_id} replayed turn ${turnIndex + 1}/${datasetSession.length}`,
                config.turnDelayMs,
            );
        }

        sessionProgress.completed = true;
        questionState.currentHaystackSessionIndex = haystackIndex + 1;
        questionState.currentTurnIndex = 0;
        questionState.status = "waiting-between-sessions";
        questionState.updatedAt = nowIso();
        state.inProgress[question.question_id] = questionState;
        await persistState(config, state);

        if (haystackIndex < question.haystack_sessions.length - 1) {
            await sleepWithLog(
                config,
                `Question ${question.question_id} completed haystack session ${haystackIndex + 1}/${question.haystack_sessions.length}`,
                config.sessionDelayMs,
            );
        }
    }
}

async function askFinalQuestion(args: {
    client: OpencodeClient;
    config: RunnerConfig;
    question: LongMemEvalQuestion;
    questionState: QuestionRunState;
    state: RunnerStateFile;
}): Promise<void> {
    const { client, config, question, questionState, state } = args;
    if (questionState.finalQuestion.asked && questionState.finalQuestion.answerText !== null) {
        return;
    }

    questionState.status = "asking-final-question";
    questionState.updatedAt = nowIso();
    state.inProgress[question.question_id] = questionState;
    await persistState(config, state);

    const sessionId = await ensureFinalQuestionSession(client, config, question, questionState, state);
    await sendBannerIfNeeded({
        client,
        config,
        sessionId,
        questionState,
        state,
        questionId: question.question_id,
        bannerText: buildFinalQuestionBanner(question.question_date),
        markBannerSent: () => {
            questionState.finalQuestion.bannerSent = true;
        },
        alreadySent: questionState.finalQuestion.bannerSent,
        operationLabel: `final-banner:${question.question_id}`,
    });

    await sleepWithLog(config, `Question ${question.question_id} final prompt delay`, config.finalQuestionDelayMs);

    const prompt = config.questionPromptTemplate.replace("{question}", question.question);
    const result = await sendPromptAndCapture(client, config, sessionId, prompt, {
        operationLabel: `final-question:${question.question_id}`,
        tools: {},
        system:
            "Answer from conversational memory only. Do not search files, do not call tools, and do not rely on external retrieval. If you do not remember, say you do not know.",
    });

    addOpenCodeUsage(questionState, result.usage, result.actualCostUsd, config);
    questionState.finalQuestion.asked = true;
    questionState.finalQuestion.answerText = result.assistantText;
    questionState.updatedAt = nowIso();
    state.inProgress[question.question_id] = questionState;
    await persistState(config, state);
}

async function judgeQuestion(args: {
    config: RunnerConfig;
    question: LongMemEvalQuestion;
    questionState: QuestionRunState;
    state: RunnerStateFile;
    resultsMap: Map<string, QuestionResultRecord>;
}): Promise<QuestionResultRecord> {
    const { config, question, questionState, state, resultsMap } = args;
    const existing = resultsMap.get(question.question_id);
    if (existing) {
        return existing;
    }

    questionState.status = "judging";
    questionState.updatedAt = nowIso();
    state.inProgress[question.question_id] = questionState;
    await persistState(config, state);

    const hypothesis = questionState.finalQuestion.answerText ?? "";
    const judge = await judgeAnswer({
        config: config.judge,
        question,
        hypothesis,
    });

    addJudgeUsage(questionState, judge.usage, judge.estimatedCostUsd);
    questionState.judge = {
        model: judge.model,
        prompt: judge.prompt,
        rawResponse: judge.rawResponse,
        label: judge.label,
    };

    const totalUsage = addTokenUsage(questionState.openCodeUsage, questionState.judgeUsage);
    const result: QuestionResultRecord = {
        question_id: question.question_id,
        question_type: question.question_type,
        dataset_index: questionState.datasetIndex,
        question: question.question,
        correct_answer: question.answer,
        question_date: question.question_date,
        hypothesis,
        judgment: judge.label ? "yes" : "no",
        score: judge.label ? 1 : 0,
        autoeval_label: {
            model: judge.model,
            label: judge.label,
        },
        answer_session_ids: question.answer_session_ids,
        haystack_session_ids: question.haystack_session_ids,
        haystack_open_code_session_ids: questionState.haystackSessions
            .map((entry) => entry.openCodeSessionId)
            .filter((value): value is string => typeof value === "string"),
        final_open_code_session_id: questionState.finalQuestion.openCodeSessionId,
        token_usage: {
            openCode: questionState.openCodeUsage,
            judge: questionState.judgeUsage,
            total: totalUsage,
        },
        costs: {
            openCodeActualUsd: questionState.openCodeActualCostUsd,
            openCodeEstimatedUsd: questionState.openCodeEstimatedCostUsd,
            judgeEstimatedUsd: questionState.judgeEstimatedCostUsd,
            totalActualUsd: questionState.openCodeActualCostUsd,
            totalEstimatedUsd:
                questionState.openCodeEstimatedCostUsd + questionState.judgeEstimatedCostUsd,
        },
        metadata: {
            startedAt: questionState.startedAt,
            completedAt: nowIso(),
            attemptCount: questionState.attemptCount,
        },
    };

    await appendLine(config.paths.resultsFile, JSON.stringify(result));
    resultsMap.set(question.question_id, result);
    return result;
}

async function cleanupSessions(args: {
    client: OpencodeClient;
    config: RunnerConfig;
    questionState: QuestionRunState;
    state: RunnerStateFile;
    questionId: string;
}): Promise<void> {
    const { client, config, questionState, state, questionId } = args;
    if (!config.cleanupSessions || questionState.cleanupCompleted) {
        return;
    }

    for (const sessionId of questionState.createdSessionIds) {
        try {
            await deleteSession(client, config, sessionId);
        } catch (error) {
            await appendLog(config.paths.logFile, `Cleanup failed for ${questionId}/${sessionId}: ${asError(error).message}`);
        }
    }
    questionState.cleanupCompleted = true;
    questionState.updatedAt = nowIso();
    state.inProgress[questionId] = questionState;
    await persistState(config, state);
}

async function markQuestionCompleted(args: {
    config: RunnerConfig;
    state: RunnerStateFile;
    questionState: QuestionRunState;
}): Promise<void> {
    const { config, state, questionState } = args;
    questionState.status = "completed";
    questionState.completedAt = nowIso();
    questionState.updatedAt = questionState.completedAt;
    state.completedQuestionIds = Array.from(new Set([...state.completedQuestionIds, questionState.questionId]));
    delete state.inProgress[questionState.questionId];
    await persistState(config, state);
}

function reconcileStateWithResults(
    state: RunnerStateFile,
    resultsMap: Map<string, QuestionResultRecord>,
): void {
    state.completedQuestionIds = Array.from(
        new Set([
            ...state.completedQuestionIds.filter((questionId) => resultsMap.has(questionId)),
            ...resultsMap.keys(),
        ]),
    );
}

async function processQuestion(args: {
    client: OpencodeClient;
    config: RunnerConfig;
    question: LongMemEvalQuestion;
    datasetIndex: number;
    state: RunnerStateFile;
    resultsMap: Map<string, QuestionResultRecord>;
}): Promise<void> {
    const { client, config, question, datasetIndex, state, resultsMap } = args;
    const resumedState = state.inProgress[question.question_id];
    if (resultsMap.has(question.question_id)) {
        if (resumedState) {
            await cleanupSessions({
                client,
                config,
                questionState: resumedState,
                state,
                questionId: question.question_id,
            });
            await markQuestionCompleted({ config, state, questionState: resumedState });
        }
        return;
    }
    if (state.completedQuestionIds.includes(question.question_id)) {
        return;
    }

    const questionState = resumedState ?? createQuestionState(question, datasetIndex);
    questionState.attemptCount += 1;
    questionState.updatedAt = nowIso();
    state.inProgress[question.question_id] = questionState;
    await persistState(config, state);

    try {
        await appendLog(config.paths.logFile, `Starting question ${question.question_id} (${question.question_type})`);
        await replayHaystack({ client, config, question, questionState, state });
        await askFinalQuestion({ client, config, question, questionState, state });
        await judgeQuestion({ config, question, questionState, state, resultsMap });
        await cleanupSessions({ client, config, questionState, state, questionId: question.question_id });
        await markQuestionCompleted({ config, state, questionState });
        await appendLog(config.paths.logFile, `Completed question ${question.question_id}`);
    } catch (error) {
        updateErrorState(questionState, "process-question", error);
        state.inProgress[question.question_id] = questionState;
        await persistState(config, state);
        await appendLog(
            config.paths.logFile,
            `Question ${question.question_id} failed: ${questionState.lastError?.message ?? "unknown"}`,
        );
        throw error;
    }
}

function buildSummary(results: QuestionResultRecord[], selectedCount: number, config: RunnerConfig): RunSummary {
    const rows: RunSummaryRow[] = LONGMEMEVAL_QUESTION_TYPES.map((category) => {
        const items = results.filter((result) => result.question_type === category);
        const correct = items.reduce((sum, item) => sum + item.score, 0);
        return {
            category,
            correct,
            total: items.length,
            accuracy: items.length === 0 ? 0 : correct / items.length,
        };
    });

    const overallCorrect = results.reduce((sum, item) => sum + item.score, 0);
    rows.push({
        category: "overall",
        correct: overallCorrect,
        total: results.length,
        accuracy: results.length === 0 ? 0 : overallCorrect / results.length,
    });

    const tokens = results.reduce(
        (acc, result) => addTokenUsage(acc, result.token_usage.total),
        createEmptyTokenUsageStats(),
    );
    const totalActualUsd = results.reduce((sum, result) => sum + result.costs.totalActualUsd, 0);
    const totalEstimatedUsd = results.reduce((sum, result) => sum + result.costs.totalEstimatedUsd, 0);

    return {
        generatedAt: nowIso(),
        datasetPath: config.datasetPath,
        selectionSignature: config.selectionSignature,
        completedQuestions: results.length,
        selectedQuestions: selectedCount,
        pendingQuestions: Math.max(selectedCount - results.length, 0),
        rows,
        costs: {
            totalActualUsd,
            totalEstimatedUsd,
        },
        tokens,
    };
}

function printSummary(summary: RunSummary): void {
    console.log("\nLongMemEval summary");
    console.table(
        summary.rows.map((row) => ({
            category: row.category,
            correct: row.correct,
            total: row.total,
            accuracy: row.total === 0 ? "n/a" : `${(row.accuracy * 100).toFixed(2)}%`,
        })),
    );
    console.log(`Estimated total cost: $${summary.costs.totalEstimatedUsd.toFixed(6)}`);
    console.log(`Actual OpenCode cost: $${summary.costs.totalActualUsd.toFixed(6)}`);
    console.log(`Total tokens: ${summary.tokens.totalTokens}`);
}

async function writeSummary(config: RunnerConfig, resultsMap: Map<string, QuestionResultRecord>, selectedCount: number): Promise<void> {
    const orderedResults = Array.from(resultsMap.values()).sort((left, right) => left.dataset_index - right.dataset_index);
    const summary = buildSummary(orderedResults, selectedCount, config);
    await writeJsonAtomic(config.paths.summaryFile, summary);
    printSummary(summary);
}

async function runWithParallelism(args: {
    client: OpencodeClient;
    config: RunnerConfig;
    workItems: Array<{ question: LongMemEvalQuestion; datasetIndex: number }>;
    state: RunnerStateFile;
    resultsMap: Map<string, QuestionResultRecord>;
}): Promise<void> {
    const { client, config, workItems, state, resultsMap } = args;
    let nextIndex = 0;
    const workerCount = Math.max(config.parallelism, 1);
    let fatalError: Error | null = null;

    async function worker(workerIndex: number): Promise<void> {
        while (nextIndex < workItems.length && fatalError === null) {
            const current = workItems[nextIndex];
            nextIndex += 1;
            if (!current) break;
            logLine(`Worker ${workerIndex} processing ${current.question.question_id}`);
            try {
                await processQuestion({
                    client,
                    config,
                    question: current.question,
                    datasetIndex: current.datasetIndex,
                    state,
                    resultsMap,
                });
            } catch (error) {
                fatalError = asError(error);
                await appendLog(
                    config.paths.logFile,
                    `Worker ${workerIndex} stopping due to failure on ${current.question.question_id}: ${fatalError.message}`,
                );
                break;
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, (_value, index) => worker(index + 1)));
    if (fatalError) {
        throw fatalError;
    }
}

async function ensureOutputArea(config: RunnerConfig): Promise<void> {
    await mkdir(config.paths.outputDir, { recursive: true });
    await ensureParentDirectory(config.paths.logFile);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        console.log(printUsage());
        return;
    }

    const projectDirectory = resolve(import.meta.dir, "../..");
    const config = parseRunnerConfig(argv, projectDirectory);
    await ensureOutputArea(config);
    await appendLog(config.paths.logFile, `Runner started with dataset ${config.datasetPath}`);

    const dataset = await loadDataset(config.datasetPath);
    const workItems = selectQuestions(dataset, config);
    const state = await loadState(config);
    const resultsMap = await loadResultsMap(config.paths.resultsFile);
    reconcileStateWithResults(state, resultsMap);
    await persistState(config, state);
    const client = createClient(config);

    try {
        await runWithParallelism({
            client,
            config,
            workItems,
            state,
            resultsMap,
        });
    } finally {
        await writeSummary(config, resultsMap, workItems.length);
    }
}

main().catch((error) => {
    const typed = asError(error);
    console.error(typed.message);
    process.exitCode = 1;
});
