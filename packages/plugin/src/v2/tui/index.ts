import { jsx } from "@opentui/solid/jsx-runtime";
import { COMPACTION_ENABLED_PATH } from "../../config/agent-disable";
import type { SidebarSnapshot, StatusDetail } from "../../shared/rpc-types";
import { compactionOffSidebarRows, nativeCompactionContextLabel } from "../../tui/compaction-off";
import {
    closeRpc,
    getCompartmentCount,
    initRpcClient,
    loadSidebarSnapshot,
    loadStatusDetail,
    requestDream,
    requestRecomp,
} from "../../tui/data/context-db";
import {
    type SocketNotification,
    startNotificationSocket,
    stopNotificationSocket,
} from "../../tui/data/notification-socket";
import type { V2KeymapLayer, V2SidebarState, V2TuiContext } from "./types";

const SIDEBAR_REFRESH_MS = 1_000;
const inflight = new Set<string>();
const refreshedAt = new Map<string, number>();

function compactTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return String(value);
}

/** Exported for test access; mirrors the v1 sidebar's compaction-off rows. */
export function sidebarText(snapshot: SidebarSnapshot | undefined): string {
    if (!snapshot) return "Magic Context · loading…";
    if (snapshot.compaction_enabled === false) {
        return [
            "Magic Context",
            nativeCompactionContextLabel(snapshot),
            ...compactionOffSidebarRows(snapshot).map((row) => `${row.label} ${row.value}`),
            ...(snapshot.readySmartNoteCount > 0
                ? [`Smart Notes ${snapshot.readySmartNoteCount} ready`]
                : []),
            ...(snapshot.lastTransformError ? [`Warning: ${snapshot.lastTransformError}`] : []),
        ].join("\n");
    }
    const pressure =
        snapshot.contextLimit > 0
            ? `${snapshot.usagePercentage.toFixed(1)}% · ${compactTokens(snapshot.inputTokens)}/${compactTokens(snapshot.contextLimit)}`
            : `${compactTokens(snapshot.inputTokens)} tokens`;
    const historian = snapshot.historianRunning ? "running" : "idle";
    return [
        "Magic Context",
        `Context ${pressure}`,
        `Historian ${historian} · C:${snapshot.compartmentCount}`,
        `Memories ${snapshot.memoryBlockCount}/${snapshot.memoryCount} · Q:${snapshot.pendingOpsCount}`,
        ...(snapshot.lastTransformError ? [`Warning: ${snapshot.lastTransformError}`] : []),
    ].join("\n");
}

/** Exported for test access. */
export function statusText(detail: StatusDetail): string {
    const context =
        detail.contextLimit > 0
            ? `${detail.usagePercentage.toFixed(1)}% (${compactTokens(detail.inputTokens)}/${compactTokens(detail.contextLimit)} tokens)`
            : `${compactTokens(detail.inputTokens)} tokens`;
    return [
        ...(detail.compaction_enabled === false
            ? [
                  `Compaction: disabled (${COMPACTION_ENABLED_PATH}: false) — native compaction owns the context window.`,
              ]
            : []),
        `Context: ${context}`,
        `Historian: ${detail.historianRunning ? "running" : "idle"}`,
        `Compartments: ${detail.compartmentCount}`,
        `Memories: ${detail.memoryBlockCount} injected / ${detail.memoryCount} stored`,
        `Pending reductions: ${detail.pendingOpsCount}`,
        `Harness: opencode2`,
        ...(detail.lastTransformError ? [`Warning: ${detail.lastTransformError}`] : []),
    ].join("\n");
}

function currentSessionID(context: V2TuiContext): string | null {
    const route = context.ui.router.current();
    return route.type === "session" && route.sessionID ? route.sessionID : null;
}

function eventSessionID(event: unknown): string | undefined {
    if (typeof event !== "object" || event === null) return undefined;
    const record = event as Record<string, unknown>;
    const data =
        typeof record.data === "object" && record.data !== null
            ? (record.data as Record<string, unknown>)
            : record;
    for (const key of ["sessionID", "sessionId", "id"]) {
        if (typeof data[key] === "string") return data[key];
    }
    const info = data.info;
    if (typeof info === "object" && info !== null) {
        const nested = info as Record<string, unknown>;
        if (typeof nested.sessionID === "string") return nested.sessionID;
        if (typeof nested.id === "string") return nested.id;
    }
    return undefined;
}

