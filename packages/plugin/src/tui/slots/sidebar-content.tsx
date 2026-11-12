/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi, TuiSlotPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import packageJson from "../../../package.json";
import { formatThresholdPercent } from "../../shared/format-threshold";
import {
    computeEffectiveOrder,
    DEFAULT_PREFS,
    DEFAULT_SLOT_ORDER,
    type MagicContextTuiPrefs,
    PLUGIN_KEY,
    queueTuiPreferenceUpdate,
    readTuiPreferencesFile,
    readTuiPreferencesFileSync,
    resolveMagicContextPrefs,
    watchTuiPreferences,
} from "../../shared/tui-preferences";
import { renderUserFacingFailure } from "../../shared/user-facing-codes";
import { badgeTextColor } from "../badge-contrast";
import { compactionOffSidebarRows } from "../compaction-off";
import { loadSidebarSnapshot, type SidebarSnapshot } from "../data/context-db";
import { createRefreshScheduler } from "../data/refresh-scheduler";
import { directoryForSession } from "../data/session-directory";
import {
    SidebarFrame,
    SidebarGaugeRow,
    SidebarSection,
    SidebarStatRow,
    SidebarTextRow,
} from "../quota-sidebar.js";

// Recomp commands do not send parent-session message events.
let activeRecompPollKick: (() => void) | null = null;
let activeSidebarRefresh: (() => void) | null = null;
export function kickRecompProgressRefresh(): void {
    activeRecompPollKick?.();
}

/** Ask the mounted sidebar to fetch an out-of-band status update now. */
export function refreshSidebarSnapshot(): void {
    activeSidebarRefresh?.();
}

export interface SidebarController {
    prefs: () => MagicContextTuiPrefs;
    collapsed: () => boolean;
    toggleCollapsed: () => void;
    dispose: () => void;
}

// The controller outlives slot remounts, so preference changes survive a switch
// from the main session to a subagent view and back.
function createSidebarController(initialPrefs: MagicContextTuiPrefs): SidebarController {
    const [prefs, setPrefs] = createSignal<MagicContextTuiPrefs>(initialPrefs);
    const seedCollapsed =
        initialPrefs.rememberCollapsed && initialPrefs.collapsed != null
            ? initialPrefs.collapsed
            : initialPrefs.startCollapsed;
    const [collapsed, setCollapsed] = createSignal(seedCollapsed);
    let lastPersistedCollapsed: boolean | null = initialPrefs.collapsed;
    let lastApplied = JSON.stringify(initialPrefs);

    const stopWatchingPreferences = watchTuiPreferences(() => {
        void (async () => {
            const next = resolveMagicContextPrefs(await readTuiPreferencesFile());
            const serialized = JSON.stringify(next);
            if (serialized === lastApplied) return;
            lastApplied = serialized;
            setPrefs(next);
            // Ignore the file watcher's echo after a local preference write.
            if (
                next.rememberCollapsed &&
                next.collapsed != null &&
                next.collapsed !== lastPersistedCollapsed
            ) {
                lastPersistedCollapsed = next.collapsed;
                setCollapsed(next.collapsed);
            }
        })();
    });

    function toggleCollapsed() {
        const next = !collapsed();
        setCollapsed(next);
        if (prefs().rememberCollapsed) {
            void queueTuiPreferenceUpdate(PLUGIN_KEY, ["collapsed"], next).then(() => {
                lastPersistedCollapsed = next;
            });
        }
    }

    return { prefs, collapsed, toggleCollapsed, dispose: stopWatchingPreferences };
}

function compactTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
    return String(Math.round(value));
}

