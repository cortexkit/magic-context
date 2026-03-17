import type { Database } from "bun:sqlite";
import { log } from "../../shared";
import { executeFlush } from "./execute-flush";
import { executeStatus } from "./execute-status";
import type { NotificationParams } from "./send-session-notification";

export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}

export interface CommandExecuteOutput {
    parts: Array<{ type: string; text?: string }>;
}

const SENTINEL_PREFIX = "__CONTEXT_MANAGEMENT_";

export function createMagicContextCommandHandler(deps: {
    db: Database;
    protectedTags: number;
    nudgeIntervalTokens?: number;
    executeThresholdPercentage?: number | { default: number; [modelKey: string]: number };
    getLiveModelKey?: (sessionId: string) => string | undefined;
    onFlush?: (sessionId: string) => void;
    executeRecomp?: (sessionId: string) => Promise<string>;
    sendNotification: (
        sessionId: string,
        text: string,
        params: NotificationParams,
    ) => Promise<void>;
}) {
    const isStatusCommand = (command: string): boolean => command === "ctx-status";
    const isFlushCommand = (command: string): boolean => command === "ctx-flush";
    const isRecompCommand = (command: string): boolean => command === "ctx-recomp";

    return {
        "command.execute.before": async (
            input: CommandExecuteInput,
            _output: CommandExecuteOutput,
            _params: NotificationParams,
        ): Promise<void> => {
            const isStatus = isStatusCommand(input.command);
            const isFlush = isFlushCommand(input.command);
            const isRecomp = isRecompCommand(input.command);

            if (!isStatus && !isFlush && !isRecomp) {
                return;
            }

            const sessionId = input.sessionID;
            let result = "";

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
            log(`[magic-context] command ${input.command} handled via command.execute.before`);

            // OpenCode needs an exception here to stop normal command execution before model input.
            throw new Error(`${SENTINEL_PREFIX}${input.command.toUpperCase()}_HANDLED__`);
        },
    };
}
