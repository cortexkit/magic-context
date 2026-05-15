/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { TuiSlotPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import packageJson from "../../../package.json"
import { loadSidebarSnapshot, type SidebarSnapshot } from "../data/context-db"

const SINGLE_BORDER = { type: "single" } as any
const REFRESH_DEBOUNCE_MS = 150

function compactTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
    return String(value)
}

function relativeTime(ms: number): string {
    const diff = Date.now() - ms
    if (diff < 60_000) return "just now"
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return `${Math.floor(diff / 86_400_000)}d ago`
}

// Token breakdown segment colors (hardcoded hex values)
const COLORS = {
    // Cool / structured — injected by the plugin into message[0]
    system: "#c084fc", // Purple
    compartments: "#60a5fa", // Blue
    facts: "#fbbf24", // Yellow/orange
    memories: "#34d399", // Green
    // Warm / user-facing — regular chat and tool traffic. Grouped visually
    // by hue family so the user reads them as a related block.
    conversation: "#f87171", // Red
    toolCalls: "#fb923c", // Orange
    toolDefs: "#f472b6", // Pink
}

interface TokenSegment {
    key: string
    tokens: number
    color: string
    label: string
}

// Segmented token breakdown bar with legend
const TokenBreakdown = (props: {
    theme: TuiThemeCurrent
    snapshot: SidebarSnapshot
}) => {
    const barWidth = 36

    const segments = createMemo<TokenSegment[]>(() => {
        const s = props.snapshot
        const total = s.inputTokens || 1
        const result: TokenSegment[] = []

        // System Prompt (purple)
        if (s.systemPromptTokens > 0) {
            result.push({
                key: "sys",
                tokens: s.systemPromptTokens,
                color: COLORS.system,
                label: "System",
            })
        }

        // Compartments (blue)
        if (s.compartmentTokens > 0) {
            result.push({
                key: "comp",
                tokens: s.compartmentTokens,
                color: COLORS.compartments,
                label: "Compartments",
            })
        }

        // Facts (yellow/orange)
        if (s.factTokens > 0) {
            result.push({
                key: "fact",
                tokens: s.factTokens,
                color: COLORS.facts,
                label: "Facts",
            })
        }

        // Memories (green)
        if (s.memoryTokens > 0) {
            result.push({
                key: "mem",
                tokens: s.memoryTokens,
                color: COLORS.memories,
                label: "Memories",
            })
        }

        // Conversation = real user/assistant text/reasoning/images
        // (excludes injected session-history and excludes tool call I/O)
        if (s.conversationTokens > 0) {
            result.push({
                key: "conv",
                tokens: s.conversationTokens,
                color: COLORS.conversation,
                label: "Conversation",
            })
        }

        // Tool Calls = tool_use/tool_result/tool/tool-invocation parts in messages
        // (actionable — users can reduce via ctx_reduce)
        if (s.toolCallTokens > 0) {
            result.push({
                key: "tool-calls",
                tokens: s.toolCallTokens,
                color: COLORS.toolCalls,
                label: "Tool Calls",
            })
        }

        // Tool Definitions = measured description + JSON-schema parameters for
        // each tool OpenCode sends in the `tools` request parameter, populated
        // by the `tool.definition` plugin hook keyed by {provider, model, agent}.
        // Zero until the first turn measures the active agent's tool set.
        if (s.toolDefinitionTokens > 0) {
            result.push({
                key: "tool-defs",
                tokens: s.toolDefinitionTokens,
                color: COLORS.toolDefs,
                label: "Tool Defs",
            })
        }

        return result
    })

    const totalTokens = createMemo(() => props.snapshot.inputTokens || 1)

    // Calculate proportional widths for each segment
    const segmentWidths = createMemo(() => {
        const total = totalTokens()
        const segs = segments()
        if (segs.length === 0) return []

        // Calculate raw proportions
        const proportions = segs.map((seg) => seg.tokens / total)

        // Convert to character widths (minimum 1 char if tokens > 0)
        let widths = proportions.map((p) => Math.max(1, Math.round(p * barWidth)))

        // Adjust to exactly barWidth
        const sum = widths.reduce((a, b) => a + b, 0)
        if (sum > barWidth) {
            // Shrink from the largest segments
            let excess = sum - barWidth
            while (excess > 0) {
                const maxIdx = widths.indexOf(Math.max(...widths))
                if (widths[maxIdx] > 1) {
                    widths[maxIdx]--
                    excess--
                } else {
                    break
                }
            }
        } else if (sum < barWidth) {
            // Expand the largest segments
            let deficit = barWidth - sum
            while (deficit > 0) {
                const maxIdx = widths.indexOf(Math.max(...widths))
                widths[maxIdx]++
                deficit--
            }
        }

        return widths
    })

    const barSegments = createMemo(() => {
        const segs = segments()
        const widths = segmentWidths()
        return segs.map((seg, i) => ({
            chars: "█".repeat(widths[i] || 0),
            color: seg.color,
        }))
    })

    return (
        <box width="100%" flexDirection="column">
            {/* Segmented bar */}
            <box flexDirection="row">
                {barSegments().map((seg, i) => (
                    <text key={i} fg={seg.color}>{seg.chars}</text>
                ))}
            </box>

            {/* Legend rows */}
            <box flexDirection="column" marginTop={0}>
                {segments().map((seg) => {
                    const pct = ((seg.tokens / totalTokens()) * 100).toFixed(0)
                    return (
                        <box
                            key={seg.key}
                            width="100%"
                            flexDirection="row"
                            justifyContent="space-between"
                        >
                            <text fg={seg.color}>{seg.label}</text>
                            <text fg={props.theme.textMuted}>
                                {compactTokens(seg.tokens)} ({pct}%)
                            </text>
                        </box>
                    )
                })}
            </box>
        </box>
    )
}

