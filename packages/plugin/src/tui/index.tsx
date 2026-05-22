/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createMemo } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createSidebarContentSlot, kickRecompProgressRefresh } from "./slots/sidebar-content"
import packageJson from "../../package.json"
import { closeRpc, consumeTuiMessages, dismissUpgradeReminder, getAnnouncement, getCompartmentCount, getRpcGeneration, initRpcClient, loadEmbedDetail, loadStatusDetail, loadToastDurationMs, markAnnounced, markTuiMessagesHandled, requestRecomp, requestUpgrade, type EmbedDetail, type TuiMessage, type StatusDetail } from "./data/context-db"
import { formatThresholdPercent } from "../shared/format-threshold"
import { detectConflicts } from "../shared/conflict-detector"
import { fixConflicts } from "../shared/conflict-fixer"
import { readJsoncFile } from "../shared/jsonc-parser"
import { getOpenCodeConfigPaths } from "../shared/opencode-config-dir"

const PLUGIN_NAME = "@cortexkit/opencode-magic-context"
const DEFAULT_TOAST_DURATION_MS = 5000
let unifiedToastDurationMs = DEFAULT_TOAST_DURATION_MS

async function refreshToastDurationMs(): Promise<void> {
    try {
        const resolved = await loadToastDurationMs()
        if (typeof resolved === "number" && Number.isFinite(resolved)) {
            unifiedToastDurationMs = resolved
        }
    } catch {
        // Keep the current value; the next poll/startup can retry.
    }
}

function getToastDurationMs(): number {
    return unifiedToastDurationMs
}

function showToast(
    api: TuiPluginApi,
    input: {
        message: string
        variant: "info" | "warning" | "error" | "success"
        durationOverrideMs?: number
    },
): void {
    const duration =
        typeof input.durationOverrideMs === "number" && Number.isFinite(input.durationOverrideMs)
            ? input.durationOverrideMs
            : getToastDurationMs()
    api.ui.toast({
        message: input.message,
        variant: input.variant,
        duration,
    })
}

function ensureParentDir(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
}

function resolveTuiConfigPath() {
    const configDir = getOpenCodeConfigPaths({ binary: "opencode" }).configDir
    const jsoncPath = join(configDir, "tui.jsonc")
    const jsonPath = join(configDir, "tui.json")

    if (existsSync(jsoncPath)) {
        return jsoncPath
    }

    if (existsSync(jsonPath)) {
        return jsonPath
    }

    return jsonPath
}

function readTuiConfig(filePath: string): Record<string, unknown> | null {
    if (!existsSync(filePath)) {
        return {}
    }

    return readJsoncFile<Record<string, unknown>>(filePath)
}

function hasMagicContextTuiPlugin(): boolean {
    const configPath = resolveTuiConfigPath()
    const config = readTuiConfig(configPath)
    if (!config) {
        return false
    }

    const plugins = Array.isArray(config.plugin)
        ? config.plugin.filter((plugin): plugin is string => typeof plugin === "string")
        : []

    return plugins.some((plugin) => plugin === PLUGIN_NAME || plugin.startsWith(`${PLUGIN_NAME}@`))
}

function addMagicContextTuiPlugin(): { ok: boolean; updated: boolean } {
    const configPath = resolveTuiConfigPath()
    const config = readTuiConfig(configPath)
    if (!config) {
        return { ok: false, updated: false }
    }

    const plugins = Array.isArray(config.plugin)
        ? config.plugin.filter((plugin): plugin is string => typeof plugin === "string")
        : []

    if (plugins.some((plugin) => plugin === PLUGIN_NAME || plugin.startsWith(`${PLUGIN_NAME}@`))) {
        return { ok: true, updated: false }
    }

    plugins.push(PLUGIN_NAME)
    config.plugin = plugins

    ensureParentDir(configPath)
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    return { ok: true, updated: true }
}

function showConflictDialog(api: TuiPluginApi, directory: string, reasons: string[], conflicts: ReturnType<typeof detectConflicts>["conflicts"]) {
    api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
            title="⚠️ Magic Context Disabled"
            message={`${reasons.join("\n")}\n\nFix these conflicts automatically?`}
            onConfirm={() => {
                const actions = fixConflicts(directory, conflicts)
                const actionSummary = actions.length > 0
                    ? actions.map(a => `• ${a}`).join("\n")
                    : "No changes needed"
                // DialogConfirm calls dialog.clear() after onConfirm, so defer the next dialog
                setTimeout(() => {
                    api.ui.dialog.replace(() => (
                        <api.ui.DialogAlert
                            title="✅ Configuration Fixed"
                            message={`${actionSummary}\n\nPlease restart OpenCode for changes to take effect.`}
                            onConfirm={() => {
                                showToast(api, {
                                    message: "Restart OpenCode to enable Magic Context",
                                    variant: "warning",
                                    durationOverrideMs: 10_000,
                                })
                            }}
                        />
                    ))
                }, 50)
            }}
            onCancel={() => {
                showToast(api, { message: "Magic Context remains disabled. Run: npx @cortexkit/opencode-magic-context@latest doctor", variant: "warning" })
            }}
        />
    ))
}