function relativeTime(ms: number): string {
    const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""} ago`;
    return `${hours}h ago`;
}

function modelName(model: string | null | undefined): string {
    if (!model) return "—";
    const id = model.split("/").pop() ?? model;
    return id
        .replace(/-(\d{8})$/, "")
        .split("-")
        .map((word) => {
            if (/^deepseek$/i.test(word)) return "DeepSeek";
            if (/^gpt$/i.test(word)) return "GPT";
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(" ");
}

function shortText(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > 32 ? `${line.slice(0, 31)}…` : line;
}

function present(value: number | null | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

const SidebarContent = (props: {
    api: TuiPluginApi;
    sessionID: () => string;
    theme: TuiThemeCurrent;
    controller: SidebarController;
}) => {
    const [snapshot, setSnapshot] = createSignal<SidebarSnapshot | null>(null);
    const sections = () => props.controller.prefs().sections;
    const headerLabel = () => {
        const label = props.controller.prefs().header.label;
        return label === DEFAULT_PREFS.header.label ? "MAGIC CONTEXT" : label;
    };
    const scheduler = createRefreshScheduler<SidebarSnapshot | null>({
        read: async () => {
            const sid = props.sessionID();
            if (!sid) return null;
            const directory = directoryForSession(
                props.api.state.session?.get?.(sid)?.directory,
                props.api.state.path.directory ?? "",
            );
            return loadSidebarSnapshot(sid, directory, { throwOnFailure: true });
        },
        onSnapshot: (data) => {
            setSnapshot(data);
            try {
                props.api.renderer.requestRender();
            } catch {
                // The renderer can close before the request completes.
            }
        },
        isRunning: (data) =>
            Boolean(
                data?.historianRunning ||
                    data?.dreamerProgress ||
                    data?.recompProgress?.phase === "recomp" ||
                    data?.recompProgress?.phase === "migration",
            ),
    });
    const refresh = () => scheduler.refresh();
    const scheduleRefresh = () => scheduler.event();
    activeRecompPollKick = refresh;
    activeSidebarRefresh = refresh;

    onCleanup(() => {
        scheduler.dispose();
        if (activeRecompPollKick === refresh) activeRecompPollKick = null;
        if (activeSidebarRefresh === refresh) activeSidebarRefresh = null;
    });

    createEffect(
        on(props.sessionID, () => {
            setSnapshot(null);
            scheduler.reset();
        }),
    );
    createEffect(
        on(
            props.sessionID,
            (sessionID) => {
                const unsubs = [
                    props.api.event.on("message.updated", (event) => {
                        if (event.properties.info.sessionID === sessionID) scheduleRefresh();
                    }),
                    props.api.event.on("session.updated", (event) => {
                        if (event.properties.info.id === sessionID) scheduleRefresh();
                    }),
                    props.api.event.on("message.removed", (event) => {
                        if (event.properties.sessionID === sessionID) scheduleRefresh();
                    }),
                ];
                onCleanup(() => {
                    for (const unsub of unsubs) unsub();
                });
            },
            { defer: false },
        ),
    );

    const s = snapshot;
    const compactionOff = () => s()?.compaction_enabled === false;
    const tokenValue = () => {
        const data = s();
        return data && present(data.inputTokens) && data.contextLimit > 0
            ? `${compactTokens(data.inputTokens)}/${compactTokens(data.contextLimit)}`
            : "—";
    };
    const contextUsage = () => {
        const data = s();
        if (!data || data.contextLimit <= 0) return undefined;
        return compactionOff()
            ? (data.inputTokens / data.contextLimit) * 100
            : present(data.usagePercentage)
              ? data.usagePercentage
              : undefined;
    };
    const nextSummary = () => {
        const data = s();
        if (
            !data ||
            !present(data.proactiveFloor) ||
            !present(data.usagePercentage) ||
            !present(data.inputTokens) ||
            data.contextLimit <= 0
        )
            return "—";
        if (data.usagePercentage >= data.proactiveFloor) return "due";
        const remaining = Math.max(
            0,
            (data.contextLimit * data.proactiveFloor) / 100 - data.inputTokens,
        );
        return `at ${formatThresholdPercent(data.proactiveFloor)}% · +${compactTokens(remaining)}`;
    };
    const values = createMemo(() => {
        const data = s();
        const run = data?.historianRun;
        const cacheAt = data?.cachedM0MaterializedAt;
        const drops = data?.queuedDropTokens;
        const lastDream = data?.lastDreamerRunAt;
        return {
            lastRun: run ? `${relativeTime(run.finishedAt)} · ${run.outcome}` : "—",
            model: modelName(run?.model),
            waiting: present(data?.waitingMessages) ? `${data?.waitingMessages} msgs` : "—",
            cacheBuilt: present(cacheAt) ? relativeTime(cacheAt) : "—",
            sinceThen:
                present(data?.summariesSinceCache) && present(data?.memoriesSinceCache)
                    ? `${data?.summariesSinceCache} summaries · ${data?.memoriesSinceCache} memories`
                    : "—",
            drops:
                present(data?.pendingOpsCount) && present(drops)
                    ? `${data?.pendingOpsCount} · ≈${compactTokens(drops)} at rebuild`
                    : "—",
            memories: present(data?.memoryCount)
                ? `${data?.memoryCount} · ${present(data?.memoriesSinceCache) ? data?.memoriesSinceCache : "—"} new`
                : "—",
            notes:
                present(data?.sessionNoteCount) && present(data?.readySmartNoteCount)
                    ? `${data?.sessionNoteCount} · ${data?.readySmartNoteCount} smart waiting`
                    : "—",
            dreamerLastRun: present(lastDream)
                ? `${relativeTime(lastDream)} · ${data?.dreamerFailures?.length ? "failed" : "ok"}`
                : "—",
            nativeRows: data
                ? compactionOffSidebarRows(data).filter((row) =>
                      row.label === "Memories" ? sections().memory : sections().status,
                  )
                : [],
        };
    });
    const progress = () => {
        const p = s()?.recompProgress;
        return p?.phase === "recomp" || p?.phase === "migration" ? p : undefined;
    };
    const progressLabel = () =>
        ({ recomp: "Recomp", upgrade: "Upgrade", embed: "Embed", wrapup: "Wrap-up" })[
            progress()?.kind ?? "recomp"
        ];
    const progressValue = () => {
        const p = progress();
        return p && p.totalMessages > 0
            ? `${Math.round(Math.max(0, Math.min(1, p.processedMessages / p.totalMessages)) * 100)}%`
            : "no reading";
    };
    const healthRows = createMemo(() => {
        const data = s();
        const rows: Array<{ label: string; value: string; tone: "warning" | "error" }> = [];
        if (!data) return rows;
        const historian = data.historianRun;
        if (!compactionOff()) {
            const counts = historian?.sinceLastClean;
            if (counts && counts.primaryRejections > 0)
                rows.push({
                    label: "Historian",
                    value: `${modelName(historian?.primaryModel).split(" ")[0]} ${counts.primaryRejections}/${counts.primaryAttempts} rejected`,
                    tone: "warning",
                });
            if (counts && counts.fallbackRuns > 0)
                rows.push({
                    label: "Fallback",
                    value: `${modelName(historian?.model).split(" ")[0]} finished ${counts.fallbackRuns} runs`,
                    tone: "warning",
                });
            if (historian?.outcome === "failed" || (data.historianFailureCount ?? 0) > 0)
                rows.push({
                    label: "Historian",
                    value: "last run failed",
                    tone: "error",
                });
        }
        if (data.dreamerFailures?.length)
            rows.push({
                label: "Dreamer",
                value: `${data.dreamerFailures.length} tasks failed`,
                tone: "warning",
            });
        if (data.lastTransformError)
            rows.push({
                label: "Transform",
                value: shortText(data.lastTransformError),
                tone: "error",
            });
        for (const limitation of data.hostLimitations ?? [])
            rows.push({
                label: "Host",
                value: shortText(renderUserFacingFailure(limitation, "plain")),
                tone: "warning",
            });
        if (data.configReloadFailure)
            rows.push({ label: "Config", value: "reload failed", tone: "warning" });
        return rows;
    });

    const collapsedContext = () => {
        const used = contextUsage();
        return present(used)
            ? `${Math.round(100 - Math.max(0, Math.min(100, used)))}% left ●`
            : "no reading ●";
    };
    const collapsedHistorian = () => {
        const data = s();
        if (!data) return "no reading ●";
        const run = data.historianRun;
        const state =
            run?.outcome === "failed" || run?.outcome === "fallback"
                ? run.outcome
                : data.historianRunning || data.compartmentInProgress
                  ? "summarizing"
                  : "idle";
        return `${state}${run ? ` · ${relativeTime(run.finishedAt).replace(/ ago$/, "")}` : ""} ●`;
    };

    return (
        <SidebarFrame
            header={{ badge: headerLabel(), version: `v${packageJson.version}` }}
            accounts={[]}
            showQuota={false}
            theme={{
                text: props.theme.text,
                textMuted: props.theme.textMuted,
                accent: props.theme.accent,
                success: props.theme.success,
                warning: props.theme.warning,
                error: props.theme.error,
                background: badgeTextColor(props.theme.accent, props.theme.background),
                borderActive: props.theme.borderActive,
            }}
            appearance={{
                barWidth: 10,
                barFilledChar: "█",
                barEmptyChar: "░",
                warnThreshold: 65,
                errorThreshold: 85,
            }}
            now={Date.now()}
            collapsible={true}
            collapsed={props.controller.collapsed()}
            onToggle={props.controller.toggleCollapsed}
            collapsedSections={() => (
                <>
                    <SidebarStatRow label="Context" value={collapsedContext()} />
                    <Show when={!compactionOff() && sections().historian}>
                        <SidebarStatRow label="Historian" value={collapsedHistorian()} />
                    </Show>
                    <Show when={!compactionOff() && sections().status}>
                        <SidebarStatRow
                            label="Cache"
                            value={
                                present(s()?.pendingOpsCount)
                                    ? `${s()?.pendingOpsCount} drops queued ●`
                                    : "no reading ●"
                            }
                        />
                    </Show>
                    <Show when={healthRows().length > 0}>
                        <SidebarStatRow
                            label="Health"
                            value={`${healthRows().length} ${healthRows().length === 1 ? "issue" : "issues"} ●`}
                            tone={
                                healthRows().some((row) => row.tone === "error")
                                    ? "error"
                                    : "warning"
                            }
                        />
                    </Show>
                </>
            )}
            sections={() => (
                <>
                    <SidebarSection title="Context">
                        <SidebarGaugeRow
                            label="ctx"
                            used={contextUsage()}
                            value={tokenValue()}
                            warnAt={compactionOff() ? 100 : s()?.executeThreshold}
                            errorAt={compactionOff() ? 100 : 85}
                        />
                        <Show
                            when={!compactionOff()}
                            fallback={<SidebarTextRow text="native compaction" />}
                        >
                            <SidebarStatRow label="Next summary" value={nextSummary()} />
                        </Show>
                    </SidebarSection>
                    <Show when={!compactionOff() && sections().historian}>
                        <SidebarSection title="History">
                            <SidebarStatRow
                                label="Historian"
                                value={
                                    s()
                                        ? s()?.historianRunning || s()?.compartmentInProgress
                                            ? "summarizing"
                                            : "idle"
                                        : "—"
                                }
                            />
                            <SidebarStatRow label="Last run" value={values().lastRun} />
                            <SidebarStatRow label="Model" value={values().model} />
                            <SidebarStatRow label="Waiting" value={values().waiting} />
                            <Show when={progress()}>
                                <SidebarStatRow label={progressLabel()} value={progressValue()} />
                            </Show>
                        </SidebarSection>
                    </Show>
                    <Show when={!compactionOff() && sections().status}>
                        <SidebarSection title="Prompt cache">
                            <SidebarStatRow label="Cache built" value={values().cacheBuilt} />
                            <SidebarStatRow label="Since then" value={values().sinceThen} />
                            <SidebarStatRow label="Queued drops" value={values().drops} />
                        </SidebarSection>
                    </Show>
                    <Show when={sections().memory || sections().status}>
                        <SidebarSection title="Knowledge">
                            <Show
                                when={compactionOff()}
                                fallback={
                                    <>
                                        <Show when={sections().memory}>
                                            <SidebarStatRow
                                                label="Memories"
                                                value={values().memories}
                                            />
                                        </Show>
                                        <Show when={sections().status}>
                                            <SidebarStatRow label="Notes" value={values().notes} />
                                        </Show>
                                    </>
                                }
                            >
                                <For each={values().nativeRows}>
                                    {(row) => (
                                        <SidebarStatRow label={row.label} value={row.value} />
                                    )}
                                </For>
                            </Show>
                        </SidebarSection>
                    </Show>
                    <Show when={sections().dreamer}>
                        <SidebarSection title="Dreamer">
                            <SidebarStatRow label="Last run" value={values().dreamerLastRun} />
                            <Show when={s()?.dreamerProgress}>
                                {(p: () => NonNullable<SidebarSnapshot["dreamerProgress"]>) => (
                                    <SidebarStatRow
                                        label="Current"
                                        value={`${p().task} ${p().processed}/${p().total}`}
                                    />
                                )}
                            </Show>
                        </SidebarSection>
                    </Show>
                    <Show when={healthRows().length > 0}>
                        <SidebarSection title="Health">
                            <For each={healthRows()}>
                                {(row) => (
                                    <SidebarStatRow
                                        label={row.label}
                                        value={row.value}
                                        tone={row.tone}
                                    />
                                )}
                            </For>
                            <SidebarTextRow text="/ctx-status shows details" />
                        </SidebarSection>
                    </Show>
                </>
            )}
        />
    );
};

export function createSidebarContentSlot(
    api: TuiPluginApi,
): TuiSlotPlugin & { dispose: () => void } {
    const seedRoot = readTuiPreferencesFileSync();
    const controller = createSidebarController(resolveMagicContextPrefs(seedRoot));
    const effectiveOrder = computeEffectiveOrder(seedRoot, PLUGIN_KEY, DEFAULT_SLOT_ORDER);
    return {
        order: effectiveOrder,
        dispose: controller.dispose,
        slots: {
            sidebar_content: (ctx, value) => {
                const theme = createMemo(() => ctx.theme.current);
                return (
                    <SidebarContent
                        api={api}
                        sessionID={() => value.session_id}
                        theme={theme()}
                        controller={controller}
                    />
                );
            },
        },
    };
}