const StatRow = (props: {
    theme: TuiThemeCurrent
    label: string
    value: string
    accent?: boolean
    warning?: boolean
    dim?: boolean
}) => {
    const fg = createMemo(() => {
        if (props.warning) return props.theme.warning
        if (props.accent) return props.theme.accent
        if (props.dim) return props.theme.textMuted
        return props.theme.text
    })

    return (
        <box width="100%" flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.textMuted}>{props.label}</text>
            <text fg={fg()}>
                <b>{props.value}</b>
            </text>
        </box>
    )
}

const SectionHeader = (props: { theme: TuiThemeCurrent; title: string }) => (
    <box width="100%" marginTop={1}>
        <text fg={props.theme.text}>
            <b>{props.title}</b>
        </text>
    </box>
)

const SidebarContent = (props: {
    api: TuiPluginApi
    sessionID: () => string
    theme: TuiThemeCurrent
}) => {
    const [snapshot, setSnapshot] = createSignal<SidebarSnapshot | null>(null)
    let refreshTimer: ReturnType<typeof setTimeout> | undefined

    const refresh = () => {
        const sid = props.sessionID()
        if (!sid) return
        const directory = props.api.state.path.directory ?? ""
        void loadSidebarSnapshot(sid, directory).then((data) => {
            setSnapshot(data)
            try {
                props.api.renderer.requestRender()
            } catch {
                // Ignore render errors
            }
        })
    }

    const scheduleRefresh = () => {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            refresh()
        }, REFRESH_DEBOUNCE_MS)
    }

    onCleanup(() => {
        if (refreshTimer) clearTimeout(refreshTimer)
    })

    // Refresh on session change
    createEffect(
        on(props.sessionID, () => {
            refresh()
        }),
    )

    // Subscribe to events for live updates
    createEffect(
        on(
            props.sessionID,
            (sessionID) => {
                const unsubs = [
                    props.api.event.on("message.updated", (event) => {
                        if (event.properties.info.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.api.event.on("session.updated", (event) => {
                        if (event.properties.info.id !== sessionID) return
                        scheduleRefresh()
                    }),
                    props.api.event.on("message.removed", (event) => {
                        if (event.properties.sessionID !== sessionID) return
                        scheduleRefresh()
                    }),
                ]

                onCleanup(() => {
                    for (const unsub of unsubs) unsub()
                })
            },
            { defer: false },
        ),
    )

    const s = createMemo(() => snapshot())
    const contextSummaryColor = createMemo(() => {
        const usage = s()?.usagePercentage ?? 0
        if (usage >= 80) return props.theme.error
        if (usage >= 65) return props.theme.warning
        return props.theme.accent
    })

    return (
        <box
            width="100%"
            flexDirection="column"
            border={SINGLE_BORDER}
            borderColor={props.theme.borderActive}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
            paddingRight={1}
        >
            {/* Header */}
            <box flexDirection="row" justifyContent="space-between" alignItems="center">
                <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme.accent}>
                    <text fg={props.theme.background}>
                        <b>Magic Context</b>
                    </text>
                </box>
                <text fg={props.theme.textMuted}>v{packageJson.version}</text>
            </box>

            {/* Token breakdown bar */}
            {s() && s()!.inputTokens > 0 && (
                <box marginTop={1} flexDirection="column">
                    {(s()?.contextLimit ?? 0) > 0 && (
                        <box width="100%" flexDirection="row" justifyContent="space-between">
                            <text fg={props.theme.textMuted}>Context</text>
                            <text fg={contextSummaryColor()}>
                                <b>{s()!.usagePercentage.toFixed(1)}%</b> · {compactTokens(s()!.inputTokens)} / {compactTokens(s()!.contextLimit)} tokens
                            </text>
                        </box>
                    )}
                    <TokenBreakdown theme={props.theme} snapshot={s()!} />
                </box>
            )}

            {/* Historian section */}
            <box width="100%" marginTop={1} flexDirection="row" justifyContent="space-between">
                <text fg={props.theme.text}>
                    <b>Historian</b>
                </text>
                {s()?.historianRunning ? (
                    <text fg={props.theme.warning}>compacting ⟳</text>
                ) : (
                    <text fg={props.theme.textMuted}>idle</text>
                )}
            </box>
            <StatRow
                theme={props.theme}
                label="Compartments"
                value={String(s()?.compartmentCount ?? 0)}
            />
            <StatRow
                theme={props.theme}
                label="Facts"
                value={String(s()?.factCount ?? 0)}
            />

            {/* Memory section */}
            <SectionHeader theme={props.theme} title="Memory" />
            <StatRow
                theme={props.theme}
                label="Memories"
                value={String(s()?.memoryCount ?? 0)}
                accent
            />
            {(s()?.memoryBlockCount ?? 0) > 0 && (
                <StatRow
                    theme={props.theme}
                    label="Injected"
                    value={String(s()!.memoryBlockCount)}
                    dim
                />
            )}

            {/* Queue & Status */}
            {((s()?.pendingOpsCount ?? 0) > 0 ||
                (s()?.sessionNoteCount ?? 0) > 0 ||
                (s()?.readySmartNoteCount ?? 0) > 0) && (
                <>
                    <SectionHeader theme={props.theme} title="Status" />
                    {(s()?.pendingOpsCount ?? 0) > 0 && (
                        <StatRow
                            theme={props.theme}
                            label="Queue"
                            value={`${s()!.pendingOpsCount} pending`}
                            warning
                        />
                    )}
                    {(s()?.sessionNoteCount ?? 0) > 0 && (
                        <StatRow
                            theme={props.theme}
                            label="Notes"
                            value={String(s()!.sessionNoteCount)}
                        />
                    )}
                    {(s()?.readySmartNoteCount ?? 0) > 0 && (
                        <StatRow
                            theme={props.theme}
                            label="Smart Notes"
                            value={`${s()!.readySmartNoteCount} ready`}
                            accent
                        />
                    )}
                </>
            )}

            {/* Dreamer */}
            {s()?.lastDreamerRunAt && (
                <>
                    <SectionHeader theme={props.theme} title="Dreamer" />
                    <StatRow
                        theme={props.theme}
                        label="Last run"
                        value={relativeTime(s()!.lastDreamerRunAt!)}
                        dim
                    />
                </>
            )}
        </box>
    )
}

export function createSidebarContentSlot(api: TuiPluginApi): TuiSlotPlugin {
    return {
        order: 150,
        slots: {
            sidebar_content: (ctx, value) => {
                const theme = createMemo(() => ctx.theme.current)
                return (
                    <SidebarContent
                        api={api}
                        sessionID={() => value.session_id}
                        theme={theme()}
                    />
                )
            },
        },
    }
}
