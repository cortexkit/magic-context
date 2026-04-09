/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createMemo } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createSidebarContentSlot } from "./slots/sidebar-content"
import packageJson from "../../package.json"
import { closeDb, consumeTuiMessages, getCompartmentCount, loadStatusDetail, sendMessageToServer, type StatusDetail } from "./data/context-db"
import { detectConflicts } from "../shared/conflict-detector"
import { fixConflicts } from "../shared/conflict-fixer"
import { readJsoncFile } from "../shared/jsonc-parser"
import { getOpenCodeConfigPaths } from "../shared/opencode-config-dir"

const PLUGIN_NAME = "@cortexkit/opencode-magic-context"

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
                                api.ui.toast({ message: "Restart OpenCode to enable Magic Context", variant: "warning", duration: 10000 })
                            }}
                        />
                    ))
                }, 50)
            }}
            onCancel={() => {
                api.ui.toast({ message: "Magic Context remains disabled. Run: bunx @cortexkit/opencode-magic-context@latest doctor", variant: "warning", duration: 5000 })
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
                                    api.ui.toast({ message: "Add plugin to tui.json manually", variant: "warning", duration: 5000 })
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
                                api.ui.toast({ message: "Restart OpenCode to see the sidebar", variant: "warning", duration: 10000 })
                            }}
                        />
                    ))
                }, 50)
            }}
            onCancel={() => {
                api.ui.toast({ message: "You can add the sidebar later via: bunx @cortexkit/opencode-magic-context@latest doctor", variant: "info", duration: 5000 })
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

    const contextLimit = () =>
        s().usagePercentage > 0 ? Math.round(s().inputTokens / (s().usagePercentage / 100)) : 0

    const elapsed = () => (s().lastResponseTime > 0 ? Date.now() - s().lastResponseTime : 0)

    // Token breakdown segments — same colors as sidebar
    const COLORS = {
        system: "#c084fc",
        compartments: "#60a5fa",
        facts: "#fbbf24",
        memories: "#34d399",
    }

    const breakdownSegments = () => {
        const d = s()
        const total = d.inputTokens || 1
        const segs: Array<{ label: string; tokens: number; color: string; detail?: string }> = []

        if (d.systemPromptTokens > 0)
            segs.push({ label: "System", tokens: d.systemPromptTokens, color: COLORS.system })
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

        const used = d.systemPromptTokens + d.compartmentTokens + d.factTokens + d.memoryTokens
        const convTokens = Math.max(0, d.inputTokens - used)
        if (convTokens > 0)
            segs.push({ label: "Conversation", tokens: convTokens, color: t().textMuted })

        return { segs, total }
    }

    const barWidth = 56
    const barSegments = () => {
        const { segs, total } = breakdownSegments()
        if (segs.length === 0) return []

        let widths = segs.map((seg) => Math.max(1, Math.round((seg.tokens / total) * barWidth)))
        let sum = widths.reduce((a, b) => a + b, 0)
        while (sum > barWidth) {
            const maxIdx = widths.indexOf(Math.max(...widths))
            if (widths[maxIdx] > 1) { widths[maxIdx]--; sum-- } else break
        }
        while (sum < barWidth) {
            const maxIdx = widths.indexOf(Math.max(...widths))
            widths[maxIdx]++; sum++
        }

        return segs.map((seg, i) => ({
            chars: "█".repeat(widths[i] || 0),
            color: seg.color,
        }))
    }

    return (
        <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            {/* Title */}
            <box justifyContent="center" width="100%" marginBottom={1} flexDirection="row" gap={2}>
                <text fg={t().accent}><b>⚡ Magic Context Status</b></text>
                <text fg={t().textMuted}>v{packageJson.version}</text>
            </box>

            {/* Context summary line */}
            <box flexDirection="row" justifyContent="space-between" width="100%">
                <text fg={t().text}>Context</text>
                <text fg={s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent}>
                    <b>{s().usagePercentage.toFixed(1)}%</b> · {fmt(s().inputTokens)} / {contextLimit() > 0 ? fmt(contextLimit()) : "?"} tokens
                </text>
            </box>

            {/* Segmented breakdown bar */}
            <box flexDirection="row">
                {barSegments().map((seg, i) => (
                    <text key={i} fg={seg.color}>{seg.chars}</text>
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
                    <R t={t()} l="Auto-execute" v={s().cacheExpired ? "yes (expired)" : `at TTL or ≥${s().executeThreshold}%`} fg={t().textMuted} />
                    <box marginTop={1}>
                        <text fg={t().text}><b>Memory</b></text>
                    </box>
                    <R t={t()} l="Active" v={String(s().memoryCount)} fg={t().accent} />
                    <R t={t()} l="Injected" v={String(s().memoryBlockCount)} fg={t().textMuted} />
                </box>
                {/* Right column */}
                <box flexDirection="column" flexGrow={1} flexBasis={0}>
                    <text fg={t().text}><b>Rolling Nudges</b></text>
                    <R t={t()} l="Execute threshold" v={`${s().executeThreshold}%`} />
                    <R t={t()} l="Nudge anchor" v={`${fmt(s().lastNudgeTokens)} tok`} />
                    <R t={t()} l="Interval" v={`${fmt(s().nudgeInterval)} tok`} fg={t().textMuted} />
                    <R t={t()} l="Next nudge after" v={`${fmt(s().nextNudgeAfter)} tok`} />
                    {s().lastNudgeBand ? <R t={t()} l="Current band" v={s().lastNudgeBand} /> : null}
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

function showRecompDialog(api: TuiPluginApi) {
    const sessionId = getSessionId(api)
    if (!sessionId) {
        api.ui.toast({ message: "No active session", variant: "warning" })
        return
    }

    const count = getCompartmentCount(sessionId)
    api.ui.dialog.replace(() => (
        <api.ui.DialogConfirm
            title="⚠️ Recomp Confirmation"
            message={[
                `You have ${count} compartments.`,
                "",
                "Recomp will regenerate all compartments and facts from raw history.",
                "This may take a long time and consume significant tokens.",
                "",
                "Proceed?",
            ].join("\n")}
            onConfirm={() => {
                sendMessageToServer("action", { command: "recomp" }, sessionId)
                api.ui.toast({ message: "Recomp requested — historian will start shortly", variant: "info", duration: 5000 })
            }}
            onCancel={() => {
                api.ui.toast({ message: "Recomp cancelled", variant: "info", duration: 3000 })
            }}
        />
    ))
}

function showStatusDialog(api: TuiPluginApi) {
    const sessionId = getSessionId(api)
    if (!sessionId) {
        api.ui.toast({ message: "No active session", variant: "warning" })
        return
    }

    const directory = api.state.path.directory ?? ""
    const modelKey = getModelKeyFromMessages(api, sessionId)
    const detail = loadStatusDetail(sessionId, directory, modelKey)

    api.ui.dialog.replace(() => <StatusDialog api={api} s={detail} />)
}

const tui: TuiPlugin = async (api, _options, meta) => {
    // Register sidebar slot
    api.slots.register(createSidebarContentSlot(api))

    // Register TUI command palette entries for commands with richer TUI-native UI.
    api.command.register(() => [
        {
            title: "Magic Context: Status",
            value: "magic-context.status",
            category: "Magic Context",
            slash: { name: "ctx-status" },
            onSelect() {
                showStatusDialog(api)
            },
        },
        {
            title: "Magic Context: Recomp",
            value: "magic-context.recomp",
            category: "Magic Context",
            slash: { name: "ctx-recomp" },
            onSelect() {
                showRecompDialog(api)
            },
        },
    ])

    // Poll for server→TUI messages (toasts, dialogs) every 2 seconds
    const messagePoller = setInterval(() => {
        try {
            const messages = consumeTuiMessages()
            for (const msg of messages) {
                if (msg.type === "toast") {
                    const p = msg.payload
                    api.ui.toast({
                        message: String(p.message ?? ""),
                        variant: (p.variant as "info" | "warning" | "error" | "success") ?? "info",
                        duration: typeof p.duration === "number" ? p.duration : 5000,
                    })
                } else if (msg.type === "dialog_confirm") {
                    const p = msg.payload
                    const dialogId = String(p.id ?? "")
                    api.ui.dialog.replace(() => (
                        <api.ui.DialogConfirm
                            title={String(p.title ?? "Confirm")}
                            message={String(p.message ?? "")}
                            onConfirm={() => {
                                sendMessageToServer("dialog_result", { id: dialogId, confirmed: true }, msg.sessionId ?? undefined)
                            }}
                            onCancel={() => {
                                sendMessageToServer("dialog_result", { id: dialogId, confirmed: false }, msg.sessionId ?? undefined)
                            }}
                        />
                    ))
                }
            }
        } catch {
            // Intentional: message polling should never crash the TUI
        }
    }, 2000)

    // Clean up on dispose
    api.lifecycle.onDispose(() => {
        clearInterval(messagePoller)
        closeDb()
    })

    const directory = api.state.path.directory ?? ""
    const conflictResult = detectConflicts(directory)
    if (conflictResult.hasConflict) {
        showConflictDialog(api, directory, conflictResult.reasons, conflictResult.conflicts)
        return
    }

    // Note: tui.json detection moved to server plugin (src/index.ts) since
    // if tui.json doesn't have our plugin, this TUI code never loads at all.
}

const id = "opencode-magic-context"

export default {
    id,
    tui,
}
