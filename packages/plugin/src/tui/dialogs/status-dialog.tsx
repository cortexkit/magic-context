/** @jsxImportSource @opentui/solid */
// @ts-nocheck
/**
 * The `/ctx-status` dialog: one view, drawn from the shared status model.
 *
 * It lives in its own module so both host generations can mount the same
 * component. OpenCode 1 imports it from here; OpenCode 2 loads the compiled
 * copy (`src/tui-compiled/dialogs/status-dialog.tsx`) through the host's
 * OpenTUI runtime registry and mounts it on its dialog surface, the same
 * arrangement `src/v2/tui/sidebar-mount.ts` uses for the sidebar.
 */
import { createMemo, createSignal, onCleanup } from "solid-js"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import packageJson from "../../../package.json"
import { pausedRecompReason } from "../../shared/recomp-outcome"
import {
    buildStatusViewFor,
    distributeBarWidths,
    statusColumnsFor,
    type StatusRow,
    type StatusSection,
    type StatusTone,
} from "../../shared/status-view"
import { RUST_MODE_HOST_PATHS_LINE } from "../../shared/rust-mode-status"
import type { StatusDetailResult } from "../data/context-db"

const R = (props: { t: TuiThemeCurrent; l: string; v: string; fg?: string }) => (
    <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={props.t.textMuted}>{props.l}</text>
        <text fg={props.fg ?? props.t.text}>{props.v}</text>
    </box>
)

/**
 * Resolves a shared status tone against this host's theme. Every row in the
 * status dialog passes through here: a row drawn without an explicit colour
 * takes the terminal's default foreground, which on a light theme is the same
 * colour as the dialog background and reads as a blank page.
 */
function toneColor(theme: TuiThemeCurrent, tone: StatusTone): string {
    if (tone === "accent") return theme.accent
    if (tone === "muted") return theme.textMuted
    if (tone === "warning") return theme.warning
    if (tone === "error") return theme.error
    return theme.text
}

/**
 * Width the dialog is actually laid out at, which is NOT the terminal width:
 * each host sizes its own dialog surface (OpenCode 1's default is 60 columns,
 * OpenCode 2's widest is 88 columns on a 200-column terminal), and that is the
 * width the sections have to fit into. Renderables carry their laid-out width
 * and emit "resize" when a layout pass changes it, so the component reads it
 * from its own root box. ("resized", with a d, is emitted only by the
 * renderer's root; a box never sends it, and listening for it left the dialog
 * sizing its sections from the terminal width forever.)
 *
 * Until the first layout there is no width to read; the terminal width is the
 * fallback, and an unknown terminal keeps the wide layout the dialog has always
 * drawn rather than collapsing on a guess.
 */
function terminalColumns(): number {
    const columns = process.stdout?.columns
    return typeof columns === "number" && columns > 0 ? columns : Number.POSITIVE_INFINITY
}

/** One label/value row, with the label column fixed so labels never wrap mid-word. */
const StatusRowView = (props: { t: TuiThemeCurrent; row: StatusRow; labelWidth: number }) => (
    <box width="100%" flexDirection="row" justifyContent="space-between" gap={1}>
        <box width={props.labelWidth} flexShrink={0}>
            <text fg={props.t.textMuted}>{props.row.label}</text>
        </box>
        <text fg={toneColor(props.t, props.row.tone)}>{props.row.value}</text>
    </box>
)

const StatusSectionView = (props: { t: TuiThemeCurrent; section: StatusSection }) => (
    <box flexDirection="column" width="100%" marginTop={1}>
        <text fg={props.t.text}>
            <b>{props.section.title}</b>
        </text>
        {props.section.rows.map((row) => (
            <StatusRowView t={props.t} row={row} labelWidth={props.section.labelWidth} />
        ))}
    </box>
)

/**
 * `status` is the checked result of the status RPC (`loadStatusDetail`), never
 * the raw reply: a reply the view cannot draw arrives as the reason it cannot,
 * and the shared model turns that into a "status unavailable" view. An
 * unchecked reply used to reach the view model directly, where a missing field
 * threw inside this component's first render and crashed the whole TUI.
 */
