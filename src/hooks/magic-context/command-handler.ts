import type { Database } from "bun:sqlite";
import type { DreamerConfig } from "../../config/schema/magic-context";
import {
    enqueueDream,
    ensureDreamQueueTable,
    processDreamQueue,
    type DreamRunResult,
} from "../../features/magic-context/dreamer";
import { sessionLog } from "../../shared";
import { runSidekick } from "../../features/magic-context/sidekick/agent";
import type { SidekickConfig } from "../../features/magic-context/sidekick/types";
import { executeFlush } from "./execute-flush";
import { executeStatus } from "./execute-status";
import type { NotificationParams } from "./send-session-notification";
import { sendUserPrompt } from "./send-session-notification";

export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}

export interface CommandExecuteOutput {
    parts: Array<{ type: string; text?: string }>;
}

const SENTINEL_PREFIX = "__CONTEXT_MANAGEMENT_";

/**
 * Execute /ctx-aug: run sidekick to augment the user's prompt with relevant memories,
 * then send the augmented prompt as a real user message.
 */
async function executeAugmentation(
    deps: {
        db: Database;
        sendNotification: (
            sessionId: string,
            text: string,
            params: NotificationParams,
        ) => Promise<void>;
        sidekick?: {
            config: SidekickConfig;
            projectPath: string;
            client: unknown;
            pendingResults: Map<string, string>;
        };
    },
    sessionId: string,
    userPrompt: string,
): Promise<never> {
    if (!deps.sidekick?.config) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-aug\n\nSidekick is not configured. Add sidekick settings to `magic-context.jsonc` to use /ctx-aug.",
            {},
        );
        throw new Error(`${SENTINEL_PREFIX}CTX-AUG_HANDLED__`);
    }

    const prompt = userPrompt.trim();
    if (prompt.length === 0) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-aug\n\nUsage: `/ctx-aug <your prompt>`\n\nProvide a prompt to augment with project memory context.",
            {},
        );
        throw new Error(`${SENTINEL_PREFIX}CTX-AUG_HANDLED__`);
    }

    // Step 1: Show "preparing" notification (hidden from LLM)
    await deps.sendNotification(
        sessionId,
        "🔍 Preparing augmentation… this may take 2-10s depending on your sidekick provider.",
        {},
    );

    // Step 2: Run sidekick
    sessionLog(sessionId, "/ctx-aug: running sidekick");
    const sidekickResult = await runSidekick({
        db: deps.db,
        sessionId,
        projectPath: deps.sidekick.projectPath,
        userMessage: prompt,
        config: deps.sidekick.config,
    });

    // Step 3: Build augmented prompt
    let augmentedPrompt: string;
    if (sidekickResult) {
        augmentedPrompt = `${prompt}\n\n<sidekick-augmentation>\n${sidekickResult}\n</sidekick-augmentation>`;
        sessionLog(sessionId, `/ctx-aug: sidekick returned ${sidekickResult.length} chars`);
    } else {
        // Sidekick returned nothing — send the prompt as-is with a note
        augmentedPrompt = prompt;
        sessionLog(sessionId, "/ctx-aug: sidekick returned no result, sending prompt as-is");
    }

    // Step 4: Store result so transform can suppress <project-memory> if this is the first message
    deps.sidekick.pendingResults.set(sessionId, augmentedPrompt);

    // Step 5: Send as a real user prompt (will be processed by the model)
    await sendUserPrompt(deps.sidekick.client, sessionId, augmentedPrompt);

    throw new Error(`${SENTINEL_PREFIX}CTX-AUG_HANDLED__`);
}

function summarizeDreamResult(result: DreamRunResult): string {
    const taskLines = result.tasks.map((task: DreamRunResult["tasks"][number]) => {
        const seconds = (task.durationMs / 1000).toFixed(1);
        return task.error
            ? `- ${task.name}: failed after ${seconds}s — ${task.error}`
            : `- ${task.name}: completed in ${seconds}s`;
    });

    return [
        "## /ctx-dream",
        "",
        `Started: ${new Date(result.startedAt).toISOString()}`,
        `Finished: ${new Date(result.finishedAt).toISOString()}`,
        `Lease holder: ${result.holderId}`,
        "",
        "### Tasks",
        ...(taskLines.length > 0 ? taskLines : ["- No tasks ran."]),
    ].join("\n");
}

