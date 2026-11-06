import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerSession } from "./cache-bust-runner-sources";
import { parseStepRender, type StepRender } from "./step-render-log";

export interface RunnerDecision {
    at: number;
    kind: "setup" | "view" | "ride" | "summary_start" | "summary_publish" | "no_summary";
    detail: string;
    version?: number;
}
export interface RunnerEvidence {
    decisions: RunnerDecision[];
    renders: StepRender[];
    files: string[];
}

export function parseRunnerDecision(line: string, session: string): RunnerDecision | null {
    const at = Date.parse(line.match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)/)?.[1] ?? "");
    const match = line.match(/ck-mc: session ([^\s:]+): (.*)$/);
    if (!Number.isFinite(at) || match?.[1] !== session) return null;
    const body = match[2]!;
    // Setup records a new runner/module handshake; it can reset the served view.
    // Producer: b99525c82a, crates/mc-module/src/session.rs:603.
    if (body.startsWith("setup (")) return { at, kind: "setup", detail: body };
    // Old shape: b99525c82a, crates/mc-module/src/session.rs:3040.
    // Cut-through/no-cut shape: 8c75aafa8d, the same file at :3051.
    const view = /^view (\d+) accepted \((\d+) edits(?:, (?:cut through (.+)|no cut))?\)$/.exec(body);
    if (view) return {
        at, kind: "view", version: Number(view[1]),
        detail: `view=${view[1]} edits=${view[2]} cut=${view[3] ?? (body.includes(", no cut") ? "none" : "unlogged")}`,
    };
    // b99525c82a, session.rs:1681; Rust Debug preserves causes and optional sizes.
    if (/^ride \[.*\], request (?:Some\(\d+\)|None) tokens, last prompt (?:Some\(\d+\)|None), applied view (?:Some\(\d+\)|None)$/.test(body)) {
        return { at, kind: "ride", detail: body };
    }
    // b99525c82a, session.rs:1056, :1460 and :929 respectively. Publishing a
    // summary is not evidence that a request used a new view or a new cut.
    if (/^summary started over messages \d+\.\.\d+ \(~\d+ tokens\)$/.test(body)) return { at, kind: "summary_start", detail: body };
    if (/^\d+ summaries published, through message \d+$/.test(body)) return { at, kind: "summary_publish", detail: body };
    if (/^no summary at \d+% \(threshold \d+%\): .+$/.test(body)) return { at, kind: "no_summary", detail: body };
    return null;
}

export function loadRunnerEvidence(root: string, runner: RunnerSession, mcLogPath?: string, window: { sinceMs?: number; untilMs?: number } = {}): RunnerEvidence {
    const files: string[] = [];
    const decisions: RunnerDecision[] = [];
    const renders: StepRender[] = [];
    const through = window.untilMs ?? Date.now();
    const from = window.sinceMs ?? runner.requests.reduce((earliest, request) => Math.min(earliest, request.at), through);
    // Log names use UTC dates. Include the preceding day so the first request
    // in the requested window can find decisions from its previous request.
    const firstDate = new Date(from - 86_400_000).toISOString().slice(0, 10);
    const lastDate = new Date(through).toISOString().slice(0, 10);
    const daily = (directory: string, prefix: string): string[] => existsSync(directory)
        ? readdirSync(directory).filter((name) => {
            const date = new RegExp(`^${prefix}\\.(\\d{4}-\\d\\d-\\d\\d)\\.log$`).exec(name)?.[1];
            return date !== undefined && date >= firstDate && date <= lastDate;
        }).sort().map((name) => join(directory, name)) : [];
    const mcFiles = mcLogPath ? (existsSync(mcLogPath) ? [mcLogPath] : []) : daily(join(root, "magic-context/logs"), "magic-context");
    const module = runner.kind === "oc2" ? "thalamus-harness" : "thalamus-pi";
    const stepFiles = daily(join(root, module, "logs"), module);
    for (const file of mcFiles) {
        files.push(file);
        for (const line of readFileSync(file, "utf8").split("\n")) {
            const decision = parseRunnerDecision(line, runner.session);
            if (decision) decisions.push(decision);
        }
    }
    for (const file of stepFiles) {
        files.push(file);
        for (const line of readFileSync(file, "utf8").split("\n")) {
            const render = parseStepRender(line);
            if (render?.sessionId === runner.session) renders.push(render);
        }
    }
    return { decisions: decisions.sort((a, b) => a.at - b.at), renders: renders.sort((a, b) => a.at - b.at), files };
}

/**
 * The runner has no per-request id yet. Match each request to the nearest render
 * within one minute, once only, in request order. Render completion can slightly
 * precede or follow the meter's creation clock. Missing joins stay explicit.
 * Replace this function with an id join when the runner exposes request ids.
 */
export function joinRequestsToViews(timestamps: readonly number[], renders: readonly StepRender[]): (StepRender | undefined)[] {
    let next = 0;
    return timestamps.map((at) => {
        while (next < renders.length && renders[next]!.at < at - 60_000) next++;
        let best = -1;
        for (let index = next; index < renders.length && renders[index]!.at <= at + 60_000; index++) {
            if (timestamps.some((other) => Math.abs(renders[index]!.at - other) < Math.abs(renders[index]!.at - at))) continue;
            if (best < 0 || Math.abs(renders[index]!.at - at) < Math.abs(renders[best]!.at - at)) best = index;
        }
        if (best < 0) return undefined;
        next = best + 1;
        return renders[best];
    });
}

export function runnerDecisionsBetween(evidence: RunnerEvidence, after: number, through: number, view?: number | null): { all: RunnerDecision[]; changes: RunnerDecision[] } {
    const all = evidence.decisions.filter((event) => event.at > after && event.at <= through);
    const previousVersion = evidence.decisions.filter((event) => event.kind === "view" && event.at <= after).at(-1)?.version;
    const changes = all.filter((event) => event.kind === "ride" || event.kind === "setup" ||
        (event.kind === "view" && event.version !== previousVersion && (view === undefined || event.version === view)));
    return { all, changes };
}