type JsxFactory = (type: string, props: Record<string, unknown>) => unknown;

export async function setupWithJsx(context: V2TuiContext, jsx: JsxFactory): Promise<() => void> {
    const directory = context.location?.directory ?? context.data.location.default().directory;
    initRpcClient(directory);
    const [sidebar, updateSidebar] = context.storage.memory<V2SidebarState>(
        "magic-context.sidebar.v2",
        { initial: { snapshots: {} } },
    );

    const refresh = async (sessionID: string, force = false): Promise<void> => {
        if (!sessionID || inflight.has(sessionID)) return;
        const now = Date.now();
        if (!force && now - (refreshedAt.get(sessionID) ?? 0) < SIDEBAR_REFRESH_MS) return;
        refreshedAt.set(sessionID, now);
        inflight.add(sessionID);
        try {
            const snapshot = await loadSidebarSnapshot(sessionID, directory);
            updateSidebar((draft) => {
                draft.snapshots[sessionID] = snapshot;
            });
            context.renderer.requestRender();
        } finally {
            inflight.delete(sessionID);
        }
    };

    const showStatus = async (diagnostics = false, target = currentSessionID(context)) => {
        if (!target) {
            context.ui.toast.show({ message: "No active session", variant: "warning" });
            return false;
        }
        const result = await loadStatusDetail(target, directory);
        if (currentSessionID(context) !== target) return false;
        if (!result.ok) {
            context.ui.toast.show({
                message: "Magic Context status is unavailable",
                variant: "warning",
            });
            return false;
        }
        await context.ui.dialog.alert({
            title: diagnostics ? "Magic Context diagnostics" : "Magic Context status",
            message: statusText(result.detail),
        });
        return true;
    };

    const showRecomp = async (target = currentSessionID(context)) => {
        if (!target) {
            context.ui.toast.show({ message: "No active session", variant: "warning" });
            return false;
        }
        const count = await getCompartmentCount(target, directory);
        if (currentSessionID(context) !== target) return false;
        if (!count.ok) {
            context.ui.toast.show({ message: "Unable to load recomp details", variant: "error" });
            return false;
        }
        const confirmed = await context.ui.dialog.confirm({
            title: "Recomp confirmation",
            message: [
                count.count === 0
                    ? "This session has no compartments yet; recomp will build them from raw history."
                    : `This session has ${count.count} compartments.`,
                "Recomp rebuilds compressed history and can consume significant tokens.",
            ].join("\n\n"),
            label: { confirm: "Run recomp", cancel: "Cancel" },
        });
        if (!confirmed) return true;
        const requested = await requestRecomp(target);
        context.ui.toast.show({
            message: requested
                ? "Recomp requested; historian will start shortly"
                : "Recomp request failed",
            variant: requested ? "info" : "error",
        });
        if (requested) void refresh(target, true);
        return requested;
    };

    const showDream = async (task?: string) => {
        const target = currentSessionID(context);
        if (!target) {
            context.ui.toast.show({ message: "No active session", variant: "warning" });
            return false;
        }
        const started = await requestDream(target, task);
        context.ui.toast.show({
            message: started
                ? "Dream run started; the summary appears when it finishes"
                : "Dream request failed",
            variant: started ? "info" : "error",
        });
        return started;
    };

    const unregisterSlot = context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => {
            void refresh(sessionID);
            return jsx("text", { children: sidebarText(sidebar.snapshots[sessionID]) });
        },
    });

    // The keymap layer owns /ctx-status + /ctx-recomp + /ctx-dream. OpenCode 2
    // runs plugin setup() outside the TUI component tree, where
    // context.keymap.layer() throws "Keymap.Provider is missing" (the provider is
    // a Solid context). Try the direct call first (hosts that do run setup
    // in-tree), then fall back to the app slot: its render executes inside the
    // component tree, the same place the host's own built-in plugins register
    // their layers.
    const buildKeymapLayer = (): V2KeymapLayer => ({
        mode: "global",
        commands: [
            {
                id: "magic-context.status",
                title: "Magic Context: Status",
                group: "Magic Context",
                palette: true,
                slash: { name: "ctx-status", arguments: true },
                run: async (input) => {
                    await showStatus(input?.trim().toLowerCase() === "diagnostics");
                },
            },
            {
                id: "magic-context.recomp",
                title: "Magic Context: Recomp",
                group: "Magic Context",
                palette: true,
                slash: { name: "ctx-recomp" },
                run: async () => {
                    await showRecomp();
                },
            },
            {
                id: "magic-context.dream",
                title: "Magic Context: Dream",
                group: "Magic Context",
                palette: true,
                slash: { name: "ctx-dream", arguments: true },
                run: async (input) => {
                    await showDream(input?.trim() || undefined);
                },
            },
        ],
    });
    let keymapLayerRegistered = false;
    let keymapGapLogged = false;
    const registerKeymapLayer = (): boolean => {
        if (keymapLayerRegistered) return true;
        try {
            context.keymap.layer(buildKeymapLayer);
            keymapLayerRegistered = true;
            return true;
        } catch (error) {
            if (!(error instanceof Error) || error.message !== "Keymap.Provider is missing")
                throw error;
            return false;
        }
    };
    let unregisterKeymapSlot: (() => void) | undefined;
    if (!registerKeymapLayer()) {
        unregisterKeymapSlot = context.ui.slot({
            append: "app",
            render: () => {
                let registered = false;
                try {
                    registered = registerKeymapLayer();
                } catch (error) {
                    console.warn("[magic-context] keymap.layer registration failed", error);
                }
                if (!registered && !keymapGapLogged) {
                    keymapGapLogged = true;
                    console.warn(
                        "[magic-context] OpenCode 2 keymap.layer is unavailable; /ctx-status, /ctx-recomp and /ctx-dream were not registered",
                    );
                }
                return null;
            },
        });
    }

    const stopListening = context.data.listen(({ details }) => {
        const sessionID = eventSessionID(details);
        if (sessionID) void refresh(sessionID, true);
    });

    const handleNotification = async (notification: SocketNotification): Promise<boolean> => {
        const target = notification.sessionId ?? currentSessionID(context);
        if (notification.sessionId && notification.sessionId !== currentSessionID(context))
            return false;
        if (notification.type === "toast") {
            const payload = notification.payload;
            context.ui.toast.show({
                title: typeof payload.title === "string" ? payload.title : undefined,
                message: String(payload.message ?? ""),
                variant:
                    payload.variant === "success" ||
                    payload.variant === "warning" ||
                    payload.variant === "error"
                        ? payload.variant
                        : "info",
                duration: typeof payload.duration === "number" ? payload.duration : undefined,
            });
            return true;
        }
        if (notification.type !== "action") return false;
        if (notification.payload.action === "show-status-dialog") {
            return showStatus(notification.payload.diagnostics === true, target);
        }
        if (notification.payload.action === "show-recomp-dialog") return showRecomp(target);
        if (notification.payload.action === "refresh-sidebar" && target) {
            await refresh(target, true);
            return true;
        }
        if (notification.payload.action === "show-result-dialog") {
            await context.ui.dialog.alert({
                title: String(notification.payload.title ?? "Magic Context"),
                message: String(notification.payload.message ?? ""),
            });
            return true;
        }
        return false;
    };

    startNotificationSocket({
        getSessionId: () => currentSessionID(context),
        onNotification: handleNotification,
    });
    console.info("[magic-context] @cortexkit/opencode-magic-context v2 TUI setup");

    return () => {
        unregisterSlot();
        unregisterKeymapSlot?.();
        stopListening();
        stopNotificationSocket();
        closeRpc();
        inflight.clear();
        refreshedAt.clear();
    };
}

export async function setup(context: V2TuiContext): Promise<() => void> {
    return setupWithJsx(context, jsx);
}

export default { id: "opencode-magic-context", setup };
