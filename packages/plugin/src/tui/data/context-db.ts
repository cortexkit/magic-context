/**
 * TUI data layer — pure RPC client, no direct SQLite access.
 * All data is fetched from the server plugin via HTTP RPC.
 */
import { getMagicContextStorageDir } from "../../shared/data-path";
import { pluginPackageVersion } from "../../shared/plugin-package-version";
import { MagicContextRpcClient, RpcServerNotFoundError } from "../../shared/rpc-client";
import type { EmbedDetail, SidebarSnapshot, StatusDetail } from "../../shared/rpc-types";
import {
    checkStatusDetailPayload,
    type OpenCodeStatusExtras,
    type StatusCheck,
    statusRpcFailure,
} from "../../shared/status-view-check";

export type { EmbedDetail, SidebarSnapshot, StatusDetail };

let rpcClient: MagicContextRpcClient | null = null;
let rpcClientDirectory: string | null = null;
let rpcGeneration = 0;

/**
 * Clients for session directories other than the one the TUI started in.
 *
 * OpenCode runs one Magic Context server instance per directory, and each one
 * writes its RPC discovery file under that directory's hash. A TUI started in
 * one directory (commonly the home directory) can show a session whose
 * directory is another project; asking the startup directory's server about
 * that session returns the startup directory's answer (for the home directory:
 * no project state at all), so the sidebar and `/ctx-status` showed nothing.
 * Session-scoped calls therefore go to the client for the session's own
 * directory. The startup client stays as it is for the notification socket and
 * the process-wide calls.
 */
const sessionDirectoryClients = new Map<string, MagicContextRpcClient>();
const MAX_SESSION_DIRECTORY_CLIENTS = 16;

/** Initialize the RPC client. Call once on TUI startup. */
export function initRpcClient(directory: string): void {
    const storageDir = getMagicContextStorageDir();
    // Bump the generation before replacing the client so late notification
    // responses from a disposed client are ignored (the WS socket observes the
    // new generation and abandons its in-flight connect).
    rpcGeneration += 1;
    rpcClient = new MagicContextRpcClient(storageDir, directory);
    rpcClientDirectory = directory;
    resetSessionDirectoryClients();
}

function resetSessionDirectoryClients(): void {
    for (const client of sessionDirectoryClients.values()) client.reset();
    sessionDirectoryClients.clear();
}

/**
 * The client for the server instance that owns `directory`: the startup client
 * when the directory is the one the TUI started in (or unknown), otherwise a
 * client discovering that directory's own server. Null before init.
 */
function clientForDirectory(directory: string): MagicContextRpcClient | null {
    if (!rpcClient) return null;
    if (!directory || directory === rpcClientDirectory) return rpcClient;
    const existing = sessionDirectoryClients.get(directory);
    if (existing) return existing;
    if (sessionDirectoryClients.size >= MAX_SESSION_DIRECTORY_CLIENTS) {
        const oldest = sessionDirectoryClients.keys().next().value;
        if (oldest !== undefined) {
            sessionDirectoryClients.get(oldest)?.reset();
            sessionDirectoryClients.delete(oldest);
        }
    }
    // Short resolution: when this directory has no discovery file the caller
    // falls back to asking every local server (see `callSessionRpc`) instead of
    // retrying the miss for fifteen seconds.
    const client = new MagicContextRpcClient(getMagicContextStorageDir(), directory, {
        resolveAttempts: 2,
        reresolveAttempts: 1,
    });
    sessionDirectoryClients.set(directory, client);
    return client;
}

/**
 * The server the notification socket should subscribe to: the one that owns
 * the shown session's directory, so a push from the command that session runs
 * (for example `/ctx-status` asking to open its dialog) reaches this TUI. That
 * is the startup directory's server when no session is shown or the session is
 * in the startup directory. A session directory with no discovery file falls
 * back to the server that claims the session, then to the startup server so
 * session-less notifications still arrive.
 */
