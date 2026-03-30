import type { Database } from "bun:sqlite";
import type { PluginContext } from "../../plugin/types";
import type { NotificationParams } from "./send-session-notification";

export interface CompartmentRunnerDeps {
    client: PluginContext["client"];
    db: Database;
    sessionId: string;
    tokenBudget: number;
    historianTimeoutMs?: number;
    directory: string;
    historyBudgetTokens?: number;
    getNotificationParams?: () => NotificationParams;
}

export interface CandidateCompartment {
    sequence: number;
    startMessage: number;
    endMessage: number;
    startMessageId: string;
    endMessageId: string;
    title: string;
    content: string;
}

export interface HistorianRunResult {
    ok: boolean;
    result?: string;
    error?: string;
    dumpPath?: string;
}

export type ValidatedHistorianPassResult =
    | {
          ok: true;
          compartments: CandidateCompartment[];
          facts: Array<{ category: string; content: string }>;
      }
    | { ok: false; error: string };

export interface StoredCompartmentRange {
    startMessage: number;
    endMessage: number;
}

export interface HistorianProgressCallbacks {
    onRepairRetry?: (error: string) => Promise<void>;
}
