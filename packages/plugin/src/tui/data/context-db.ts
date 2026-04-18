/**
 * TUI data layer — pure RPC client, no direct SQLite access.
 * All data is fetched from the server plugin via HTTP RPC.
 */
import os from "node:os";
import path from "node:path";
import { MagicContextRpcClient } from "../../shared/rpc-client";
import type { RpcNotificationMessage, SidebarSnapshot, StatusDetail } from "../../shared/rpc-types";

export type { SidebarSnapshot, StatusDetail };

let rpcClient: MagicContextRpcClient | null = null;

function getStorageDir(): string {
    const dataDir = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
    return path.join(dataDir, "opencode", "storage", "plugin", "magic-context");
}

/** Initialize the RPC client. Call once on TUI startup. */
export function initRpcClient(directory: string): void {
    const storageDir = getStorageDir();
    rpcClient = new MagicContextRpcClient(storageDir, directory);
}

/** Clean up the RPC client. */
export function closeRpc(): void {
    rpcClient?.reset();
    rpcClient = null;
}

const EMPTY_SNAPSHOT: SidebarSnapshot = {
    sessionId: "",
    usagePercentage: 0,
    inputTokens: 0,
    systemPromptTokens: 0,
    compartmentCount: 0,
    factCount: 0,
    memoryCount: 0,
    memoryBlockCount: 0,
    pendingOpsCount: 0,
    historianRunning: false,
    compartmentInProgress: false,
    sessionNoteCount: 0,
    readySmartNoteCount: 0,
    cacheTtl: "5m",
    lastDreamerRunAt: null,
    projectIdentity: null,
    compartmentTokens: 0,
    factTokens: 0,
    memoryTokens: 0,
    conversationTokens: 0,
    toolCallTokens: 0,
    toolDefinitionTokens: 0,
};

/** Fetch sidebar snapshot from the server via RPC. */
export async function loadSidebarSnapshot(
    sessionId: string,
    directory: string,
): Promise<SidebarSnapshot> {
    if (!rpcClient) return { ...EMPTY_SNAPSHOT, sessionId };
    try {
        const result = await rpcClient.call<SidebarSnapshot>("sidebar-snapshot", {
            sessionId,
            directory,
        });
        if ((result as unknown as Record<string, unknown>).error) {
            return { ...EMPTY_SNAPSHOT, sessionId };
        }
        return result;
    } catch {
        return { ...EMPTY_SNAPSHOT, sessionId };
    }
}

/** Fetch full status detail from the server via RPC. */
export async function loadStatusDetail(
    sessionId: string,
    directory: string,
    modelKey?: string,
): Promise<StatusDetail> {
    const emptyDetail: StatusDetail = {
        ...EMPTY_SNAPSHOT,
        sessionId,
        tagCounter: 0,
        activeTags: 0,
        droppedTags: 0,
        totalTags: 0,
        activeBytes: 0,
        lastResponseTime: 0,
        lastNudgeTokens: 0,
        lastNudgeBand: "",
        lastTransformError: null,
        isSubagent: false,
        pendingOps: [],
        contextLimit: 0,
        cacheTtlMs: 0,
        cacheRemainingMs: 0,
        cacheExpired: false,
        executeThreshold: 65,
        protectedTagCount: 20,
        nudgeInterval: 20000,
        historyBudgetPercentage: 0.15,
        nextNudgeAfter: 0,
        historyBlockTokens: 0,
        compressionBudget: null,
        compressionUsage: null,
    };

    if (!rpcClient) return emptyDetail;
    try {
        const result = await rpcClient.call<StatusDetail>("status-detail", {
            sessionId,
            directory,
            modelKey,
        });
        if ((result as unknown as Record<string, unknown>).error) {
            return emptyDetail;
        }
        return result;
    } catch {
        return emptyDetail;
    }
}

/** Get compartment count via RPC. */
export async function getCompartmentCount(sessionId: string): Promise<number> {
    if (!rpcClient) return 0;
    try {
        const result = await rpcClient.call<{ count: number }>("compartment-count", { sessionId });
        return result.count ?? 0;
    } catch {
        return 0;
    }
}

/** Send recomp request to server via RPC. */
export async function requestRecomp(sessionId: string): Promise<boolean> {
    if (!rpcClient) return false;
    try {
        const result = await rpcClient.call<{ ok: boolean }>("recomp", { sessionId });
        return result.ok ?? false;
    } catch {
        return false;
    }
}

export interface TuiMessage {
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}

/** Poll for pending server→TUI notifications via RPC. */
export async function consumeTuiMessages(): Promise<TuiMessage[]> {
    if (!rpcClient) return [];
    try {
        const result = await rpcClient.call<{ messages: RpcNotificationMessage[] }>(
            "pending-notifications",
        );
        return (result.messages ?? []).map((m) => ({
            type: m.type,
            payload: m.payload,
            sessionId: m.sessionId,
        }));
    } catch {
        return [];
    }
}