export async function resolveNotificationTarget(
    sessionDirectory: string | null,
    sessionId: string | null,
): Promise<{
    client: MagicContextRpcClient;
    directory: string;
    endpoint: { port: number; token: string | null; instanceId: string | null };
} | null> {
    const startup = rpcClient;
    if (!startup) return null;
    const directory = sessionDirectory ?? "";
    let client = clientForDirectory(directory) ?? startup;
    let endpoint = await client.resolveEndpoint();
    if (!endpoint && client !== startup && sessionId) {
        const owner = await MagicContextRpcClient.findSessionOwner(
            getMagicContextStorageDir(),
            sessionId,
        );
        if (owner) {
            sessionDirectoryClients.get(directory)?.reset();
            sessionDirectoryClients.set(directory, owner);
            client = owner;
            endpoint = await owner.resolveEndpoint();
        }
    }
    if (endpoint) {
        return {
            client,
            directory: client === startup ? (rpcClientDirectory ?? "") : directory,
            endpoint,
        };
    }
    if (client === startup) return null;
    const startupEndpoint = await startup.resolveEndpoint();
    return startupEndpoint
        ? { client: startup, directory: rpcClientDirectory ?? "", endpoint: startupEndpoint }
        : null;
}

/** The directory whose server a notification subscription for `sessionDirectory` targets first. */
export function notificationDirectoryFor(sessionDirectory: string | null): string {
    const directory = sessionDirectory ?? "";
    if (!directory || directory === rpcClientDirectory) return rpcClientDirectory ?? "";
    return directory;
}

/**
 * Call a session-scoped RPC on the server that owns the session's directory.
 * When no server is filed under that directory (the host spelled it in a way
 * the canonical form still does not match), every live local server is asked
 * whether it owns the session, and the owner, if any, answers this call and
 * later ones for the directory. Only when no server claims the session does
 * the call fail as before.
 */
async function callSessionRpc<T>(
    directory: string,
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
): Promise<T> {
    const client = clientForDirectory(directory);
    if (!client) throw new Error("RPC client is not initialized");
    try {
        return await client.call<T>(method, params);
    } catch (error) {
        if (!(error instanceof RpcServerNotFoundError) || client === rpcClient) throw error;
        const owner = await MagicContextRpcClient.findSessionOwner(
            getMagicContextStorageDir(),
            sessionId,
        );
        if (!owner) throw error;
        sessionDirectoryClients.get(directory)?.reset();
        sessionDirectoryClients.set(directory, owner);
        return owner.call<T>(method, params);
    }
}

export function getRpcGeneration(): number {
    return rpcGeneration;
}

/** The live RPC client (for the WS notification socket's endpoint discovery).
 *  Null before init / after close. */
export function getRpcClient(): MagicContextRpcClient | null {
    return rpcClient;
}

/** Clean up the RPC client. */
export function closeRpc(): void {
    // Closing invalidates any already-issued RPC calls; their callbacks must
    // observe the new generation and abandon (the WS socket checks it too).
    rpcGeneration += 1;
    rpcClient?.reset();
    rpcClient = null;
    rpcClientDirectory = null;
    resetSessionDirectoryClients();
}

