import { escalationBands } from "../../shared/escalation-bands";
import type { SidebarSnapshot } from "../../shared/rpc-types";
import type { TuiSections } from "../../shared/tui-preferences";
import { compactionOffSidebarRows, nativeCompactionUsage } from "../compaction-off";

/**
 * What the sidebar panel draws, decided from one server snapshot. Every string
 * here is final: the panel only places rows. A value the server did not send
 * leaves its row out, so a newer panel talking to an older server shows fewer
 * rows instead of wrong ones.
 */

export type RowTone = "text" | "textMuted" | "accent" | "success" | "warning" | "error";

export interface StatRowView {
    label: string;
    value: string;
    tone?: RowTone;
}

export interface GaugeRowView {
    label: string;
    /** Share used, 0–100; absent means there is no reading yet. */
    used?: number;
    value?: string;
    warnAt?: number;
    errorAt?: number;
}

export interface SidebarView {
    /** The `Context` section, present while that section is visible. */
    context?: {
        /** The window gauge; absent while compaction is off. */
        gauge?: GaugeRowView;
        rows: StatRowView[];
    };
    /** A running or just-finished rebuild, shown regardless of section settings. */
    progress?: {
        title: string;
        rows: StatRowView[];
        /** Live or final wording from the server, drawn as plain text. */
        notes: string[];
    };
    history?: StatRowView[];
    cache?: StatRowView[];
    knowledge?: StatRowView[];
    /** The single row the collapsed panel shows. */
    summary: StatRowView;
}

export function compactTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
    // Token counts are whole numbers to the reader even when the tokenizer
    // calibration leaves them fractional.
    return String(Math.round(value));
}

