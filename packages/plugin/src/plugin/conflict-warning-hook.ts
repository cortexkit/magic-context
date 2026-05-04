/**
 * Conflict warning for Desktop mode when magic-context is disabled.
 *
 * - When conflicts detected: reads Desktop app state → finds active session → sends ignored warning
 * - When no conflicts: cleans up any leftover warning messages from previous runs
 *
 * TUI handles this via a startup dialog — this covers Desktop only.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ConflictResult } from "../shared/conflict-detector";
import { formatConflictShort } from "../shared/conflict-detector";
import { log } from "../shared/logger";

const CONFLICT_WARNING_MARKER = "⚠️ Magic Context is disabled due to conflicting configuration:";
const ENABLED_MARKER = "✨ Magic Context is now enabled";
const TUI_SETUP_MARKER = "📊 Magic Context sidebar configured";

// --- Desktop state file resolution ---

function getDesktopStatePath(): string | null {
    const os = platform();
    const home = homedir();

    if (os === "darwin") {
        return join(
            home,
            "Library",
            "Application Support",
            "ai.opencode.desktop",
            "opencode.global.dat",
        );
    }
    if (os === "linux") {
        const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
        return join(xdgConfig, "ai.opencode.desktop", "opencode.global.dat");
    }
    if (os === "win32") {
        const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
        return join(appData, "ai.opencode.desktop", "opencode.global.dat");
    }

    return null;
}

interface DesktopState {
    sessionId: string | null;
    sidecarUrl: string | null;
}

function readDesktopState(directory: string): DesktopState {
    const statePath = getDesktopStatePath();
    if (!statePath || !existsSync(statePath)) {
        log(`[magic-context] conflict-warning: Desktop state file not found at ${statePath}`);
        return { sessionId: null, sidecarUrl: null };
    }

    try {
        const raw = readFileSync(statePath, "utf-8");
        const state = JSON.parse(raw) as Record<string, unknown>;

        // Extract sidecar URL from server state
        let sidecarUrl: string | null = null;
        const serverStr = state.server;
        if (typeof serverStr === "string") {
            try {
                const serverState = JSON.parse(serverStr) as Record<string, unknown>;
                if (typeof serverState.currentSidecarUrl === "string") {
                    sidecarUrl = serverState.currentSidecarUrl;
                }
            } catch {
                // ignore parse error
            }
        }

        // Extract last session for directory
        let sessionId: string | null = null;
        const layoutPage = state["layout.page"];
        if (typeof layoutPage === "string") {
            const parsed = JSON.parse(layoutPage) as Record<string, unknown>;
            const lastProjectSession = parsed.lastProjectSession as
                | Record<string, { id?: string }>
                | undefined;
            if (lastProjectSession) {
                const entry = lastProjectSession[directory];
                sessionId = entry?.id ?? null;
            }
        }

        return { sessionId, sidecarUrl };
    } catch (error) {
        log(
            `[magic-context] conflict-warning: failed to read Desktop state: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { sessionId: null, sidecarUrl: null };
    }
}

// Cache per directory so each project gets its own lookup
const cachedDesktopStateByDir = new Map<string, DesktopState>();

function getDesktopState(directory: string): DesktopState {
    let cached = cachedDesktopStateByDir.get(directory);
    if (!cached) {
        cached = readDesktopState(directory);
        cachedDesktopStateByDir.set(directory, cached);
    }
    return cached;
}

// --- SDK-based message deletion ---

async function deleteMessage(
    serverUrl: string,
    sessionId: string,
    messageId: string,
): Promise<boolean> {
    // OpenCode's Session2 wrapper doesn't expose deleteMessage.
    // Use raw HTTP to the actual server URL from ctx.serverUrl.
    const auth = getServerAuth();
    const url = `${serverUrl}/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`;

    try {
        const response = await fetch(url, {
            method: "DELETE",
            headers: auth ? { Authorization: auth } : {},
            signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
            log(
                `[magic-context] conflict-warning: DELETE failed status=${response.status} url=${url}`,
            );
            return false;
        }
        return true;
    } catch (error) {
        log(
            `[magic-context] conflict-warning: DELETE error (url=${serverUrl}): ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
}

function getServerAuth(): string | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) return undefined;
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

// --- Read session messages via SDK ---

type SdkMessage = {
    info?: { id?: string; role?: string; sessionID?: string };
    parts?: Array<{ type?: string; text?: string; ignored?: boolean }>;
};

async function getSessionMessages(client: unknown, sessionId: string): Promise<SdkMessage[]> {
    try {
        const c = client as {
            session?: {
                messages?: (input: { path: { id: string } }) => Promise<{ data?: SdkMessage[] }>;
            };
        };

        if (typeof c.session?.messages === "function") {
            const result = await c.session.messages({ path: { id: sessionId } });
            return result?.data ?? [];
        }
    } catch (error) {
        log(
            `[magic-context] conflict-warning: failed to read messages: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return [];
}

// --- Public API ---

/**
 * Send an ignored notification to the active Desktop session at plugin startup.
 */