function showTuiSetupDialog(api: TuiPluginApi) {
    api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
            title="✨ Enable Magic Context Sidebar"
            message={[
                "Magic Context can show a sidebar with live context breakdown,",
                "token usage, historian status, memory counts, and dreamer info.",
                "",
                "This requires adding the plugin to your tui.json config",
                "(OpenCode's TUI plugin configuration file).",
                "",
                "Add it now?",
            ].join("\n")}
            onConfirm={() => {
                const result = addMagicContextTuiPlugin()
                if (!result.ok) {
                    setTimeout(() => {
                        api.ui.dialog.replace(() => (
                            <api.ui.DialogAlert
                                title="❌ Setup Failed"
                                message={'Could not update tui.json automatically. Add the plugin manually:\n\n  { "plugin": ["@cortexkit/opencode-magic-context"] }'}
                                onConfirm={() => {
                                    showToast(api, { message: "Add plugin to tui.json manually", variant: "warning" })
                                }}
                            />
                        ))
                    }, 50)
                    return
                }

                setTimeout(() => {
                    api.ui.dialog.replace(() => (
                        <api.ui.DialogAlert
                            title="✅ Sidebar Enabled"
                            message="tui.json updated with Magic Context plugin.\n\nPlease restart OpenCode to see the sidebar."
                            onConfirm={() => {
                                showToast(api, {
                                    message: "Restart OpenCode to see the sidebar",
                                    variant: "warning",
                                    durationOverrideMs: 10_000,
                                })
                            }}
                        />
                    ))
                }, 50)
            }}
            onCancel={() => {
                showToast(api, { message: "You can add the sidebar later via: npx @cortexkit/opencode-magic-context@latest doctor", variant: "info" })
            }}
        />
    ))
}

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`
    return String(n)
}

function fmtBytes(n: number): string {
    if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
    if (n >= 1_024) return `${Math.round(n / 1_024)} KB`
    return `${n} B`
}

function relTime(ms: number): string {
    const d = Date.now() - ms
    if (d < 60_000) return "just now"
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
    return `${Math.floor(d / 86_400_000)}d ago`
}

function getSessionId(api: TuiPluginApi): string | null {
    try {
        const route = api.route.current
        if (route?.name === "session" && route.params?.sessionID) {
            return route.params.sessionID
        }
    } catch {
        // ignore
    }
    return null
}

const R = (props: { t: TuiThemeCurrent; l: string; v: string; fg?: string }) => (
    <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={props.t.textMuted}>{props.l}</text>
        <text fg={props.fg ?? props.t.text}>{props.v}</text>
    </box>
)

const StatusDialog = (props: { api: TuiPluginApi; s: StatusDetail }) => {
    const theme = createMemo(() => (props.api as any).theme.current)
    const t = () => theme()
    const s = () => props.s

    // Prefer the RPC-provided model context limit (what the sidebar shows) so the
    // two surfaces never disagree. Fall back to deriving from usage% only when the
    // RPC limit is absent (0) — and that derivation is itself undefined at 0%, so
    // it stays "?" rather than showing a number inconsistent with the sidebar.
    const contextLimit = () =>
        s().contextLimit > 0
            ? s().contextLimit
            : s().usagePercentage > 0
              ? Math.round(s().inputTokens / (s().usagePercentage / 100))
              : 0

    const elapsed = () => (s().lastResponseTime > 0 ? Date.now() - s().lastResponseTime : 0)

    // Token breakdown segments — same colors as sidebar. Kept in sync with
    // slots/sidebar-content.tsx so the status dialog and sidebar read identically.
    const COLORS = {
        // Cool / structured — injected by the plugin into message[0]
        system: "#c084fc",
        docs: "#22d3ee",
        compartments: "#60a5fa",
        facts: "#fbbf24",
        memories: "#34d399",
        profile: "#a3e635",
        // Warm / user-facing — chat and tool traffic
        conversation: "#f87171",
        toolCalls: "#fb923c",
        toolDefs: "#f472b6",
    }

    const breakdownSegments = () => {
        const d = s()
        const total = d.inputTokens || 1
        const segs: Array<{ label: string; tokens: number; color: string; detail?: string }> = []

        if (d.systemPromptTokens > 0)
            segs.push({ label: "System", tokens: d.systemPromptTokens, color: COLORS.system })
        if (d.docsTokens > 0)
            segs.push({ label: "Docs", tokens: d.docsTokens, color: COLORS.docs })
        if (d.compartmentTokens > 0)
            segs.push({
                label: "Compartments",
                tokens: d.compartmentTokens,
                color: COLORS.compartments,
                detail: `(${d.compartmentCount})`,
            })
        if (d.factTokens > 0)
            segs.push({
                label: "Facts",
                tokens: d.factTokens,
                color: COLORS.facts,
                detail: `(${d.factCount})`,
            })
        if (d.memoryTokens > 0)
            segs.push({
                label: "Memories",
                tokens: d.memoryTokens,
                color: COLORS.memories,
                detail: `(${d.memoryBlockCount})`,
            })
        if (d.profileTokens > 0)
            segs.push({ label: "User Profile", tokens: d.profileTokens, color: COLORS.profile })

        if (d.conversationTokens > 0)
            segs.push({ label: "Conversation", tokens: d.conversationTokens, color: COLORS.conversation })
        if (d.toolCallTokens > 0)
            segs.push({ label: "Tool Calls", tokens: d.toolCallTokens, color: COLORS.toolCalls })
        if (d.toolDefinitionTokens > 0)
            segs.push({ label: "Tool Defs", tokens: d.toolDefinitionTokens, color: COLORS.toolDefs })

        return { segs, total }
    }

    // The status-dialog breakdown bar uses flex layout (same approach as the
    // sidebar breakdown). Each segment becomes a colored box with
    // flexGrow=tokens and flexBasis=0, parent has width="100%", so opentui
    // distributes the dialog's full width proportionally regardless of the
    // dialog's actual rendered width.
    const barSegments = () => breakdownSegments().segs.filter((seg) => seg.tokens > 0)

    return (
        <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            {/* Title */}
            <box justifyContent="center" width="100%" marginBottom={1} flexDirection="row" gap={2}>
                <text fg={t().accent}><b>⚡ Magic Context Status</b></text>
                <text fg={t().textMuted}>v{packageJson.version}</text>
            </box>

            {/* Context summary line. Mirrors the sidebar header layout
                ("47.5% / 65%   475K / 1.0M") so users can recognize the
                same shape in the status dialog. The execute threshold tells
                them how close they are to compaction triggering. */}
            <box flexDirection="row" justifyContent="space-between" width="100%">
                <text fg={s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent}>
                    <b>{s().usagePercentage.toFixed(1)}%</b> / {formatThresholdPercent(s().executeThreshold)}%
                </text>
                <text fg={s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent}>
                    {fmt(s().inputTokens)} / {contextLimit() > 0 ? fmt(contextLimit()) : "?"} tokens
                </text>
            </box>

            {/* Segmented breakdown bar: flex row of colored boxes filling
                the dialog width. See barSegments comment above. */}
            <box width="100%" flexDirection="row" height={1}>
                {barSegments().map((seg) => (
                    <box
                        key={seg.label}
                        flexGrow={Math.max(1, seg.tokens)}
                        flexBasis={0}
                        height={1}
                        backgroundColor={seg.color}
                    />
                ))}
            </box>

            {/* Breakdown legend */}
            <box flexDirection="column">
                {breakdownSegments().segs.map((seg) => {
                    const pct = ((seg.tokens / breakdownSegments().total) * 100).toFixed(1)
                    return (
                        <box key={seg.label} width="100%" flexDirection="row" justifyContent="space-between">
                            <text fg={seg.color}>{seg.label} {seg.detail ?? ""}</text>
                            <text fg={t().textMuted}>{fmt(seg.tokens)} ({pct}%)</text>
                        </box>
                    )
                })}
            </box>

            {/* Recomp / session-upgrade live progress (full width, only while
                running or just finished — dogfood 2026-05-30). */}
            {s().recompProgress && (() => {
                const p = s().recompProgress!
                // Label follows the flow that started the run, so a plain
                // /ctx-recomp never reads as an "Upgrade" (dogfood 2026-06-04).
                const verb = p.kind === "upgrade" ? "Upgrade" : p.kind === "embed" ? "Embed" : "Recomp"
                return (
                <box marginTop={1} width="100%" flexDirection="column">
                    <text fg={t().text}><b>{verb}</b></text>
                    {(() => {
                        if (p.phase === "recomp") {
                            const frac = p.totalMessages > 0 ? p.processedMessages / p.totalMessages : 0
                            const width = 24
                            const filled = Math.round(Math.max(0, Math.min(1, frac)) * width)
                            const bar = p.totalMessages > 0
                                ? `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`
                                : "(starting…)"
                            const activeLabel = p.kind === "upgrade" ? "upgrading" : p.kind === "embed" ? "embedding" : "comparting"
                            return (
                                <>
                                    <R t={t()} l={activeLabel} v={p.totalMessages > 0 ? `${bar} ${Math.round(frac * 100)}%` : bar} fg={t().warning} />
                                    {p.note ? <R t={t()} l="Status" v={p.note} fg={t().textMuted} /> : null}
                                    {p.kind === "embed"
                                        ? <R t={t()} l="Compartments" v={`${p.processedMessages}/${p.totalMessages} embedded`} fg={t().textMuted} />
                                        : <R t={t()} l="Compartments" v={`${p.compartmentsCreated} (${p.passCount} pass${p.passCount === 1 ? "" : "es"})`} fg={t().textMuted} />}
                                </>
                            )
                        }
                        if (p.phase === "migration") return <R t={t()} l="Status" v={p.note ?? "Migrating memories ⟳"} fg={t().warning} />
                        if (p.phase === "done") return <R t={t()} l="Status" v={`✓ ${verb} complete`} fg={t().accent} />
                        if (p.phase === "skipped") return <R t={t()} l="Status" v={p.message ?? `${verb} stopped early`} fg={t().textMuted} />
                        return <R t={t()} l="Status" v={`✗ ${verb} failed${p.message ? `: ${p.message}` : ""}`} fg={t().error} />
                    })()}
                </box>
                )
            })()}

            {/* 2-column layout */}
            <box flexDirection="row" width="100%" marginTop={1} gap={4}>
                {/* Left column */}
                <box flexDirection="column" flexGrow={1} flexBasis={0}>
                    <text fg={t().text}><b>Tags</b></text>
                    <R t={t()} l="Active" v={`${s().activeTags} (~${fmtBytes(s().activeBytes)})`} />
                    <R t={t()} l="Dropped" v={String(s().droppedTags)} />
                    <R t={t()} l="Total" v={String(s().totalTags)} fg={t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>Pending Queue</b></text>
                    </box>
                    <R t={t()} l="Drops" v={String(s().pendingOpsCount)} fg={s().pendingOpsCount > 0 ? t().warning : t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>Cache TTL</b></text>
                    </box>
                    <R t={t()} l="Configured" v={s().cacheTtl} />
                    <R t={t()} l="Last response" v={s().lastResponseTime > 0 ? `${Math.round(elapsed() / 1000)}s ago` : "never"} />
                    <R t={t()} l="Remaining" v={s().cacheExpired ? "expired" : `${Math.round(s().cacheRemainingMs / 1000)}s`} fg={s().cacheExpired ? t().warning : t().textMuted} />
                    <R t={t()} l="Auto-execute" v={s().cacheExpired ? "yes (expired)" : `at TTL or ≥${formatThresholdPercent(s().executeThreshold)}%`} fg={t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>Memory</b></text>
                    </box>
                    <R t={t()} l="Active" v={String(s().memoryCount)} fg={t().accent} />
                    <R t={t()} l="Injected" v={String(s().memoryBlockCount)} fg={t().textMuted} />
                </box>
                {/* Right column */}
                <box flexDirection="column" flexGrow={1} flexBasis={0}>
                    <text fg={t().text}><b>Reductions</b></text>
                    <R t={t()} l="Execute threshold" v={`${formatThresholdPercent(s().executeThreshold)}%`} />
                    <R t={t()} l="Last reduce anchor" v={`${fmt(s().lastNudgeTokens)} tok`} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>Context Details</b></text>
                    </box>
                    <R t={t()} l="Protected tags" v={String(s().protectedTagCount)} fg={t().textMuted} />
                    <R t={t()} l="Subagent" v={s().isSubagent ? "yes" : "no"} fg={t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>History Compression</b></text>
                    </box>
                    <R t={t()} l="History block" v={`~${fmt(s().historyBlockTokens)} tok`} />
                    {s().compressionBudget != null && (
                        <R t={t()} l="Budget" v={`~${fmt(s().compressionBudget!)} tok (${s().compressionUsage} used)`} />
                    )}
                    {s().lastDreamerRunAt && (
                        <R t={t()} l="Dreamer" v={`last ${relTime(s().lastDreamerRunAt!)}`} fg={t().textMuted} />
                    )}
                </box>
            </box>

            {/* Error (full width, conditional) */}
            {s().lastTransformError && (
                <box marginTop={1} width="100%">
                    <text fg={t().error}>⚠ {s().lastTransformError}</text>
                </box>
            )}

            {/* Footer */}
            <box marginTop={1} justifyContent="flex-end" width="100%">
                <text fg={t().textMuted}>Esc to close</text>
            </box>
        </box>
    )
}

function getModelKeyFromMessages(api: TuiPluginApi, sessionId: string): string | undefined {
    try {
        const msgs = api.state.session.messages(sessionId)
        // Find the last assistant message with model info
        // AssistantMessage has providerID/modelID as top-level fields
        // UserMessage has model: { providerID, modelID }
        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i] as Record<string, unknown>
            if (msg.role === "assistant" && msg.providerID && msg.modelID) {
                return `${msg.providerID}/${msg.modelID}`
            }
            if (msg.role === "user") {
                const model = msg.model as Record<string, unknown> | undefined
                if (model?.providerID && model?.modelID) {
                    return `${model.providerID}/${model.modelID}`
                }
            }
        }
    } catch {
        // messages not available
    }
    return undefined
}

async function showRecompDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        showToast(api, { message: "No active session", variant: "warning" })
        return false
    }

    const count = await getCompartmentCount(sessionId)
    // Ack only after the dialog is actually shown for the same active session;
    // route switches while the RPC detail load is in flight must leave it pending.
    if (getSessionId(api) !== sessionId) return false

    api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
            title="⚠️ Recomp Confirmation"
            message={[
                count === 0
                    ? "This session has no compartments yet — recomp will build them from raw history."
                    : `You have ${count} compartments.`,
                "",
                "Recomp will regenerate all compartments and facts from raw history.",
                "This may take a long time and consume significant tokens.",
                "",
                "Proceed?",
            ].join("\n")}
            onConfirm={() => {
                void requestRecomp(sessionId)
                kickRecompProgressRefresh()
                showToast(api, { message: "Recomp requested — historian will start shortly", variant: "info" })
            }}
            onCancel={() => {
                showToast(api, { message: "Recomp cancelled", variant: "info", durationOverrideMs: 3000 })
            }}
        />
    ))
    return true
}

function showUpgradeDialog(
    api: TuiPluginApi,
    resume?: { stagedCount: number; stagedThrough: number },
    targetSessionId = getSessionId(api),
): boolean {
    const sessionId = targetSessionId
    if (!sessionId) {
        // No active session — nothing to upgrade. Silently skip (the server only
        // enqueues this for sessions with legacy compartments, but the TUI may
        // have switched sessions before the poller fired).
        return false
    }

    if (getSessionId(api) !== sessionId) return false

    const title = resume ? "🎆 Resume the interrupted upgrade?" : "🎆 Historian V2 is released!"
    const message = resume
        ? [
              `An earlier upgrade to the new historian format was interrupted. ${resume.stagedCount} compartment${resume.stagedCount === 1 ? " was" : "s were"} already rebuilt (through message ${resume.stagedThrough}). Resuming continues from where it left off — nothing already rebuilt is reprocessed.`,
              "",
              "Resuming will:",
              "• Rebuild the remaining compartments into the new layered format",
              "• Re-organize this project's memories into the new taxonomy (once per project)",
              "",
              "The historian runs in the background and you can keep working. You can also resume via /ctx-session-upgrade later.",
              "",
              "Resume the upgrade now?",
          ].join("\n")
        : [
              "This session's compartments are written by the old historian. The session is still usable with its old compartments, however it's strongly advised to upgrade them to the new format. This means every compartment needs to be reprocessed by the new historian, which might take a while depending on how big your session is.",
              "",
              "Running the upgrade will:",
              "• Rebuild this session's compartments into the new layered format",
              "• Re-organize this project's memories into the new taxonomy (once per project)",
              "",
              "The historian runs in the background and you can keep working while older compartments are reprocessed. You can also upgrade via /ctx-session-upgrade later.",
              "",
              "Run the upgrade now?",
          ].join("\n")

    api.ui.dialog.replace(
        () => (
            <api.ui.DialogConfirm
                title={title}
                message={message}
                onConfirm={() => {
                    // Start the sidebar's recomp self-poll immediately — the RPC
                    // call fires no message event, so without this the progress
                    // bar wouldn't appear until the upgrade finished.
                    kickRecompProgressRefresh()
                    showToast(api, {
                        message: resume
                            ? "Resuming session upgrade — running in the background"
                            : "Session upgrade started — running in the background",
                        variant: "info",
                    })
                    // Dismiss the durable reminder ONLY after the upgrade request
                    // actually started. If requestUpgrade() returns false (RPC /
                    // server / db / auth failure, restart race), the session stays
                    // legacy — dismissing first would set upgradeRemindedAt and
                    // suppress all future reminders for a session that never
                    // upgraded. (Resume prompts are staging-driven and unaffected.)
                    void requestUpgrade(sessionId).then((started) => {
                        if (started) void dismissUpgradeReminder(sessionId)
                    })
                }}
                onCancel={() => {
                    // Explicit decline → set the durable stamp so we don't re-prompt
                    // on every restart. The fix for stamp-on-display trapping a
                    // never-upgraded session (dogfood 2026-05-30) relies on THIS
                    // being the only place the TUI path stamps.
                    void dismissUpgradeReminder(sessionId)
                    showToast(api, {
                        message: "Upgrade skipped — run /ctx-session-upgrade anytime",
                        variant: "info",
                        durationOverrideMs: 4000,
                    })
                }}
            />
        ),
    )
    return true
}

async function showStatusDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        showToast(api, { message: "No active session", variant: "warning" })
        return false
    }

    const directory = api.state.path.directory ?? ""
    const modelKey = getModelKeyFromMessages(api, sessionId)
    const detail = await loadStatusDetail(sessionId, directory, modelKey)
    if (getSessionId(api) !== sessionId) return false

    api.ui.dialog.replace(() => <StatusDialog api={api} s={detail} />)
    return true
}

const EmbedDialog = (props: { api: TuiPluginApi; detail: EmbedDetail }) => {
    const theme = createMemo(() => (props.api as any).theme.current)
    const t = () => theme()
    const lines = () => props.detail.statusText.split("\n")
    return (
        <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            <box justifyContent="center" width="100%" marginBottom={1}>
                <text fg={t().accent}><b>Embedding</b></text>
            </box>
            {lines().map((line) => (
                <text fg={t().text}>{line}</text>
            ))}
        </box>
    )
}

async function showEmbedDialog(api: TuiPluginApi, targetSessionId = getSessionId(api)): Promise<boolean> {
    const sessionId = targetSessionId
    if (!sessionId) {
        api.ui.toast({ message: "No active session", variant: "warning" })
        return false
    }
    const directory = api.state.path.directory ?? ""
    const detail = await loadEmbedDetail(sessionId, directory)
    if (getSessionId(api) !== sessionId) return false
    api.ui.dialog.replace(() => <EmbedDialog api={api} detail={detail} />)
    return true
}

function showResultDialog(api: TuiPluginApi, title: string, message: string): boolean {
    api.ui.dialog.replace(() => (
        <api.ui.DialogAlert
            title={title}
            message={message}
            onConfirm={() => {}}
        />
    ))
    return true
}


/**
 * Register Magic Context command palette entries, preferring the v1.14.42+
 * `keymap.registerLayer` API and falling back to the legacy
 * `api.command.register` for older hosts.
 *
 * The `keymap.registerLayer` shape uses `name`/`title`/`run`/`namespace`
 * (see `@opencode-ai/plugin/tui` types) and is what the host's own legacy
 * command-shim translates into. Calling it directly skips the deprecation
 * warning and works without depending on the (now-deprecated) `api.command`
 * namespace existing at all.
 *
 * Version coverage:
 *   1.14.0–1.14.41 — `api.command.register` only
 *   1.14.42–1.14.43 — both surfaces broken (api.command removed, keymap landed
 *                     but with bugs); plugins crash on init either way
 *   1.14.44+        — `api.keymap.registerLayer` canonical, `api.command` shim
 */
function registerCommandPaletteEntries(api: TuiPluginApi): void {
    type ApiAny = {
        keymap?: {
            registerLayer?: (layer: {
                commands: Array<Record<string, unknown>>
                bindings: Array<Record<string, unknown>>
            }) => unknown
        }
        command?: {
            register?: (cb: () => Array<Record<string, unknown>>) => unknown
        }
    }
    const apiAny = api as unknown as ApiAny

    if (typeof apiAny.keymap?.registerLayer === "function") {
        // Audit Finding #2 hardening: even when registerLayer exists as a
        // function, the underlying keymap implementation in OpenCode TUI
        // 1.14.42-1.14.43 can throw at call time. Without the try-catch the
        // `return` below would propagate the throw and the legacy
        // `command.register` fallback path (~20 lines down) would be
        // unreachable. The cost is one debug log on the rare broken-TUI
        // build; the benefit is that older command.register-only TUIs
        // running alongside a partially-broken keymap surface still get
        // their command palette entries.
        try {
            apiAny.keymap.registerLayer({
                commands: [
                    {
                        namespace: "palette",
                        name: "magic-context.status",
                        title: "Magic Context: Status",
                        category: "Magic Context",
                        run() {
                            showStatusDialog(api)
                        },
                    },
                    {
                        namespace: "palette",
                        name: "magic-context.recomp",
                        title: "Magic Context: Recomp",
                        category: "Magic Context",
                        run() {
                            showRecompDialog(api)
                        },
                    },
                ],
                bindings: [],
            })
            return
        } catch (err) {
            console.debug(
                "[magic-context-tui] keymap.registerLayer threw; falling back to command.register",
                err,
            )
            // Fall through to legacy registration.
        }
    }

    if (typeof apiAny.command?.register === "function") {
        apiAny.command.register(() => [
            {
                title: "Magic Context: Status",
                value: "magic-context.status",
                category: "Magic Context",
                onSelect() {
                    showStatusDialog(api)
                },
            },
            {
                title: "Magic Context: Recomp",
                value: "magic-context.recomp",
                category: "Magic Context",
                onSelect() {
                    showRecompDialog(api)
                },
            },
        ])
        return
    }

    // Neither API surface is present. The TUI host can still load — we only
    // lose the command palette entry points. The sidebar (registered above
    // via api.slots.register) remains visible. Status/Recomp are still
    // reachable through the server-side `/ctx-status` and `/ctx-recomp`
    // slash commands, which the server handler bridges to the TUI dialogs
    // via RPC.
}

/**
 * Show the one-shot "What's new" dialog on TUI startup if the server tells us
 * to. The server is the source of truth: it has the version + features
 * constants AND owns the persistence file. We just render and report back.
 *
 * Failure-tolerant by design — if the server isn't ready or the RPC fails,
 * we silently skip (the next TUI launch will retry).
 */
/**
 * URLs render as plain text. Modern terminals (iTerm2, kitty, WezTerm, Ghostty,
 * recent macOS Terminal) auto-detect URLs and let users Cmd-click; older
 * terminals require manual copy. We tried opentui's `<a href>` JSX intrinsic
 * for application-level OSC 8 clickability, but it's a span-like element that
 * forced text out of opentui's word-wrap mode, causing bullets to bleed past
 * the dialog border. Pure-string children of `<text>` wrap correctly, so the
 * AFT-style DialogAlert + plain string is the right surface here.
 */
async function showStartupAnnouncement(api: TuiPluginApi): Promise<void> {
    try {
        const ann = await getAnnouncement()
        if (!ann.show || !ann.version || !ann.features || ann.features.length === 0) return

        const title = `Magic Context v${ann.version}`
        const lines: string[] = [
            "What's new:",
            "",
            ...ann.features.map((line) => `  • ${line}`),
        ]
        if (ann.footer && ann.footer.trim().length > 0) {
            // Blank-line separator keeps the persistent footer (Discord invite,
            // etc.) visually distinct from the version-specific bullets.
            lines.push("", ann.footer)
        }
        const message = lines.join("\n")

        api.ui.dialog.replace(
            () => (
                <api.ui.DialogAlert
                    title={title}
                    message={message}
                    onConfirm={() => {
                        void markAnnounced()
                    }}
                />
            ),
            () => {
                // User dismissed via Escape rather than confirming. Mark
                // dismissed anyway — they saw the dialog, that's the contract.
                void markAnnounced()
            },
        )
    } catch {
        // RPC not ready yet (port file missing or transient HTTP failure) —
        // silently skip. The next TUI start re-checks.
    }
}

const tui: TuiPlugin = async (api, _options, meta) => {
    // Initialize RPC client for server communication
    const directory = api.state.path.directory ?? ""
    initRpcClient(directory)
    await refreshToastDurationMs()

    // Register sidebar slot
    api.slots.register(createSidebarContentSlot(api))

    // Register TUI command palette entries (no slash field — slash commands
    // are registered server-side so there's only one /ctx-* registration).
    // The server detects TUI mode and sends dialog requests via RPC instead
    // of sendIgnoredMessage.
    //
    // OpenCode 1.14.42 removed `api.command.register` entirely
    // (anomalyco/opencode#26053). A later patch (1.14.44+) reinstated it as
    // a deprecated shim that translates to `api.keymap.registerLayer`. To
    // work across all hosts (1.14.0–1.14.41 with command-only, the broken
    // 1.14.42–1.14.43, and 1.14.44+ where both exist), we prefer
    // `api.keymap.registerLayer` and fall back to `api.command.register`
    // only when keymap is missing.
    registerCommandPaletteEntries(api)

    // Poll for server→TUI messages: toasts and dialog requests.
    // The poller owns cursor advancement so notifications are acked only after
    // they are accepted for the still-active session and delivered to the UI.
    let pollInFlight = false
    const messagePoller = setInterval(() => {
        // Scope the drain to the TUI's active session so notifications tagged for
        // a different session (served by the same RPC process) are not consumed
        // here. Do not poll on non-session routes: a session-scoped action fetched
        // while sessionless could otherwise be acked without being shown.
        // Avoid overlapping read-only drains: the server re-delivers until acked,
        // so a second in-flight poll can fetch and dispatch the same batch twice.
        if (pollInFlight) return

        const requestedSessionId = getSessionId(api)
        if (!requestedSessionId) return

        pollInFlight = true
        const pollGeneration = getRpcGeneration()
        void consumeTuiMessages(requestedSessionId).then(async (messages) => {
            if (unifiedToastDurationMs === DEFAULT_TOAST_DURATION_MS) {
                void refreshToastDurationMs()
            }
            // The dialog handlers read the current session when they run. If the
            // user switched routes while the RPC was in flight, drop this whole
            // batch without advancing the cursor; the next poll for the new
            // session will fetch the right notifications.
            // Ignore late responses from an older RPC client generation; close/init
            // clears cursors and stale callbacks must not recreate them.
            if (getRpcGeneration() !== pollGeneration) return

            if (getSessionId(api) !== requestedSessionId) return

            const orderedMessages = [...messages].sort((a, b) => a.id - b.id)
            const handledMessageIds = new Set<number>()
            for (const msg of orderedMessages) {
                // A dialog helper earlier in this batch may have awaited; re-check
                // the route before EACH message so a later action/toast in the same
                // batch can't paint into a session the user switched to mid-batch
                // (the pre-batch + pre-ack guards alone don't cover mid-batch awaits).
                if (getRpcGeneration() !== pollGeneration) return
                if (getSessionId(api) !== requestedSessionId) return
                // Drop any action/dialog whose sessionId doesn't match this TUI's
                // active session (session-less/global notifications still apply).
                if (
                    msg.type === "action" &&
                    msg.sessionId &&
                    msg.sessionId !== requestedSessionId
                ) {
                    continue
                }
                if (msg.type === "toast") {
                    const p = msg.payload
                    showToast(api, {
                        message: String(p.message ?? ""),
                        variant: (p.variant as "info" | "warning" | "error" | "success") ?? "info",
                        durationOverrideMs:
                            typeof p.duration === "number" && Number.isFinite(p.duration)
                                ? p.duration
                                : undefined,
                    })
                    handledMessageIds.add(msg.id)
                } else if (msg.type === "action") {
                    const action = msg.payload?.action
                    if (action === "show-status-dialog") {
                        if (await showStatusDialog(api, requestedSessionId)) {
                            handledMessageIds.add(msg.id)
                        }
                    } else if (action === "show-recomp-dialog") {
                        if (await showRecompDialog(api, requestedSessionId)) {
                            handledMessageIds.add(msg.id)
                        }
                    } else if (action === "show-upgrade-dialog") {
                        const resume =
                            msg.payload?.resume === true
                                ? {
                                      stagedCount: Number(msg.payload?.stagedCount ?? 0),
                                      stagedThrough: Number(msg.payload?.stagedThrough ?? 0),
                                  }
                                : undefined
                        if (showUpgradeDialog(api, resume, requestedSessionId)) {
                            handledMessageIds.add(msg.id)
                        }
                    } else if (action === "show-embed-dialog") {
                        if (await showEmbedDialog(api, requestedSessionId)) {
                            handledMessageIds.add(msg.id)
                        }
                    } else if (action === "show-flush-dialog") {
                        const flushMsg = String(msg.payload?.message ?? "Flushed.")
                        if (showResultDialog(api, "Flush", flushMsg)) {
                            handledMessageIds.add(msg.id)
                        }
                    } else if (action === "show-result-dialog") {
                        const title = String(msg.payload?.title ?? "Magic Context")
                        const body = String(msg.payload?.message ?? "")
                        if (showResultDialog(api, title, body)) {
                            handledMessageIds.add(msg.id)
                        }
                    }
                }
            }
            const handledPrefixMessages: TuiMessage[] = []
            for (const msg of orderedMessages) {
                if (!handledMessageIds.has(msg.id)) break
                handledPrefixMessages.push(msg)
            }
            // A dialog helper may have awaited more RPC work; re-check before
            // acking so a dispose/reinit or route switch during that await cannot
            // advance a stale cursor.
            if (getRpcGeneration() !== pollGeneration) return
            if (getSessionId(api) !== requestedSessionId) return

            markTuiMessagesHandled(requestedSessionId, handledPrefixMessages)
        }).catch(() => {
            // Intentional: message polling should never crash the TUI
        }).finally(() => {
            pollInFlight = false
        })
    }, 500)

    // Clean up on dispose
    api.lifecycle.onDispose(() => {
        clearInterval(messagePoller)
        closeRpc()
    })

    const conflictResult = detectConflicts(directory)
    if (conflictResult.hasConflict) {
        showConflictDialog(api, directory, conflictResult.reasons, conflictResult.conflicts)
        return
    }

    // Show one-shot release announcement after conflict gate.
    // Fire-and-forget: if the server isn't ready or RPC fails, the next TUI
    // launch will retry. Dialog only appears once per ANNOUNCEMENT_VERSION
    // (persisted via mark-announced RPC writing last_announced_version).
    void showStartupAnnouncement(api)

    // Note: if TUI plugin is loaded, tui.json already has our entry.
    // But if the user added it manually and later removes it, or if they
    // use setup/doctor which handles tui.json, this code is already running.
}

const id = "opencode-magic-context"

export default {
    id,
    tui,
}