/** `just now`, `12m ago`, `1h55m ago` under ten hours, `29h ago` under three days, then `4d ago`. */
export function formatAge(at: number, now: number): string {
    const minutes = Math.floor(Math.max(0, now - at) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 10) {
        const rest = minutes % 60;
        return rest === 0 ? `${hours}h ago` : `${hours}h${rest}m ago`;
    }
    if (hours < 72) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function percent(value: number): string {
    return `${Math.round(value)}%`;
}

function hasReading(snapshot: SidebarSnapshot): boolean {
    return (
        snapshot.inputTokens > 0 && snapshot.contextLimit > 0 && finite(snapshot.usagePercentage)
    );
}

/**
 * Colours follow this session's own schedule: warning from the execute
 * threshold, error from the force band above it. A large window at 55% is
 * healthy when the threshold is 65%.
 */
function gaugeThresholds(snapshot: SidebarSnapshot): Pick<GaugeRowView, "warnAt" | "errorAt"> {
    const threshold = snapshot.executeThreshold;
    if (!finite(threshold) || threshold <= 0) return {};
    return {
        warnAt: threshold,
        errorAt: escalationBands(threshold).forceMaterializationPercentage,
    };
}

function contextGauge(snapshot: SidebarSnapshot): GaugeRowView {
    if (!hasReading(snapshot)) return { label: "ctx", ...gaugeThresholds(snapshot) };
    return {
        label: "ctx",
        used: snapshot.usagePercentage,
        value: `${compactTokens(snapshot.inputTokens)}/${compactTokens(snapshot.contextLimit)}`,
        ...gaugeThresholds(snapshot),
    };
}

function nextSummaryRow(snapshot: SidebarSnapshot): StatRowView | undefined {
    const at = snapshot.nextSummaryPercentage;
    if (!finite(at)) return undefined;
    if (snapshot.historianRunning)
        return { label: "Summary", value: "running now", tone: "warning" };
    if (!hasReading(snapshot)) return { label: "Next summary at", value: percent(at) };
    if (snapshot.usagePercentage >= at)
        return { label: "Next summary at", value: `${percent(at)} · due` };
    const remaining = Math.max(
        0,
        Math.ceil((at / 100) * snapshot.contextLimit - snapshot.inputTokens),
    );
    return { label: "Next summary at", value: `${percent(at)} · +${compactTokens(remaining)}` };
}

function historyRows(snapshot: SidebarSnapshot, now: number): StatRowView[] {
    const rows: StatRowView[] = [];
    if (snapshot.historianRunning)
        rows.push({ label: "Historian", value: "running", tone: "warning" });
    else if ((snapshot.historianFailureCount ?? 0) > 0)
        rows.push({ label: "Historian", value: "failing", tone: "error" });
    else rows.push({ label: "Historian", value: "idle", tone: "textMuted" });
    const last = snapshot.historianLastRun;
    if (last && finite(last.at)) {
        rows.push({
            label: "Last run",
            value: `${formatAge(last.at, now)} · ${last.outcome === "failed" ? "failed" : "ok"}`,
            ...(last.outcome === "failed" ? { tone: "error" as const } : {}),
        });
        if (last.model) rows.push({ label: "Model", value: last.model });
    }
    return rows;
}

function memoriesRow(snapshot: SidebarSnapshot): StatRowView {
    const fresh = snapshot.newMemoryCount ?? 0;
    return {
        label: "Memories",
        value: fresh > 0 ? `${snapshot.memoryCount} · ${fresh} new` : String(snapshot.memoryCount),
    };
}

type Progress = NonNullable<SidebarSnapshot["recompProgress"]>;

function progressTitle(progress: Progress): string {
    switch (progress.kind) {
        case "upgrade":
            return "Upgrade";
        case "embed":
            return "Embed";
        case "wrapup":
            return "Wrapup";
        default:
            return "Recomp";
    }
}

function progressStatus(progress: Progress): StatRowView {
    switch (progress.phase) {
        case "recomp":
            return { label: "Status", value: "running", tone: "warning" };
        case "migration":
            return { label: "Status", value: "moving memories", tone: "warning" };
        case "done":
            return { label: "Status", value: "done", tone: "success" };
        case "skipped":
            return { label: "Status", value: "stopped", tone: "textMuted" };
        case "failed":
            return { label: "Status", value: "failed", tone: "error" };
    }
}

function progressView(progress: Progress): NonNullable<SidebarView["progress"]> {
    const running = progress.phase === "recomp";
    const rows = [progressStatus(progress)];
    // The share of messages processed so far, drawn as a figure rather than a
    // gauge: the shared gauge describes what is left of a budget being used up.
    const done =
        running && progress.totalMessages > 0
            ? `${Math.round((progress.processedMessages / progress.totalMessages) * 100)}%`
            : undefined;
    if (running && progress.kind === "embed") {
        const count = `${progress.processedMessages}/${progress.totalMessages}`;
        rows.push({
            label: "Embedded",
            value: done ? `${count} · ${done}` : count,
            ...(done ? { tone: "success" as const } : {}),
        });
    } else if (running) {
        const passes = `${progress.passCount} ${progress.passCount === 1 ? "pass" : "passes"}`;
        rows.push({ label: "Compartments", value: `${progress.compartmentsCreated} · ${passes}` });
        if (done) rows.push({ label: "Progress", value: done, tone: "success" });
    }
    const notes: string[] = [];
    if ((running || progress.phase === "migration") && progress.note) notes.push(progress.note);
    if ((progress.phase === "failed" || progress.phase === "skipped") && progress.message)
        notes.push(progress.message);
    return { title: progressTitle(progress), rows, notes };
}

function summaryRow(snapshot: SidebarSnapshot | null): StatRowView {
    if (!snapshot) return { label: "ctx", value: "no reading" };
    // With compaction off, the share matches the expanded panel's native usage row.
    const used =
        snapshot.compaction_enabled === false
            ? snapshot.contextLimit > 0 && snapshot.inputTokens > 0
                ? (snapshot.inputTokens / snapshot.contextLimit) * 100
                : undefined
            : hasReading(snapshot)
              ? snapshot.usagePercentage
              : undefined;
    if (!finite(used)) return { label: "ctx", value: "no reading" };
    return { label: "ctx", value: `${Math.round(100 - Math.max(0, Math.min(100, used)))}% left` };
}

/** Decide every row the panel shows for one snapshot, or the waiting state before the first. */
export function buildSidebarView(
    snapshot: SidebarSnapshot | null,
    sections: TuiSections,
    now: number,
): SidebarView {
    const view: SidebarView = { summary: summaryRow(snapshot) };
    if (!snapshot) {
        if (sections.context) view.context = { gauge: { label: "ctx" }, rows: [] };
        return view;
    }
    const compactionOff = snapshot.compaction_enabled === false;

    if (sections.context) {
        if (compactionOff) {
            // Memories move to Knowledge, which shows them in every mode.
            view.context = {
                rows: [
                    { label: "Usage", value: nativeCompactionUsage(snapshot) },
                    ...compactionOffSidebarRows(snapshot).filter((row) => row.label !== "Memories"),
                ],
            };
        } else {
            const next = nextSummaryRow(snapshot);
            view.context = { gauge: contextGauge(snapshot), rows: next ? [next] : [] };
        }
    }
    if (snapshot.recompProgress) view.progress = progressView(snapshot.recompProgress);
    // The summarizer does not run while compaction is off.
    if (sections.history && !compactionOff) view.history = historyRows(snapshot, now);
    if (sections.cache && finite(snapshot.cacheBuiltAt)) {
        view.cache = [{ label: "Cache built", value: formatAge(snapshot.cacheBuiltAt, now) }];
    }
    if (sections.knowledge) view.knowledge = [memoriesRow(snapshot)];
    return view;
}