const EMPTY_SNAPSHOT: SidebarSnapshot = {
    sessionId: "",
    usagePercentage: 0,
    inputTokens: 0,
    contextLimit: 0,
    systemPromptTokens: 0,
    compartmentCount: 0,
    memoryCount: 0,
    memoryBlockCount: 0,
    pendingOpsCount: 0,
    historianRunning: false,
    compartmentInProgress: false,
    sessionNoteCount: 0,
    readySmartNoteCount: 0,
    cacheTtl: "5m",
    lastTransformError: null,
    lastDreamerRunAt: null,
    projectIdentity: null,
    compartmentTokens: 0,
    factTokens: 0,
    memoryTokens: 0,
    docsTokens: 0,
    profileTokens: 0,
    conversationTokens: 0,
    toolCallTokens: 0,
    toolDefinitionTokens: 0,
    executeThreshold: 65,
    newWorkTokens: null,
    totalInputTokens: null,
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
    if (!snapshot.sessionId) return;
    if (snapshot.inputTokens <= 0) {
        // A successful zero is authoritative (new/deleted/reverted session) and
        // must prevent a later transport failure from resurrecting old values.
        stickySidebarCache.delete(snapshot.sessionId);
        return;
    }
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
    options?: { throwOnFailure?: boolean },
): Promise<SidebarSnapshot> {
    const empty: SidebarSnapshot = { ...EMPTY_SNAPSHOT, sessionId };
    if (!rpcClient) {
        if (options?.throwOnFailure) throw new Error("RPC client is not initialized");
        return recallSidebarSnapshot(sessionId, empty);
    }
    try {
        const result = await callSessionRpc<SidebarSnapshot>(
            directory,
            sessionId,
            "sidebar-snapshot",
            {
                sessionId,
                directory,
            },
        );
        if ((result as unknown as Record<string, unknown>).error) {
            if (options?.throwOnFailure)
                throw new Error(String((result as unknown as Record<string, unknown>).error));
            // Snapshot-build errors are explicit failure envelopes, equivalent to
            // a transport failure: retain the last known-good client snapshot.
            return recallSidebarSnapshot(sessionId, empty);
        }
        // Trust successful server responses, including authoritative zeroes. The server has its own sticky
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
    } catch (error) {
        if (options?.throwOnFailure) throw error;
        return recallSidebarSnapshot(sessionId, empty);
    }
}

export type StatusDetailResult = StatusCheck<OpenCodeStatusExtras>;

/**
 * Fetch the status for the `/ctx-status` dialog. Every reply, including a
 * transport failure, comes back as a checked result: either a snapshot the
 * view model can draw, or the reason there is none. The dialog never receives
 * an unchecked payload.
 */
export async function loadStatusDetail(
    sessionId: string,
    directory: string,
    modelKey?: string,
): Promise<StatusDetailResult> {
    if (!rpcClient) return statusRpcFailure("RPC client is not initialized");
    try {
        const reply = await callSessionRpc<unknown>(directory, sessionId, "status-detail", {
            sessionId,
            directory,
            modelKey,
        });
        return checkStatusDetailPayload(reply, pluginPackageVersion() ?? "unknown");
    } catch (error) {
        return statusRpcFailure(error instanceof Error ? error.message : String(error));
    }
}

const EMPTY_EMBED_DETAIL: EmbedDetail = {
    enabled: false,
    model: "off",
    provider: "off",
    session: { embedded: 0, total: 0 },
    memories: { embedded: 0, total: 0 },
    commits: { embedded: 0, total: 0, gitEnabled: false },
    statusText: "Embedding is off (no provider configured).",
};

/** Fetch embedding coverage status for `/ctx-embed` via RPC. */
export async function loadEmbedDetail(sessionId: string, directory: string): Promise<EmbedDetail> {
    if (!rpcClient) return EMPTY_EMBED_DETAIL;
    try {
        const result = await callSessionRpc<EmbedDetail>(directory, sessionId, "embed-detail", {
            sessionId,
            directory,
        });
        if ((result as unknown as Record<string, unknown>).error) {
            return EMPTY_EMBED_DETAIL;
        }
        return result;
    } catch {
        return EMPTY_EMBED_DETAIL;
    }
}

export type CompartmentCountResult = { ok: true; count: number } | { ok: false; error: string };

