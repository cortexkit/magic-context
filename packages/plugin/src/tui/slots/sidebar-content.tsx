/** @jsxImportSource @opentui/solid */
import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { TuiSlotPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import packageJson from "../../../package.json"
import { loadSidebarSnapshot, type SidebarSnapshot } from "../data/context-db"
import { formatThresholdPercent } from "../../shared/format-threshold"
import {
    computeEffectiveOrder,
    DEFAULT_SLOT_ORDER,
    type MagicContextTuiPrefs,
    PLUGIN_KEY,
    queueTuiPreferenceUpdate,
    readTuiPreferencesFile,
    readTuiPreferencesFileSync,
    resolveMagicContextPrefs,
    watchTuiPreferences,
} from "../../shared/tui-preferences"

// Module-level hook so the upgrade/recomp dialog can kick the sidebar into its
// fast recomp self-poll the INSTANT the user confirms — without waiting for a
// parent-session message event (the RPC upgrade/recomp call fires none). The
// mounted SidebarContent registers its refresh here.
let activeRecompPollKick: (() => void) | null = null
export function kickRecompProgressRefresh(): void {
    activeRecompPollKick?.()
}

const SINGLE_BORDER = { type: "single" } as any
const REFRESH_DEBOUNCE_MS = 150

export interface SidebarController {
    prefs: () => MagicContextTuiPrefs
    collapsed: () => boolean
    toggleCollapsed: () => void
}

// The TUI may unmount and remount sidebar_content when the user switches views
// (main -> subagent -> main). A remount re-runs the component body, so a signal
// created inside the component would reset to its seed. The controller lives in
// the slot-factory closure (plugin/process lifetime) and owns the durable
// prefs/collapse signals plus the single shared file watcher, so collapse state
// and live pref reloads survive remounts. No Solid effects/memos here — those
// need an owner; the poll-interval effect stays inside the component.
function createSidebarController(initialPrefs: MagicContextTuiPrefs): SidebarController {
    const [prefs, setPrefs] = createSignal<MagicContextTuiPrefs>(initialPrefs)
    const seedCollapsed =
        initialPrefs.rememberCollapsed && initialPrefs.collapsed != null
            ? initialPrefs.collapsed
            : initialPrefs.startCollapsed
    const [collapsed, setCollapsed] = createSignal(seedCollapsed)
    let lastPersistedCollapsed: boolean | null = initialPrefs.collapsed
    let lastApplied = JSON.stringify(initialPrefs)

    // Watcher lives for the process lifetime — intentionally never disposed.
    // Collapse echo guard: lastPersistedCollapsed advances only once our own
    // write lands, so a watcher echo of the value we just wrote is rejected by
    // the `!==` check and cannot revert a user click.
    watchTuiPreferences(() => {
        void (async () => {
            const next = resolveMagicContextPrefs(await readTuiPreferencesFile())
            const serialized = JSON.stringify(next)
            if (serialized === lastApplied) return
            lastApplied = serialized
            setPrefs(next)
            if (
                next.rememberCollapsed &&
                next.collapsed != null &&
                next.collapsed !== lastPersistedCollapsed
            ) {
                lastPersistedCollapsed = next.collapsed
                setCollapsed(next.collapsed)
            }
        })()
    })

    function toggleCollapsed() {
        const next = !collapsed()
        setCollapsed(next)
        if (prefs().rememberCollapsed) {
            void queueTuiPreferenceUpdate(PLUGIN_KEY, ["collapsed"], next).then(() => {
                lastPersistedCollapsed = next
            })
        }
    }

    return { prefs, collapsed, toggleCollapsed }
}

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

// Text progress bar, e.g. [██████░░░░] for the recomp/upgrade live indicator.
function progressBar(fraction: number, width = 14): string {
    const clamped = Math.max(0, Math.min(1, fraction))
    const filled = Math.round(clamped * width)
    return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`
}

// Token breakdown segment colors (hardcoded hex values)
const COLORS = {
    // Cool / structured — injected by the plugin into message[0]
    system: "#c084fc", // Purple
    docs: "#22d3ee", // Cyan — <project-docs>
    compartments: "#60a5fa", // Blue
    facts: "#fbbf24", // Yellow/orange
    memories: "#34d399", // Green
    profile: "#a3e635", // Lime — <user-profile>
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
    // Collapsed mode renders only the proportional bar (no per-category legend
    // rows) so the sidebar shrinks to the progress bar + a few summary lines.
    collapsed?: boolean
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

        // Docs (cyan) — injected <project-docs> block (ARCHITECTURE/STRUCTURE)
        if (s.docsTokens > 0) {
            result.push({
                key: "docs",
                tokens: s.docsTokens,
                color: COLORS.docs,
                label: "Docs",
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

        // User Profile (lime) — injected <user-profile> block (promoted user memories)
        if (s.profileTokens > 0) {
            result.push({
                key: "profile",
                tokens: s.profileTokens,
                color: COLORS.profile,
                label: "User Profile",
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

        return result
    })

    const totalTokens = createMemo(() => props.snapshot.inputTokens || 1)

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
            {/* Segmented bar: a width="100%" flex row of colored boxes,
                each with flexGrow proportional to its token count and
                flexBasis=0. opentui distributes the parent's full width
                proportionally, so the bar always fills the sidebar
                regardless of terminal size. Height is fixed at 1 row;
                backgroundColor renders the colored bar. */}
            <box width="100%" flexDirection="row" height={1}>
                {barSegments().map((seg) => (
                    <box
                        key={seg.key}
                        flexGrow={Math.max(1, seg.tokens)}
                        flexBasis={0}
                        height={1}
                        backgroundColor={seg.color}
                    />
                ))}
            </box>

            {/* Legend rows — suppressed in collapsed mode (bar only) */}
            {!props.collapsed && (
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

// Live recomp / session-upgrade progress. Renders while an upgrade runs (and
// briefly after it finishes) so a multi-minute rebuild is visible instead of a
// single missed toast (dogfood 2026-05-30).
const RecompProgressSection = (props: {
    theme: TuiThemeCurrent
    progress: NonNullable<SidebarSnapshot["recompProgress"]>
}) => {
    // CRITICAL: read `props.progress` reactively on every access — do NOT
    // destructure it into a local `const p = props.progress` at creation time.
    // The parent keeps THIS component instance mounted as the phase advances
    // (recomp → migration → done), so a frozen `p` would render the
    // creation-time phase forever — the sidebar stuck on "upgrading / Running
    // historian (pass 1)…" even though the upgrade finished. Each accessor below
    // tracks the parent signal so the label/bar/note update live (root cause of
    // the dogfood 2026-05-30 "recomp upgrading stays" freeze).
    const phase = () => props.progress.phase
    const fraction = () =>
        props.progress.totalMessages > 0
            ? props.progress.processedMessages / props.progress.totalMessages
            : 0
    const pct = () => Math.round(fraction() * 100)

    // "Recomp" vs "Upgrade" vs "Embed" wording follows the flow that started this
    // run, so a plain /ctx-recomp never renders as an "Upgrade" (dogfood 2026-06-04).
    const verb = () =>
        props.progress.kind === "upgrade"
            ? "Upgrade"
            : props.progress.kind === "embed"
              ? "Embed"
              : "Recomp"
    const activeText = () =>
        props.progress.kind === "upgrade"
            ? "upgrading ⟳"
            : props.progress.kind === "embed"
              ? "embedding ⟳"
              : "comparting ⟳"
    const label = createMemo(() => {
        switch (props.progress.phase) {
            case "recomp":
                return {
                    text: activeText(),
                    color: props.theme.warning,
                }
            case "migration":
                return { text: "Migrating memories ⟳", color: props.theme.warning }
            case "done":
                return { text: `✓ ${verb()} complete`, color: props.theme.success ?? props.theme.accent }
            case "skipped":
                // Neutral terse status next to the bold verb header; the full,
                // self-contained reason (lease-busy "try again shortly" vs a
                // partial-stall "run /ctx-embed start again") renders on its own
                // line below. Don't re-prepend verb here (it's already the bold
                // header — doing so read as "EmbedEmbed"), and don't hardcode
                // "retry shortly" (wrong for a partial stall).
                return { text: "stopped", color: props.theme.textMuted }
            case "failed":
                return { text: `✗ ${verb()} failed`, color: props.theme.error }
        }
    })

    return (
        <>
            <box width="100%" marginTop={1} flexDirection="row" justifyContent="space-between">
                <text fg={props.theme.text}>
                    <b>{verb()}</b>
                </text>
                <text fg={label().color}>{label().text}</text>
            </box>
            {/* Determinate bar during the compartment-rebuild phase. */}
            {phase() === "recomp" && props.progress.totalMessages > 0 && (
                <box width="100%" flexDirection="row" justifyContent="space-between">
                    <text fg={props.theme.accent}>{progressBar(fraction())}</text>
                    <text fg={props.theme.textMuted}>{pct()}%</text>
                </box>
            )}
            {/* Transient status note (e.g. "Starting…", "Trying fallback
                sonnet-4-6…", "Repair retry…") — surfaces live activity during a
                long pass, including before the determinate range is known. */}
            {(phase() === "recomp" || phase() === "migration") && props.progress.note && (
                <text fg={props.theme.textMuted}>{props.progress.note}</text>
            )}
            {phase() === "recomp" && props.progress.kind !== "embed" && (
                <StatRow
                    theme={props.theme}
                    label="Compartments"
                    value={`${props.progress.compartmentsCreated} (${props.progress.passCount} pass${props.progress.passCount === 1 ? "" : "es"})`}
                    dim
                />
            )}
            {phase() === "recomp" && props.progress.kind === "embed" && (
                <StatRow
                    theme={props.theme}
                    label="Compartments"
                    value={`${props.progress.processedMessages}/${props.progress.totalMessages} embedded`}
                    dim
                />
            )}
            {/* Terminal reason (failed/skipped) — kept visible so the user sees
                WHY (a failure, or the transient "retry shortly" skip cause). */}
            {(phase() === "failed" || phase() === "skipped") && props.progress.message && (
                <text fg={props.theme.textMuted}>{props.progress.message}</text>
            )}
        </>
    )
}

const SidebarContent = (props: {
    api: TuiPluginApi
    sessionID: () => string
    theme: TuiThemeCurrent
    controller: SidebarController
}) => {
    const [snapshot, setSnapshot] = createSignal<SidebarSnapshot | null>(null)
    // Collapse state + section visibility prefs live in the controller (plugin
    // closure), so they survive view-switch remounts and persist across restarts
    // via ~/.config/opencode/tui-preferences.jsonc. Read reactively.
    const collapsed = props.controller.collapsed
    const sections = () => props.controller.prefs().sections
    const headerLabel = () => props.controller.prefs().header.label
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    // Self-sustaining poll while a recomp/upgrade is running. Recomp work
    // happens in CHILD sessions whose message events are filtered out of the
    // subscription below, so without this the progress bar would freeze until
    // the next parent-session message. Active only during recomp/migration;
    // stops itself once the phase goes terminal/absent (dogfood 2026-05-30).
    let recompPollTimer: ReturnType<typeof setTimeout> | undefined
    const RECOMP_POLL_MS = 1200
    // Robust recomp poll state. The loop MUST survive a failed/slow snapshot
    // fetch — the server is busy doing the historian LLM call during a recomp,
    // so a poll can reject or return a stale (pre-recomp) cached snapshot. The
    // OLD loop reattached the next timer only inside `.then()`, so any rejection
    // killed it and the bar froze mid-pass (dogfood 2026-05-30). This version
    // reschedules on BOTH success and failure, keyed on `recompActive`, and only
    // stops on a terminal phase, a bounded "never started" probe window, or the
    // entry vanishing after we'd seen it active.
    let recompActive = false
    let recompSawPhase = false
    let recompPollCount = 0
    let recompConsecutiveAbsent = 0
    const RECOMP_PROBE_MAX = 12 // ~15s for the server's "Starting…" to land
    // After we've SEEN an active phase, a momentarily absent snapshot is almost
    // always transient — the server's sticky cache serves a pre-recomp snapshot
    // (no recompProgress) during the token-quiet recomp window, or a concurrent
    // BEGIN-IMMEDIATE publish makes the snapshot DB read throw → bare empty. The
    // entry is held until terminal + a 30s grace, so we keep polling through many
    // absents and only give up after a long run of them (entry truly gone but we
    // somehow missed "done"). This was the freeze: the old logic stopped on the
    // FIRST absent-after-active (dogfood 2026-05-30).
    const RECOMP_ABSENT_GIVEUP = 40 // ~48s of continuous absence → stop
    const RECOMP_MAX_POLLS = 1500 // ~30min absolute safety cap

    const refresh = () => {
        const sid = props.sessionID()
        if (!sid) return
        const directory = props.api.state.path.directory ?? ""
        void loadSidebarSnapshot(sid, directory)
            .then((data) => {
                setSnapshot(data)
                try {
                    props.api.renderer.requestRender()
                } catch {
                    // Ignore render errors
                }
                // If a recomp/upgrade is running (detected via any refresh, e.g.
                // a /ctx-recomp command not started from the dialog), make sure
                // the dedicated poll loop is running.
                const phase = data?.recompProgress?.phase
                if ((phase === "recomp" || phase === "migration") && !recompActive) {
                    kickRecompPoll()
                }
            })
            .catch(() => {
                // one-shot refresh failure is non-fatal; the recomp loop (if any)
                // has its own resilient retry.
            })
    }

    const scheduleRefresh = () => {
        if (refreshTimer) clearTimeout(refreshTimer)
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined
            refresh()
        }, REFRESH_DEBOUNCE_MS)
    }

    const scheduleRecompTick = () => {
        if (!recompActive) return
        if (recompPollTimer) clearTimeout(recompPollTimer)
        recompPollTimer = setTimeout(recompTick, RECOMP_POLL_MS)
    }

    function recompTick(): void {
        if (!recompActive) return
        recompPollCount += 1
        if (recompPollCount > RECOMP_MAX_POLLS) {
            recompActive = false
            return
        }
        const sid = props.sessionID()
        if (!sid) {
            recompActive = false
            return
        }
        const directory = props.api.state.path.directory ?? ""
        void loadSidebarSnapshot(sid, directory)
            .then((data) => {
                const phase = data?.recompProgress?.phase
                // While a recomp is known-active, a transient snapshot that lost
                // recompProgress (sticky cache / busy-DB empty) must NOT wipe the
                // visible bar — carry the last good progress forward so it stays
                // stable until a real update or the terminal state lands.
                const prevProgress = snapshot()?.recompProgress
                const merged =
                    !phase && recompSawPhase && prevProgress
                        ? { ...data, recompProgress: prevProgress }
                        : data
                setSnapshot(merged)
                try {
                    props.api.renderer.requestRender()
                } catch {
                    // ignore render errors
                }
                if (phase === "recomp" || phase === "migration") {
                    recompSawPhase = true
                    recompConsecutiveAbsent = 0
                    scheduleRecompTick()
                } else if (phase === "done" || phase === "failed" || phase === "skipped") {
                    // Terminal state rendered — stop. The server keeps "done"/
                    // "skipped" for a grace window and "failed" until the next run,
                    // so the outcome stays visible without further polling.
                    recompActive = false
                } else {
                    // Phase absent this poll.
                    recompConsecutiveAbsent += 1
                    if (!recompSawPhase) {
                        // Still waiting for the server's first "Starting…".
                        if (recompPollCount < RECOMP_PROBE_MAX) scheduleRecompTick()
                        else {
                            recompActive = false
                        }
                    } else if (recompConsecutiveAbsent < RECOMP_ABSENT_GIVEUP) {
                        // Seen it active — absent is almost certainly the sticky
                        // cache / a transient snapshot read. Keep polling so we
                        // still catch the terminal state. DON'T overwrite the
                        // last good progress snapshot with this transient empty.
                        scheduleRecompTick()
                    } else {
                        // Long continuous absence — the entry is genuinely gone.
                        recompActive = false
                    }
                }
            })
            .catch((err) => {
                // CRITICAL: a failed/slow fetch must NOT kill the loop — keep
                // polling while active so we still catch the terminal state.
                scheduleRecompTick()
            })
    }

    // Kick the resilient recomp poll loop on dialog confirm (or when a refresh
    // first detects an active recomp). The server emits an immediate "Starting…"
    // entry; the probe window covers the brief RPC race before it lands.
    function kickRecompPoll(): void {
        if (recompActive) return // already running
        recompActive = true
        recompSawPhase = false
        recompPollCount = 0
        recompConsecutiveAbsent = 0
        recompTick()
    }

    activeRecompPollKick = kickRecompPoll

    onCleanup(() => {
        if (refreshTimer) clearTimeout(refreshTimer)
        if (recompPollTimer) clearTimeout(recompPollTimer)
        recompActive = false
        if (activeRecompPollKick === kickRecompPoll) activeRecompPollKick = null
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
            {/* Header: triangle toggle + badge + version. Clicking the row
                collapses/expands the panel (mirrors OpenCode's native MCP
                sidebar section and AFT's sidebar). */}
            <box
                flexDirection="row"
                justifyContent="space-between"
                alignItems="center"
                onMouseDown={() => props.controller.toggleCollapsed()}
            >
                <box paddingLeft={1} paddingRight={1} backgroundColor={props.theme.accent}>
                    <text fg={props.theme.background}>
                        <b>{collapsed() ? "▶ " : "▼ "}{headerLabel()}</b>
                    </text>
                </box>
                <text fg={props.theme.textMuted}>v{packageJson.version}</text>
            </box>

            {/* Token breakdown bar. In collapsed mode the header, bar and the
                3 summary rows stack with no vertical padding for a compact look;
                expanded mode keeps the 1-row gap above the bar. */}
            {s() && s()!.inputTokens > 0 && (
                <box marginTop={collapsed() ? 0 : 1} flexDirection="column">
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
                    <TokenBreakdown theme={props.theme} snapshot={s()!} collapsed={collapsed()} />
                </box>
            )}

            {/* Collapsed view — progress bar (above) + 3 summary lines:
                Historian (with compartment count), Memories (injected/total),
                Status (Q=queued ops, N=session notes). */}
            {collapsed() && (
                <box width="100%" flexDirection="column">
                    {/* Collapsed rows are intentionally uniform faded-grey, not
                        bold/accent — they're a glanceable summary, so the label
                        and value share the muted tone (matches Memories row). */}
                    <box width="100%" flexDirection="row" justifyContent="space-between">
                        <text fg={props.theme.textMuted}>Historian</text>
                        {s()?.historianRunning ? (
                            <text fg={props.theme.warning}>comparting ⟳</text>
                        ) : (
                            <text fg={props.theme.textMuted}>idle</text>
                        )}
                    </box>
                    <box width="100%" flexDirection="row" justifyContent="space-between">
                        <text fg={props.theme.textMuted}>Memories</text>
                        <text fg={props.theme.textMuted}>
                            {(s()?.memoryBlockCount ?? 0) > 0
                                ? `${s()!.memoryBlockCount}/${s()?.memoryCount ?? 0}`
                                : String(s()?.memoryCount ?? 0)}
                        </text>
                    </box>
                    <box width="100%" flexDirection="row" justifyContent="space-between">
                        <text fg={props.theme.textMuted}>Status</text>
                        <text fg={props.theme.textMuted}>
                            C:{s()?.compartmentCount ?? 0} Q:{s()?.pendingOpsCount ?? 0} N:{s()?.sessionNoteCount ?? 0}
                        </text>
                    </box>
                    <Show when={s()?.recompProgress}>
                        {(progress) => (
                            <RecompProgressSection theme={props.theme} progress={progress()} />
                        )}
                    </Show>
                </box>
            )}

            {/* Expanded view — full section grid. */}
            {!collapsed() && (
                <>
            {/* Historian section */}
            {sections().historian && (
                <>
            <box width="100%" marginTop={1} flexDirection="row" justifyContent="space-between">
                <text fg={props.theme.text}>
                    <b>Historian</b>
                </text>
                {s()?.historianRunning ? (
                    <text fg={props.theme.warning}>comparting ⟳</text>
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

            {/* Recomp / session-upgrade live progress */}
            <Show when={s()?.recompProgress}>
                {(progress) => (
                    <RecompProgressSection theme={props.theme} progress={progress()} />
                )}
            </Show>
                </>
            )}

            {/* Memory section */}
            {sections().memory && (
                <>
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
                </>
            )}

            {/* Queue & Status */}
            {sections().status &&
                ((s()?.pendingOpsCount ?? 0) > 0 ||
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
            {sections().dreamer && s()?.lastDreamerRunAt && (
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
            {sections().stats && s()?.totalInputTokens != null && (
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
                </>
            )}
        </box>
    )
}

export function createSidebarContentSlot(api: TuiPluginApi): TuiSlotPlugin {
    // Seed synchronously at slot construction so the sidebar renders at its
    // final collapse state + order on the first paint (no async flicker). The
    // controller lives here in the factory closure for the plugin lifetime, so
    // collapse state and live pref reloads survive sidebar_content remounts.
    const seedRoot = readTuiPreferencesFileSync()
    const controller = createSidebarController(resolveMagicContextPrefs(seedRoot))
    const effectiveOrder = computeEffectiveOrder(seedRoot, PLUGIN_KEY, DEFAULT_SLOT_ORDER)
    return {
        order: effectiveOrder,
        slots: {
            sidebar_content: (ctx, value) => {
                const theme = createMemo(() => ctx.theme.current)
                return (
                    <SidebarContent
                        api={api}
                        sessionID={() => value.session_id}
                        theme={theme()}
                        controller={controller}
                    />
                )
            },
        },
    }
}
