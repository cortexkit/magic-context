import type { Database } from "bun:sqlite";
import type { DreamerConfig, SidekickConfig } from "../../config/schema/magic-context";
import {
    type DreamRunResult,
    enqueueDream,
    processDreamQueue,
} from "../../features/magic-context/dreamer";
import { runSidekick } from "../../features/magic-context/sidekick/agent";
import { getCompartments } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { sessionLog } from "../../shared";
import { executeFlush } from "./execute-flush";
import { executeStatus } from "./execute-status";
import type { NotificationParams } from "./send-session-notification";
import { sendUserPrompt } from "./send-session-notification";

/** Track per-session recomp confirmation for Desktop (no dialog available). */
const recompConfirmationBySession = new Map<string, number>();
const RECOMP_CONFIRMATION_WINDOW_MS = 60_000;

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
            sessionDirectory?: string;
            client: PluginContext["client"];
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
        client: deps.sidekick.client,
        sessionId,
        projectPath: deps.sidekick.projectPath,
        sessionDirectory: deps.sidekick.sessionDirectory,
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

    // Step 4: Send as a real user prompt (will be processed by the model)
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
            experimentalUserMemories?: { enabled: boolean; promotionThreshold: number };
            experimentalPinKeyFiles?: {
                enabled: boolean;
                token_budget: number;
                min_reads: number;
            };
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

    // dream_queue table is created in initializeDatabase() — no ensureDreamQueueTable needed
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
              experimentalUserMemories: deps.dreamer.experimentalUserMemories,
              experimentalPinKeyFiles: deps.dreamer.experimentalPinKeyFiles,
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
    commitClusterTrigger?: { enabled: boolean; min_clusters: number };
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
        sessionDirectory?: string;
        client: PluginContext["client"];
    };
    dreamer?: {
        config: DreamerConfig;
        projectPath: string;
        client: unknown;
        directory: string;
        executeDream?: (sessionId: string) => Promise<DreamRunResult | null>;
        experimentalUserMemories?: { enabled: boolean; promotionThreshold: number };
        experimentalPinKeyFiles?: {
            enabled: boolean;
            token_budget: number;
            min_reads: number;
        };
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
                    deps.commitClusterTrigger,
                );
                result += result ? `\n\n${statusOutput}` : statusOutput;
            }

            if (isRecomp) {
                if (!deps.executeRecomp) {
                    result =
                        "## Magic Recomp\n\n/ctx-recomp is unavailable because the recomp handler is not configured.";
                } else {
                    // Desktop double-tap confirmation.
                    // TUI uses a native dialog → message bus → tui-action-consumer.ts
                    const lastConfirmation = recompConfirmationBySession.get(sessionId);
                    const now = Date.now();

                    if (
                        lastConfirmation &&
                        now - lastConfirmation < RECOMP_CONFIRMATION_WINDOW_MS
                    ) {
                        // Confirmed — second /ctx-recomp within 60s
                        recompConfirmationBySession.delete(sessionId);
                        await deps.sendNotification(
                            sessionId,
                            "## Magic Recomp\n\nHistorian recomp started. Rebuilding compartments and facts from raw session history now.",
                            {},
                        );
                        result = await deps.executeRecomp(sessionId);
                    } else {
                        // First attempt — show warning
                        recompConfirmationBySession.set(sessionId, now);
                        const compartments = getCompartments(deps.db, sessionId);
                        const compartmentCount = compartments.length;
                        const warningLines = [
                            "## ⚠️ Recomp Confirmation Required",
                            "",
                            `You currently have **${compartmentCount}** compartments.`,
                            "Running /ctx-recomp will **regenerate all compartments and facts** from raw session history.",
                            "",
                            "This operation:",
                            "- May take a long time (minutes to hours for long sessions)",
                            "- Will consume significant tokens on your historian model",
                            "- Cannot be interrupted cleanly once started",
                            "",
                            "**To confirm, run `/ctx-recomp` again within 60 seconds.**",
                        ];
                        result = warningLines.join("\n");
                    }
                }
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
