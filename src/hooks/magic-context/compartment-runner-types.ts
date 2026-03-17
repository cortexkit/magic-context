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

export interface ValidatedHistorianPassResult {
    ok: boolean;
    compartments?: CandidateCompartment[];
    facts?: Array<{ category: string; content: string }>;
    notes?: string[];
    mode?: "chunk" | "full";
    error?: string;
}

export interface StoredCompartmentRange {
    startMessage: number;
    endMessage: number;
}

export interface HistorianProgressCallbacks {
    onRepairRetry?: (error: string) => Promise<void>;
}
