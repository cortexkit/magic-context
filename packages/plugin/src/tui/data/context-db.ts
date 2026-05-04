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
    // Plugin v0.16+ uses the shared cortexkit/magic-context path so OpenCode
    // and Pi can share state. The TUI just needs to point its RPC client at
    // the same storage directory the server plugin uses for the lock-file
    // discovery convention.
    const dataDir = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
    return path.join(dataDir, "cortexkit", "magic-context");
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

/**
 * Per-session client-side sticky cache. Mirrors the server-side cache in
 * `sidebar-snapshot-cache.ts` but covers the cases the server can't:
 *   - RPC call fails entirely (timeout, abort, parse error) → server is never reached
 *   - RPC server is not yet up (port file missing, retries exhausted)
 *   - Server returns an error envelope
 *
 * In all three cases the breakdown bar would otherwise disappear until the
 * next successful refresh. With this cache, the client returns the most
 * recent good snapshot for the same session so the UI stays stable through
 * transient RPC blips. 5-minute staleness ceiling keeps it from showing
 * obviously old data after long disconnects.
 */
interface CachedSnapshot {
    snapshot: SidebarSnapshot;
    cachedAt: number;
}
const STICKY_TTL_MS = 5 * 60 * 1000;
const STICKY_MAX_ENTRIES = 100;
const stickySidebarCache = new Map<string, CachedSnapshot>();

function rememberSidebarSnapshot(snapshot: SidebarSnapshot): void {
    if (!snapshot.sessionId || snapshot.inputTokens <= 0) return;
    // LRU-style bound: drop the oldest entry once we hit the cap. With a
    // 5-min TTL most stale entries time out naturally; this just prevents
    // unbounded growth across many session switches in a long TUI session.
    if (
        stickySidebarCache.size >= STICKY_MAX_ENTRIES &&
        !stickySidebarCache.has(snapshot.sessionId)
    ) {
        const firstKey = stickySidebarCache.keys().next().value;
        if (firstKey) stickySidebarCache.delete(firstKey);
    }
    stickySidebarCache.set(snapshot.sessionId, {
        snapshot,
        cachedAt: Date.now(),
    });
}

function recallSidebarSnapshot(sessionId: string, fallback: SidebarSnapshot): SidebarSnapshot {
    const cached = stickySidebarCache.get(sessionId);
    if (!cached) return fallback;
    if (Date.now() - cached.cachedAt > STICKY_TTL_MS) {
        stickySidebarCache.delete(sessionId);
        return fallback;
    }
    return cached.snapshot;
}

/** Fetch sidebar snapshot from the server via RPC. */
export async function loadSidebarSnapshot(
    sessionId: string,
    directory: string,
): Promise<SidebarSnapshot> {
    const empty: SidebarSnapshot = { ...EMPTY_SNAPSHOT, sessionId };
    if (!rpcClient) return recallSidebarSnapshot(sessionId, empty);
    try {
        const result = await rpcClient.call<SidebarSnapshot>("sidebar-snapshot", {
            sessionId,
            directory,
        });
        if ((result as unknown as Record<string, unknown>).error) {
            return recallSidebarSnapshot(sessionId, empty);
        }
        // Trust successful server responses. The server has its own sticky
        // sidebar cache (`sidebar-snapshot-cache.ts`) that handles transient
        // zero-token windows by hybriding cached breakdown values into a
        // fresh snapshot, AND clears that cache on `session.deleted`. If the
        // server reaches us with `inputTokens === 0`, that's its considered
        // answer — typically because the session was deleted, reverted, or
        // is brand-new with no responses yet.
        //
        // Falling back to the client cache here would resurrect old token
        // data for a deleted session (the client never sees `session.deleted`
        // events, so its cache TTL is the only expiry). Sticky behavior is
        // owned exclusively by the server side.
        rememberSidebarSnapshot(result);
        return result;
    } catch {
        return recallSidebarSnapshot(sessionId, empty);
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
        executeThresholdMode: "percentage",
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