/** Get compartment count without making transport failure look like a real zero. */
export async function getCompartmentCount(
    sessionId: string,
    directory?: string,
): Promise<CompartmentCountResult> {
    if (!rpcClient) return { ok: false, error: "RPC client is not initialized" };
    try {
        const result = await callSessionRpc<{ count?: number; error?: string }>(
            directory ?? "",
            sessionId,
            "compartment-count",
            {
                sessionId,
                directory,
            },
        );
        if (typeof result.error === "string") return { ok: false, error: result.error };
        if (typeof result.count !== "number" || !Number.isFinite(result.count)) {
            return { ok: false, error: "Invalid compartment count response" };
        }
        return { ok: true, count: result.count };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Send recomp request to server via RPC. `directory` is the session's
 * directory, so the request reaches the server instance that owns the session
 * (the same one the recomp dialog read its compartment count from).
 */
export async function requestRecomp(sessionId: string, directory?: string): Promise<boolean> {
    if (!rpcClient) return false;
    try {
        const result = await callSessionRpc<{ ok: boolean }>(directory ?? "", sessionId, "recomp", {
            sessionId,
        });
        return result.ok ?? false;
    } catch {
        return false;
    }
}

/** Start a manual `/ctx-dream` run (optionally one named task) via RPC. The
 *  server starts the pass in the background and pushes the summary when done. */
export async function requestDream(sessionId: string, task?: string): Promise<boolean> {
    if (!rpcClient) return false;
    try {
        const result = await rpcClient.call<{ ok: boolean }>("dream", {
            sessionId,
            ...(task ? { task } : {}),
        });
        return result.ok ?? false;
    } catch {
        return false;
    }
}

/** What a command RPC reports back: finished text, an acknowledgement that
 *  background work started (no text yet), or the failure. */
export type CommandRpcResult =
    | { ok: true; message?: string; started?: boolean }
    | { ok: false; error?: string };

async function callCommandRpc(
    method: string,
    params: Record<string, unknown>,
): Promise<CommandRpcResult> {
    if (!rpcClient) return { ok: false };
    try {
        const result = await rpcClient.call<CommandRpcResult>(method, params);
        return result.ok === true
            ? result
            : { ok: false, error: (result as { error?: string }).error };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

/** Run `/ctx-flush` for the session: apply the queued operations now. */
export async function requestFlush(sessionId: string): Promise<CommandRpcResult> {
    return callCommandRpc("flush", { sessionId });
}

/** Start `/ctx-wrapup`: compact the older live tail, keeping the newest N raw. */
export async function requestWrapup(
    sessionId: string,
    messagesToKeep: number,
): Promise<CommandRpcResult> {
    return callCommandRpc("wrapup", { sessionId, messagesToKeep });
}

/** `/ctx-embed`: read coverage, or start/pause the history embedding drain. */
export async function requestEmbed(
    sessionId: string,
    action: "status" | "start" | "pause",
    directory?: string,
): Promise<CommandRpcResult> {
    return callCommandRpc("embed", {
        sessionId,
        action,
        ...(directory ? { directory } : {}),
    });
}

/** Resolve global toast duration from server config via RPC. */
export async function loadToastDurationMs(): Promise<number> {
    if (!rpcClient) return 5000;
    try {
        const result = await rpcClient.call<{ toastDurationMs?: number }>("toast-duration", {});
        return typeof result.toastDurationMs === "number" ? result.toastDurationMs : 5000;
    } catch {
        return 5000;
    }
}

/**
 * Fetch the current startup announcement from the server, if any.
 * Returns `{show: false}` when there's nothing to announce or when the
 * configured ANNOUNCEMENT_VERSION has already been dismissed.
 */
export interface AnnouncementResponse {
    show: boolean;
    version?: string;
    features?: string[];
    footer?: string;
}

export async function getAnnouncement(): Promise<AnnouncementResponse> {
    if (!rpcClient) return { show: false };
    try {
        const result = await rpcClient.call<{
            show?: boolean;
            version?: string;
            features?: string[];
            footer?: string;
        }>("get-announcement", {});
        return {
            show: result.show === true,
            version: result.version,
            features: Array.isArray(result.features) ? result.features : undefined,
            footer: typeof result.footer === "string" ? result.footer : undefined,
        };
    } catch {
        return { show: false };
    }
}

/** Mark the current ANNOUNCEMENT_VERSION as dismissed on the server. */
export async function markAnnounced(): Promise<boolean> {
    if (!rpcClient) return false;
    try {
        const result = await rpcClient.call<{ ok?: boolean }>("mark-announced", {});
        return result.ok === true;
    } catch {
        return false;
    }
}