async function executeDreaming(
    deps: {
        db: Database;
        sendNotification: (
            sessionId: string,
            text: string,
            params: NotificationParams,
        ) => Promise<void>;
        dreamer?: {
            config: DreamerConfig;
            projectPath: string;
            client: unknown;
            directory: string;
            executeDream?: (sessionId: string) => Promise<DreamRunResult | null>;
        };
    },
    sessionId: string,
): Promise<never> {
    if (!deps.dreamer?.config?.tasks?.length) {
        await deps.sendNotification(
            sessionId,
            "## /ctx-dream\n\nDreaming is not configured for this project.",
            {},
        );
        throw new Error(`${SENTINEL_PREFIX}CTX-DREAM_HANDLED__`);
    }

    ensureDreamQueueTable(deps.db);
    const entry = enqueueDream(deps.db, deps.dreamer.projectPath, "manual");
    if (!entry) {
        await deps.sendNotification(sessionId, "Dream already queued for this project", {});
        throw new Error(`${SENTINEL_PREFIX}CTX-DREAM_HANDLED__`);
    }

    await deps.sendNotification(sessionId, "Starting dream run...", {});

    const result = deps.dreamer.executeDream
        ? await deps.dreamer.executeDream(sessionId)
        : await processDreamQueue({
              db: deps.db,
              client: deps.dreamer.client as never,
              tasks: deps.dreamer.config.tasks,
              taskTimeoutMinutes: deps.dreamer.config.task_timeout_minutes,
              maxRuntimeMinutes: deps.dreamer.config.max_runtime_minutes,
          });

    await deps.sendNotification(
        sessionId,
        result
            ? summarizeDreamResult(result)
            : "Dream queued, but another worker is already processing the queue.",
        {},
    );
    throw new Error(`${SENTINEL_PREFIX}CTX-DREAM_HANDLED__`);
}

export function createMagicContextCommandHandler(deps: {
    db: Database;
    protectedTags: number;
    nudgeIntervalTokens?: number;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    historyBudgetPercentage?: number;
    getLiveModelKey?: (sessionId: string) => string | undefined;
    onFlush?: (sessionId: string) => void;
    executeRecomp?: (sessionId: string) => Promise<string>;
    sendNotification: (
        sessionId: string,
        text: string,
        params: NotificationParams,
    ) => Promise<void>;
    sidekick?: {
        config: SidekickConfig;
        projectPath: string;
        client: unknown;
        pendingResults: Map<string, string>;
    };
    dreamer?: {
        config: DreamerConfig;
        projectPath: string;
        client: unknown;
        directory: string;
        executeDream?: (sessionId: string) => Promise<DreamRunResult | null>;
    };
}) {
    const isStatusCommand = (command: string): boolean => command === "ctx-status";
    const isFlushCommand = (command: string): boolean => command === "ctx-flush";
    const isRecompCommand = (command: string): boolean => command === "ctx-recomp";
    const isAugCommand = (command: string): boolean => command === "ctx-aug";
    const isDreamCommand = (command: string): boolean => command === "ctx-dream";

    return {
        "command.execute.before": async (
            input: CommandExecuteInput,
            _output: CommandExecuteOutput,
            _params: NotificationParams,
        ): Promise<void> => {
            const isStatus = isStatusCommand(input.command);
            const isFlush = isFlushCommand(input.command);
            const isRecomp = isRecompCommand(input.command);
            const isAug = isAugCommand(input.command);
            const isDream = isDreamCommand(input.command);

            if (!isStatus && !isFlush && !isRecomp && !isAug && !isDream) {
                return;
            }

            const sessionId = input.sessionID;
            let result = "";

            if (isAug) {
                await executeAugmentation(deps, sessionId, input.arguments);
                return; // executeAugmentation throws sentinel internally
            }

            if (isDream) {
                await executeDreaming(deps, sessionId);
                return;
            }

            if (isFlush) {
                result = executeFlush(deps.db, sessionId);
                deps.onFlush?.(sessionId);
            }

            if (isStatus) {
                const liveModelKey = deps.getLiveModelKey?.(sessionId);
                const statusOutput = executeStatus(
                    deps.db,
                    sessionId,
                    deps.protectedTags,
                    deps.nudgeIntervalTokens,
                    deps.executeThresholdPercentage,
                    liveModelKey,
                    deps.historyBudgetPercentage,
                );
                result += result ? `\n\n${statusOutput}` : statusOutput;
            }

            if (isRecomp) {
                await deps.sendNotification(
                    sessionId,
                    "## Magic Recomp\n\nHistorian recomp started. Rebuilding compartments and facts from raw session history now.",
                    {},
                );
                result = deps.executeRecomp
                    ? await deps.executeRecomp(sessionId)
                    : "## Magic Recomp\n\n/ctx-recomp is unavailable because the recomp handler is not configured.";
            }

            await deps.sendNotification(sessionId, result, {});
            sessionLog(sessionId, `command ${input.command} handled via command.execute.before`);

            // OpenCode limitation: the command.execute.before hook has no "handled" return path.
            // Throwing a sentinel exception is the only way to prevent OpenCode from continuing
            // with normal command execution (which would send the command to the model).
            // A typed result object or custom error class with an isSentinel flag would be cleaner,
            // but requires an upstream API change. See audit finding #20.
            throw new Error(`${SENTINEL_PREFIX}${input.command.toUpperCase()}_HANDLED__`);
        },
    };
}