export async function sendConflictWarning(
    client: unknown,
    directory: string,
    conflictResult: ConflictResult,
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        log("[magic-context] conflict-warning: could not find active session for Desktop warning");
        return;
    }

    const warningText = formatConflictShort(conflictResult);

    log(
        `[magic-context] sending conflict warning to session ${sessionId}: ${conflictResult.reasons.join(", ")}`,
    );

    try {
        const c = client as {
            session?: {
                prompt?: (input: unknown) => unknown;
                promptAsync?: (input: unknown) => unknown;
            };
        };

        const promptInput = {
            path: { id: sessionId },
            body: {
                noReply: true,
                parts: [
                    {
                        type: "text",
                        text: warningText,
                        ignored: true,
                    },
                ],
            },
        };

        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(promptInput));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(promptInput);
        } else {
            log("[magic-context] conflict-warning: session prompt API unavailable");
        }
    } catch (error: unknown) {
        log(
            `[magic-context] conflict-warning: failed to send: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * Clean up leftover conflict warning messages from previous disabled runs.
 * Called at startup when no conflicts exist (plugin is enabled normally).
 */
export async function cleanupConflictWarnings(
    client: unknown,
    directory: string,
    serverUrl?: string,
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        log("[magic-context] cleanup: no active Desktop session found");
        return;
    }
    const messages = await getSessionMessages(client, sessionId);
    if (messages.length === 0) return;

    // Scan from the end for consecutive conflict warning messages
    const warningMessageIds: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const msgId = msg.info?.id;
        const msgRole = msg.info?.role;
        if (!msgId || msgRole !== "user") break;

        const parts = msg.parts ?? [];
        const isWarning =
            parts.length > 0 &&
            parts.every(
                (p) =>
                    p.ignored === true &&
                    p.type === "text" &&
                    typeof p.text === "string" &&
                    p.text.startsWith(CONFLICT_WARNING_MARKER),
            );

        if (isWarning) {
            warningMessageIds.push(msgId);
        } else {
            break; // Stop at the first non-warning message from the tail
        }
    }

    if (warningMessageIds.length === 0) {
        // Also clean up any stale "enabled" messages from previous cleanup runs
        await cleanupEnabledMessages(messages, serverUrl, sessionId);
        return;
    }

    if (!serverUrl) {
        log("[magic-context] cleanup: no serverUrl provided, cannot delete messages");
        return;
    }

    log(
        `[magic-context] cleaning up ${warningMessageIds.length} conflict warning message(s) from session ${sessionId}`,
    );

    for (const messageId of warningMessageIds) {
        const ok = await deleteMessage(serverUrl, sessionId, messageId);
        if (ok) {
            log(`[magic-context] deleted conflict warning message ${messageId}`);
        }
    }

    // Send a brief "enabled" confirmation so the user sees the conflict is resolved
    const enabledText = `${ENABLED_MARKER}. Enjoy! ✨`;
    try {
        const c = client as {
            session?: {
                prompt?: (input: unknown) => unknown;
                promptAsync?: (input: unknown) => unknown;
            };
        };

        const promptInput = {
            path: { id: sessionId },
            body: {
                noReply: true,
                parts: [{ type: "text", text: enabledText, ignored: true }],
            },
        };

        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(promptInput));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(promptInput);
        }
    } catch {
        // Best-effort — don't log noise if this fails
    }

    // Auto-remove the "enabled" message after 1 second so it doesn't persist across restarts.
    // We identify it by the ENABLED_MARKER + ignored flag to avoid deleting real user messages.
    setTimeout(async () => {
        try {
            const freshMessages = await getSessionMessages(client, sessionId);
            // Scan from end for our specific enabled marker
            for (let i = freshMessages.length - 1; i >= 0; i--) {
                const msg = freshMessages[i];
                const msgId = msg.info?.id;
                const msgRole = msg.info?.role;
                if (!msgId || msgRole !== "user") break;

                const parts = msg.parts ?? [];
                const isEnabled =
                    parts.length > 0 &&
                    parts.every(
                        (p) =>
                            p.ignored === true &&
                            p.type === "text" &&
                            typeof p.text === "string" &&
                            p.text.startsWith(ENABLED_MARKER),
                    );

                if (isEnabled) {
                    await deleteMessage(serverUrl, sessionId, msgId);
                } else {
                    break;
                }
            }
        } catch {
            // Best-effort cleanup
        }
    }, 1000);
}

/** Remove any leftover "enabled" messages that survived from a previous cleanup run */
async function cleanupEnabledMessages(
    messages: SdkMessage[],
    serverUrl: string | undefined,
    sessionId: string,
): Promise<void> {
    if (!serverUrl) return;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const msgId = msg.info?.id;
        const msgRole = msg.info?.role;
        if (!msgId || msgRole !== "user") break;

        const parts = msg.parts ?? [];
        const isEnabled =
            parts.length > 0 &&
            parts.every(
                (p) =>
                    p.ignored === true &&
                    p.type === "text" &&
                    typeof p.text === "string" &&
                    p.text.startsWith(ENABLED_MARKER),
            );

        if (isEnabled) {
            await deleteMessage(serverUrl, sessionId, msgId);
        } else {
            break;
        }
    }
}

/**
 * Notify the user that tui.json was configured with the sidebar plugin.
 * Sends an ignored message that auto-deletes after 1 second.
 */
export async function sendTuiSetupNotification(
    client: unknown,
    directory: string,
    serverUrl?: string,
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) return;

    const text = [
        `${TUI_SETUP_MARKER}`,
        "",
        "Magic Context added its TUI plugin to your tui.json.",
        "Restart OpenCode to see the sidebar with live context breakdown,",
        "token usage, historian status, memory counts, and more.",
    ].join("\n");

    try {
        const c = client as {
            session?: {
                prompt?: (input: unknown) => unknown;
                promptAsync?: (input: unknown) => unknown;
            };
        };

        const promptInput = {
            path: { id: sessionId },
            body: {
                noReply: true,
                parts: [{ type: "text", text, ignored: true }],
            },
        };

        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(promptInput));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(promptInput);
        }
    } catch {
        return;
    }

    // Auto-remove after 1 second — user only needs to see it once
    if (!serverUrl) return;
    setTimeout(async () => {
        try {
            const msgs = await getSessionMessages(client, sessionId);
            for (let i = msgs.length - 1; i >= 0; i--) {
                const msg = msgs[i];
                const msgId = msg.info?.id;
                if (!msgId || msg.info?.role !== "user") break;
                const parts = msg.parts ?? [];
                const isTuiSetup =
                    parts.length > 0 &&
                    parts.every(
                        (p) =>
                            p.ignored === true &&
                            p.type === "text" &&
                            typeof p.text === "string" &&
                            p.text.startsWith(TUI_SETUP_MARKER),
                    );
                if (isTuiSetup) {
                    await deleteMessage(serverUrl, sessionId, msgId);
                } else {
                    break;
                }
            }
        } catch {
            // best-effort
        }
    }, 1000);
}