export const StatusDialog = (props: { api: TuiPluginApi; status: StatusDetailResult }) => {
    const theme = createMemo(() => (props.api as any).theme.current)
    const t = () => theme()
    const ready = () => (props.status.state === "ready" ? props.status : null)
    const compactionOff = () => ready()?.source.compaction_enabled === false
    const recompProgress = () => ready()?.extras.recompProgress ?? null
    const hostBackendsModuleSide = () => ready()?.extras.hostBackendsModuleSide === true

    // Which rows exist, what they are called and which colour they carry is
    // decided by the shared model, so this dialog and Pi's overlay cannot drift
    // apart. This component only draws what the model returns, and the model
    // never throws: a result it cannot draw becomes the unavailable view.
    const view = createMemo(() =>
        buildStatusViewFor(props.status, { version: packageJson.version }),
    )
    // The dialog's own laid-out width, which is what the sections have to fit
    // into; the terminal width is only the pre-layout fallback.
    const [dialogWidth, setDialogWidth] = createSignal(0)
    const measureRoot = (element: any) => {
        const read = () => {
            const width = Number(element?.width)
            if (Number.isFinite(width) && width > 0) setDialogWidth(width)
        }
        read()
        element?.on?.("resize", read)
        onCleanup(() => element?.off?.("resize", read))
    }
    // paddingLeft + paddingRight below; what the sections get is what is left.
    const contentWidth = () => (dialogWidth() > 0 ? dialogWidth() - 4 : terminalColumns())
    // The shared model decides whether the sections fit in two columns at this
    // width, and how wide each column has to be; below that the same sections
    // are drawn in one column, in the same order, instead of being squeezed
    // into mid-word wraps.
    const columns = () => statusColumnsFor(view().sections, contentWidth())
    const columnSections = (parity: number) =>
        view().sections.filter((_section, index) => index % 2 === parity)
    const hygiene = () => view().hygiene
    // Integer segment widths that sum to the bar's own width. Proportional
    // flexGrow lets the layout engine round each segment on its own, which
    // leaves blank cells between the coloured runs; the shared helper
    // distributes the remainder so the bar has no gaps. Before the first
    // layout there is no width to divide, so the flex fallback stays.
    const barWidths = () => {
        const width = contentWidth()
        if (!Number.isFinite(width) || width <= 0) return null
        return distributeBarWidths(
            view().bar.map((segment) => segment.tokens),
            width,
        )
    }

    return (
        <box ref={measureRoot} flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            {/* Title */}
            <box justifyContent="center" width="100%" marginBottom={1} flexDirection="row" gap={2}>
                <text fg={t().accent}><b>{view().title}</b></text>
                <text fg={t().textMuted}>{view().version}</text>
            </box>

            <box flexDirection="row" justifyContent="space-between" width="100%">
                <text fg={toneColor(t(), view().headline.left.tone)}>
                    <b>{view().headline.left.text}</b>
                </text>
                <text fg={toneColor(t(), view().headline.right.tone)}>
                    {view().headline.right.text}
                </text>
            </box>
            {view().windowLine && <text fg={t().textMuted}>{view().windowLine}</text>}

            {/* Segmented breakdown bar: a flex row of colored boxes filling the
                dialog width. Once the dialog has a laid-out width the shared
                helper hands each segment an integer width that sums to the bar
                width, so no blank cell can appear between the runs; before the
                first layout the flex weights stand in. */}
            <box width="100%" flexDirection="row" height={1}>
                {view().bar.map((seg, index) => {
                    const widths = barWidths()
                    const fixed = widths ? (widths[index] ?? 0) : undefined
                    return (
                        <box
                            key={seg.label}
                            {...(fixed === undefined
                                ? { flexGrow: Math.max(1, seg.tokens), flexBasis: 0 }
                                : { width: fixed, flexShrink: 0 })}
                            height={1}
                            backgroundColor={seg.color}
                        />
                    )
                })}
            </box>

            {/* Breakdown legend */}
            <box flexDirection="column" width="100%">
                {view().breakdown.map((row) => (
                    <box key={row.label} width="100%" flexDirection="row" justifyContent="space-between" gap={1}>
                        <text fg={row.color}>{row.label}</text>
                        <text fg={t().textMuted}>{row.value}</text>
                    </box>
                ))}
                {hygiene() && (
                    <StatusRowView t={t()} row={hygiene()} labelWidth={9} />
                )}
            </box>

            {/* Recomp live progress (full width, only while
                running or just finished — dogfood 2026-05-30). This is live run
                state rather than status content, so it stays out of the shared
                section model. */}
            {!compactionOff() && recompProgress() && (() => {
                const p = recompProgress()!
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
                        const paused = pausedRecompReason(p.message)
                        if (paused !== null) return <R t={t()} l="Status" v={`${verb} paused: ${paused}`} fg={t().warning} />
                        return <R t={t()} l="Status" v={`✗ ${verb} failed${p.message ? `: ${p.message}` : ""}`} fg={t().error} />
                    })()}
                </box>
                )
            })()}

            {hostBackendsModuleSide() && (
                <box marginTop={1} width="100%" flexDirection="column">
                    <text fg={t().text}><b>Rust Mode</b></text>
                    <text fg={t().textMuted}>{RUST_MODE_HOST_PATHS_LINE}</text>
                </box>
            )}

            {/* Each column asks for the width its sections need, but may
                shrink: until the dialog has measured itself the grid is chosen
                against the terminal width, and a column that could not shrink
                would then run past the dialog's right edge. Shrinking wraps a
                value inside its column instead, and anything still wider
                than a squeezed column (a fixed-width label) is clipped at the
                column's edge rather than drawn past the dialog. The request is
                a flexBasis, not a width: OpenTUI turns flexShrink back to 0
                whenever a box gets a numeric width, so a fixed-width column
                never shrinks. */}
            {columns().twoColumn ? (
                <box flexDirection="row" width="100%" gap={4}>
                    <box flexDirection="column" flexBasis={columns().leftWidth} flexGrow={0} flexShrink={1} minWidth={0} overflow="hidden">
                        {columnSections(0).map((section) => (
                            <StatusSectionView t={t()} section={section} />
                        ))}
                    </box>
                    <box flexDirection="column" flexBasis={columns().rightWidth} flexGrow={0} flexShrink={1} minWidth={0} overflow="hidden">
                        {columnSections(1).map((section) => (
                            <StatusSectionView t={t()} section={section} />
                        ))}
                    </box>
                </box>
            ) : (
                <box flexDirection="column" width="100%">
                    {view().sections.map((section) => (
                        <StatusSectionView t={t()} section={section} />
                    ))}
                </box>
            )}

            {view().warnings.length > 0 && (
                <box marginTop={1} width="100%" flexDirection="column">
                    {view().warnings.map((warning) => (
                        <text fg={warning.tone === "error" ? t().error : t().warning}>{warning.text}</text>
                    ))}
                </box>
            )}

            {/* Footer */}
            <box marginTop={1} justifyContent="flex-end" width="100%">
                <text fg={t().textMuted}>{view().footer}</text>
            </box>
        </box>
    )
}

