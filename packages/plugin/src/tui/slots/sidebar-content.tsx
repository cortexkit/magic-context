/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { TuiSlotPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import packageJson from "../../../package.json"
import { loadSidebarSnapshot, type SidebarSnapshot } from "../data/context-db"
import { compactTokens, collapsedStatusLine, formatThresholdPercent } from "./sidebar-utils"

const SINGLE_BORDER = { type: "single" } as any
const REFRESH_DEBOUNCE_MS = 150

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
    // Unused / free — dim, distinct from usage segments.
    // Appears only in the collapsed bar when contextLimit > inputTokens.
    free: "#666666", // Dim gray
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
    compact?: boolean
}) => {
    // The bar is rendered as a flex row of colored boxes, each with
    // flexGrow=tokens and flexBasis=0. opentui distributes the parent
    // container's full width proportionally, so the bar always fills the
    // sidebar regardless of terminal size. No hardcoded width is needed —
    // this fixes both the over-wide bar that wrapped onto a second line on
    // narrow sidebars (issue #90) and the under-wide bar that left empty
    // space on the right on wide sidebars.
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
        // (excludes injected session-history and excludes tool call I/O).
        //
        // Always show this row even when conversationTokens === 0. The
        // calibrator's residual-distribution math (tokenizer-calibration.ts)
        // can round it down to zero when toolCallsLocal massively dominates
        // conversationLocal — that's a calibration artifact, not a real
        // "zero conversation". Suppressing the row leaves the legend looking
        // truncated, which is more confusing than showing a 0% line. The
        // segment is also skipped in the bar at 0 width because the segment
        // builder uses `Math.max(1, ...)` only when tokens > 0 (see
        // segmentWidths), so the visual bar stays correct either way.
        result.push({
            key: "conv",
            tokens: s.conversationTokens,
            color: COLORS.conversation,
            label: "Conversation",
        })

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

        // Free remaining context — shown only in compact mode so the bar
        // fills the full contextLimit width and labels show "64K Free" etc.
        if (props.compact && s.contextLimit && s.contextLimit > s.inputTokens) {
            result.push({
                key: "free",
                tokens: s.contextLimit - s.inputTokens,
                color: COLORS.free,
                label: "Free",
            })
        }

        return result
    })

    // In compact mode with Free segment, the total is the full context limit
    // so the Free segment gets its proportional share of the bar width.
    const totalTokens = createMemo(() => {
        if (props.compact && props.snapshot.contextLimit && props.snapshot.contextLimit > props.snapshot.inputTokens) {
            return props.snapshot.contextLimit
        }
        return props.snapshot.inputTokens || 1
    })

    // Render-time segments for the bar. Zero-token segments are filtered out
    // entirely (no flex weight, no rendered box) so they don't claim any
    // width. Non-zero segments still get a Math.max(1, ...) floor on
    // flexGrow so very small contributions remain visible as a thin sliver.
    // The legend rows below show every segment (including zeros) for table
    // stability — only the bar prunes them.
    const barSegments = createMemo(() =>
        segments().filter((seg) => seg.tokens > 0),
    )

    return (
        <box width="100%" flexDirection="column">
            {/* Segmented bar: flex row of colored boxes, each with flexGrow
                proportional to its token count and flexBasis=0. opentui
                distributes the parent's full width proportionally so the bar
                always fills the sidebar. In compact mode, wide-enough segments
                show token-count labels centered over their colored box. */}
            <box width="100%" flexDirection="row" height={1}>
                {(props.compact ? barSegments() : barSegments()).map((seg) => {
                    // In compact mode, overlay a label when the segment is
                    // wide enough (≥8% of the total). Free segments get the
                    // "XXK Free" label at ≥12% to accommodate the longer text.
                    const pct = seg.tokens / totalTokens()
                    const showLabel = props.compact && pct >= 0.08 && seg.key !== "free"
                    const showFreeLabel = props.compact && seg.key === "free" && pct >= 0.12

                    if (showFreeLabel) {
                        return (
                            <box
                                key={seg.key}
                                flexGrow={Math.max(1, seg.tokens)}
                                flexBasis={0}
                                height={1}
                                backgroundColor={seg.color}
                                flexDirection="row"
                                alignItems="center"
                                justifyContent="center"
                            >
                                <text fg={props.theme.background}>{`${compactTokens(seg.tokens)} Free`}</text>
                            </box>
                        )
                    }

                    if (showLabel) {
                        return (
                            <box
                                key={seg.key}
                                flexGrow={Math.max(1, seg.tokens)}
                                flexBasis={0}
                                height={1}
                                backgroundColor={seg.color}
                                flexDirection="row"
                                alignItems="center"
                                justifyContent="center"
                            >
                                <text fg={props.theme.background}>{compactTokens(seg.tokens)}</text>
                            </box>
                        )
                    }

                    return (
                        <box
                            key={seg.key}
                            flexGrow={Math.max(1, seg.tokens)}
                            flexBasis={0}
                            height={1}
                            backgroundColor={seg.color}
                        />
                    )
                })}
            </box>

            {/* Legend rows — hidden in compact mode */}
            {!props.compact && (
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
            )}
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

    // Collapse state persisted via KV (survives restarts)
    const COLLAPSED_KV_KEY = "mc-sidebar-collapsed"
    const [collapsed, setCollapsed] = createSignal(
        props.api.kv.get(COLLAPSED_KV_KEY, false) as boolean,
    )
    createEffect(() => {
        props.api.kv.set(COLLAPSED_KV_KEY, collapsed())
    })
    const toggle = () => setCollapsed((x) => !x)

    // Status line for collapsed view (line 3)
    const collapsedStatusLineMemo = createMemo(() => collapsedStatusLine(s()))

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
            {/* Toggle header — collapsed shows compact usage, expanded shows brand */}
            <Show when={collapsed()} fallback={
                <box flexDirection="row" justifyContent="space-between" alignItems="center" onMouseDown={toggle}>
                    <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme.accent}>
                        <text fg={props.theme.background}>
                            <b>▼ Magic Context</b>
                        </text>
                    </box>
                    <text fg={props.theme.textMuted}>v{packageJson.version}</text>
                </box>
            }>
                <Show when={s() && s()!.inputTokens > 0 && (s()?.contextLimit ?? 0) > 0} fallback={
                    <box flexDirection="row" onMouseDown={toggle}>
                        <text fg={props.theme.textMuted}>▶ Magic Context</text>
                    </box>
                }>
                    <box flexDirection="row" width="100%" justifyContent="space-between" onMouseDown={toggle}>
                        <text fg={contextSummaryColor()}>
                            <b>▶</b> {s()!.usagePercentage.toFixed(1)}% / {formatThresholdPercent(s()!.executeThreshold)}%
                        </text>
                        <text fg={contextSummaryColor()}>
                            {compactTokens(s()!.inputTokens)} / {compactTokens(s()!.contextLimit)}
                        </text>
                    </box>
                </Show>
            </Show>

            {/* Collapsed: compact bar + status line */}
            <Show when={collapsed() && s() && s()!.inputTokens > 0}>
                <TokenBreakdown theme={props.theme} snapshot={s()!} compact />
                <text fg={props.theme.textMuted}>{collapsedStatusLineMemo()}</text>
            </Show>

            {/* Expanded: full sidebar content */}
            <Show when={!collapsed()}>
                {/* Token breakdown bar */}
                {s() && s()!.inputTokens > 0 && (
                    <box marginTop={1} flexDirection="column">
                        {(s()?.contextLimit ?? 0) > 0 && (
                            <box width="100%" flexDirection="row" justifyContent="space-between">
                                {/* Left: current usage vs the per-model execute
                                    threshold (the value Magic Context compares
                                    against when scheduling historian / drops).
                                    "47.5% / 65%" tells the user how close they
                                    are to the next compaction trigger. */}
                                <text fg={contextSummaryColor()}>
                                    <b>{s()!.usagePercentage.toFixed(1)}%</b> / {formatThresholdPercent(s()!.executeThreshold)}%
                                </text>
                                {/* Right: absolute token usage vs the model's
                                    full context window (separate from the
                                    execute threshold so users still know how
                                    much headroom remains beyond compaction). */}
                                <text fg={contextSummaryColor()}>
                                    {compactTokens(s()!.inputTokens)} / {compactTokens(s()!.contextLimit)}
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

                {/* Stats — v0.21.8 ships a single "Total tokens" number while we
                    figure out how to present the new-work / reprocessed
                    categorization without confusing users. The underlying
                    snapshot fields (newWorkTokens, totalInputTokens) and the
                    session_meta columns are still populated; only the UI is
                    simplified for now. */}
                {s()?.totalInputTokens != null && (
                    <>
                        <SectionHeader theme={props.theme} title="Stats" />
                        <StatRow
                            theme={props.theme}
                            label="Total tokens"
                            value={compactTokens(s()!.totalInputTokens ?? 0)}
                            dim
                        />
                    </>
                )}
            </Show>
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
