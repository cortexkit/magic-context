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
import { waitForSafeNotificationTarget } from "../shared/safe-notification-target";

const CONFLICT_WARNING_MARKER = "⚠️ Magic Context is disabled due to conflicting configuration:";
const SCHEMA_FENCE_MARKER = "⚠️ Magic Context is disabled — database is newer than this version";
const DCP_COEXISTENCE_MARKER = "✨ Magic Context is running in DCP-coexistence mode";
const ENABLED_MARKER = "✨ Magic Context is now enabled";
const ANNOUNCEMENT_MARKER = "✨ Magic Context — what's new in";

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
                messages?: (input: {
                    path: { id: string };
                    query?: { limit?: number };
                }) => Promise<{ data?: SdkMessage[] }>;
            };
        };

        if (typeof c.session?.messages === "function") {
            // Bounded limit prevents loading the entire session into memory.
            // We only scan the tail for recent conflict warning user messages,
            // which are typically the last 1-3 messages.
            const result = await c.session.messages({
                path: { id: sessionId },
                query: { limit: 50 },
            });
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

    // Never post into a session that hasn't been titled yet — an extra
    // (non-synthetic) user message in a fresh session permanently suppresses
    // OpenCode's title generation (issue #129). Conflict detection re-fires on
    // every startup, so skipping here just retries on the next launch.
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") return;

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
 * Send a DCP-coexistence notice to the active session when running in
 * compaction-off mode due to DCP conflict resolution.
 *
 * Routes through the shared `sendIgnoredMessage` helper instead of posting
 * directly: that helper already shows a TUI toast when a TUI is connected to
 * this session, and only falls back to a persisted (but LLM-`ignored`, so
 * context-free) chat message for Desktop. Posting via raw `session.prompt`
 * here previously always persisted the message, which is why TUI users saw
 * it land in scrollback instead of as a toast.
 */
export async function sendDcpCoexistenceNotice(
    client: unknown,
    directory: string,
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        log("[magic-context] dcp-coexistence-notice: could not find active session for notice");
        return;
    }

    const noticeText = [
        `${DCP_COEXISTENCE_MARKER} (compaction-off).`,
        "",
        "Memory, docs, and ctx_search remain available. The historian and compartments are disabled.",
    ].join("\n");

    log(`[magic-context] sending DCP-coexistence notice to session ${sessionId}`);

    const { sendIgnoredMessage } = await import(
        "../hooks/magic-context/send-session-notification"
    );
    await sendIgnoredMessage(client, sessionId, noticeText, {}).catch((error: unknown) => {
        log(
            `[magic-context] dcp-coexistence-notice: failed to send: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
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

    // Send a brief "enabled" confirmation so the user sees the conflict is resolved.
    // Same title-safety guard as all ignored-message posts (issue #129); the
    // warning cleanup above already ran — only the confirmation is skippable.
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") return;
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
 * Desktop schema-fence warning. When OpenCode and Pi share context.db and one
 * harness auto-updates first, it migrates the DB to a newer schema; the lagging
 * harness then fail-closes and disables ALL of Magic Context. Previously this
 * was log-only, so the user just saw the plugin silently stop working. Surface
 * a clear ignored message telling them what happened and how to fix it. No
 * auto-remove: this is a real blocking state the user must act on (update the
 * lagging harness), unlike the transient TUI-setup notice.
 */
export async function sendSchemaFenceWarning(
    client: unknown,
    directory: string,
    detail: { persistedVersion: number; supportedVersion: number },
): Promise<void> {
    const { sessionId } = getDesktopState(directory);
    if (!sessionId) return;

    // Title-safety guard (issue #129): the fence re-fires on every startup
    // while the version mismatch persists, so a skip retries next launch.
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") return;

    const text = [
        `${SCHEMA_FENCE_MARKER}`,
        "",
        `The shared Magic Context database was upgraded to schema v${detail.persistedVersion} by a`,
        `newer build (OpenCode and Pi share one database). This build only supports`,
        `up to v${detail.supportedVersion}, so it has fail-closed to avoid corrupting the cache.`,
        "",
        "This usually means a pinned or stale plugin is sharing the database with a",
        "newer instance. Update or unpin Magic Context on this harness (or update",
        "OpenCode/Pi) to the latest version, then restart. The fastest fix is:",
        "",
        "  npx @cortexkit/magic-context@latest doctor --force",
        "",
        "Your data is safe; nothing is disabled permanently.",
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
            body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
        };
        if (typeof c.session?.prompt === "function") {
            await Promise.resolve(c.session.prompt(promptInput));
        } else if (typeof c.session?.promptAsync === "function") {
            await c.session.promptAsync(promptInput);
        }
    } catch {
        return;
    }
}

/**
 * Desktop startup announcement: post a one-shot ignored message describing
 * what's new in this release. Mirrors the TUI's RPC-driven dialog path so both
 * surfaces deliver the same announcement once per ANNOUNCEMENT_VERSION.
 *
 * Persistence lives in `getMagicContextStorageDir()/last_announced_version`,
 * shared with the TUI handlers and the Pi plugin so a dismissal in any harness
 * suppresses the others for the same announcement.
 */
export async function sendStartupAnnouncement(
    client: unknown,
    directory: string,
    version: string,
    features: ReadonlyArray<string>,
    footer: string,
    markSeen: (version: string) => void,
): Promise<void> {
    if (!version || features.length === 0) return;

    const { sessionId } = getDesktopState(directory);
    if (!sessionId) {
        // No active Desktop session — TUI will pick it up next time it loads.
        // The persistence file is the same across surfaces, so this is correct.
        return;
    }

    // TUI owns its own announcement surface: the TUI plugin shows a DialogAlert
    // via the get-announcement / mark-announced RPC. This server-side path is the
    // Desktop/Web fallback ONLY. Without this gate both fire for a TUI session —
    // the ignored message lands in the scrollback AND stamps last_announced_version,
    // which then suppresses (or races) the dialog. Every other notification routes
    // through sendIgnoredMessage (which checks isTuiConnected); this one bypassed
    // that helper, so gate it explicitly here.
    //
    // Check the target session first (precise), then fall back to "any TUI
    // connected": the announcement is a global once-per-version event with a
    // shared dismissal stamp, so if ANY TUI is polling it will show the dialog —
    // and the getDesktopState sessionId can differ from the TUI's polled session,
    // which a per-session-only check would miss (the reported bug).
    const { isTuiConnected } = await import("../shared/rpc-notifications");
    if (isTuiConnected(sessionId) || isTuiConnected()) return;

    // Title-safety guard (issue #129): markSeen only runs after successful
    // delivery below, so skipping here re-attempts on the next startup.
    if ((await waitForSafeNotificationTarget(client, sessionId)) === "skip") return;

    // NOTE: OpenCode Desktop renders user messages through HighlightedText
    // (packages/ui/src/components/message-part.tsx ~L1184), which is plain
    // <span> text — not Markdown, no URL auto-linking. So `[url](url)` would
    // show as literal text, and bare URLs don't get linkified either. We
    // leave URLs as plain text so the user can copy them; clickable rendering
    // requires upstream OpenCode to add URL detection to HighlightedText.
    const bullets = features.map((line) => `  • ${line}`).join("\n");
    const sections = [`${ANNOUNCEMENT_MARKER} v${version}:`, "", bullets];
    if (footer && footer.trim().length > 0) {
        // Blank-line separator distinguishes the persistent footer (Discord
        // invite, etc.) from the version-specific bullets.
        sections.push("", footer);
    }
    const text = sections.join("\n");

    log(`[magic-context] sending startup announcement for v${version} to session ${sessionId}`);

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
        } else {
            log("[magic-context] announcement: session prompt API unavailable");
            return;
        }
    } catch (error: unknown) {
        log(
            `[magic-context] announcement: failed to send: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }

    // Persist the dismissal AFTER successful delivery so we never silently
    // suppress an announcement that the user never saw due to a transient
    // delivery error.
    markSeen(version);
}
