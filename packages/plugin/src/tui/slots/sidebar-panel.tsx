/** @jsxImportSource @opentui/solid */
import { Index, Show } from "solid-js"
import {
    type SidebarAppearance,
    SidebarFrame,
    SidebarGaugeRow,
    SidebarSection,
    SidebarStatRow,
    SidebarTextRow,
    type SidebarTheme,
} from "../vendor/opencode-sidebar"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { badgeTextColor } from "../badge-contrast"
import type { GaugeRowView, SidebarView, StatRowView } from "./sidebar-view"

// Every gauge row passes this session's own thresholds, so these defaults only
// fill the frame's required appearance.
const APPEARANCE: SidebarAppearance = {
    barWidth: 10,
    barFilledChar: "█",
    barEmptyChar: "░",
    warnThreshold: 50,
    errorThreshold: 80,
}

/** The host theme in the shared frame's colour names. */
export function sidebarTheme(
    theme: Pick<
        TuiThemeCurrent,
        "text" | "textMuted" | "accent" | "success" | "warning" | "error" | "borderActive" | "background"
    >,
): SidebarTheme {
    return {
        text: theme.text,
        textMuted: theme.textMuted,
        accent: theme.accent,
        success: theme.success,
        warning: theme.warning,
        error: theme.error,
        borderActive: theme.borderActive,
        // The frame draws the badge label in `background` on `accent`; pick a
        // label colour that stays readable when the two are too close.
        background: badgeTextColor(theme.accent, theme.background),
    }
}

function StatRows(props: { rows: StatRowView[] }) {
    return (
        <Index each={props.rows}>
            {(row) => <SidebarStatRow label={row().label} value={row().value} tone={row().tone} />}
        </Index>
    )
}

function Gauge(props: { gauge: GaugeRowView }) {
    return (
        <SidebarGaugeRow
            label={props.gauge.label}
            used={props.gauge.used}
            value={props.gauge.value}
            warnAt={props.gauge.warnAt}
            errorAt={props.gauge.errorAt}
        />
    )
}

/** The collapsed panel's one row: a stat row ending in a status dot. */
function Summary(props: { row: StatRowView; theme: SidebarTheme }) {
    return (
        <box width="100%" flexDirection="row" columnGap={1}>
            <box flexGrow={1}>
                <SidebarStatRow label={props.row.label} value={props.row.value} />
            </box>
            <text fg={props.theme.success}>●</text>
        </box>
    )
}

export interface SidebarPanelProps {
    view: SidebarView
    collapsed: boolean
    onToggle: () => void
    theme: SidebarTheme
    label: string
    version: string
    now: number
}

/** Draws a decided {@link SidebarView} in the shared CortexKit sidebar frame. */
export function SidebarPanel(props: SidebarPanelProps) {
    return (
        <SidebarFrame
            header={{ badge: props.label, version: props.version }}
            accounts={[]}
            theme={props.theme}
            appearance={APPEARANCE}
            showQuota={false}
            now={props.now}
            collapsed={props.collapsed}
            collapsible={true}
            onToggle={props.onToggle}
            sections={() => (
                <>
                    <Show when={props.view.context}>
                        {(context) => (
                            <SidebarSection title="Context">
                                <Show when={context().gauge}>{(gauge) => <Gauge gauge={gauge()} />}</Show>
                                <StatRows rows={context().rows} />
                            </SidebarSection>
                        )}
                    </Show>
                    <Show when={props.view.history}>
                        {(rows) => (
                            <SidebarSection title="History">
                                <StatRows rows={rows()} />
                            </SidebarSection>
                        )}
                    </Show>
                    <Show when={props.view.progress}>
                        {(progress) => (
                            <SidebarSection title={progress().title}>
                                <StatRows rows={progress().rows} />
                                <Show when={progress().gauge}>{(gauge) => <Gauge gauge={gauge()} />}</Show>
                                <Index each={progress().notes}>
                                    {(note) => <SidebarTextRow text={note()} />}
                                </Index>
                            </SidebarSection>
                        )}
                    </Show>
                    <Show when={props.view.cache}>
                        {(rows) => (
                            <SidebarSection title="Prompt cache">
                                <StatRows rows={rows()} />
                            </SidebarSection>
                        )}
                    </Show>
                    <Show when={props.view.knowledge}>
                        {(rows) => (
                            <SidebarSection title="Knowledge">
                                <StatRows rows={rows()} />
                            </SidebarSection>
                        )}
                    </Show>
                </>
            )}
            collapsedSections={() => <Summary row={props.view.summary} theme={props.theme} />}
        />
    )
}
