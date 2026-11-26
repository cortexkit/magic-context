import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerSession } from "./cache-bust-runner-sources";
import { parseStepRender, type StepRender } from "./step-render-log";

export interface RunnerDecision {
    at: number;
    kind: "setup" | "view" | "view_refused" | "view_unknown" | "view_reoffer_failed" | "stale_reading" | "ride" | "signed_floor" | "summary_start" | "summary_publish" | "no_summary";
    detail: string;
    version?: number;
    line?: string;
}
export interface RunnerEvidence {
    decisions: RunnerDecision[];
    renders: StepRender[];
    files: string[];
}

export function parseRunnerDecision(line: string, session: string): RunnerDecision | null {
    return parseRunnerLogLine(line, session)?.decision ?? null;
}

export function parseRunnerLogLine(line: string, sessionFilter?: string): { at: number; session: string; decision: RunnerDecision | null } | null {
    const match = /ck-mc: session(?: (\S+))?: (.*)$/.exec(line);
    if (!match) return null;
    const [, legacySession, body] = match;
    const at = Date.parse(line.match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/)?.[1] ?? "");
    if (!Number.isFinite(at)) return null;
    if (legacySession) return sessionFilter !== undefined && sessionFilter !== legacySession
        ? null : { at, session: legacySession, decision: parseLegacyDecision(at, body!, line) };

    const event = splitRunnerEvent(body!);
    const session = event?.fields.get("session");
    if (!event || !session || (sessionFilter !== undefined && sessionFilter !== session)) return null;
    return { at, session, decision: parseStructuredDecision(at, event.message, event.fields, line) };
}

function splitRunnerEvent(body: string): { message: string; fields: Map<string, string> } | null {
    const start = body.search(/ [a-z_][\w.]*=/);
    if (start < 0) return null;
    const suffix = body.slice(start).trimEnd();
    // Consume complete field tokens so a space or `key=value` inside a quoted
    // value is not mistaken for a new field. The log writer uses JSON escapes.
    const token = / ([a-z_][\w.]*)=("(?:[^"\\]|\\.)*"|[^ "\s]+)/gy;
    const fields = new Map<string, string>();
    let end = 0;
    for (const match of suffix.matchAll(token)) {
        end += match[0].length;
        const value = match[2]!;
        try {
            fields.set(match[1]!, value.startsWith('"') ? JSON.parse(value) : value);
        } catch {
            return null;
        }
    }
    return end === suffix.length ? { message: body.slice(0, start), fields } : null;
}

function viewAcceptedAt(at: number, note: string): number {
    // If the apply answer was lost, a later notice confirms the view only
    // after the request that first carried it. Credit that request from the
    // handover time, not from the time printed at the start of the log line.
    const handedOver = Date.parse(/; handed over at (\S+)$/.exec(note)?.[1] ?? "");
    return Number.isFinite(handedOver) ? handedOver : at;
}

function parseStructuredDecision(at: number, message: string, fields: Map<string, string>, line: string): RunnerDecision | null {
    const field = (key: string) => fields.get(key) ?? "unlogged";
    const versionText = field("view_version");
    const version = /^\d+$/.test(versionText) ? Number(versionText) : undefined;
    const withVersion = (kind: RunnerDecision["kind"], detail: string, view = version): RunnerDecision | null =>
        view === undefined ? null : { at, kind, version: view, detail, line };
    switch (message) {
        case "setup":
            if (!fields.get("harness") || !fields.get("preset")) return null;
            return { at, kind: "setup", line, detail: `setup (${field("harness")}, preset ${field("preset")}, model ${field("provider")}/${field("model")}, child harness ${field("child_harness")}, window ${field("window_tokens")}, reserve ${field("reserve_tokens")}, applied view ${field("applied_view")}, statement epoch ${field("statement_epoch")}, stamp ${field("statement_stamp")})` };
        case "view accepted": {
            const cut = field("cut");
            const through = cut === "no cut" ? "none" : /^cut through (.+)$/.exec(cut)?.[1] ?? "unlogged";
            const decision = withVersion("view", `view=${versionText} edits=${field("edit_count")} cut=${through}`);
            return decision && { ...decision, at: viewAcceptedAt(at, field("note")) };
        }
        case "runner refused a view":
        case "runner refused a view at a step boundary":
            return withVersion("view_refused", `runner refused view ${versionText}${message.endsWith("at a step boundary") ? " at a step boundary" : ""}: ${field("refusal")}`);
        case "unknown answer to a view":
            return withVersion("view_unknown", `unknown answer to view ${versionText}: ${field("answer")}`);
        case "runner refused a view offered again":
            return withVersion("view_reoffer_failed", `runner refused view ${versionText} offered again: ${field("refusal")} (${field("policy_members")})`);
        case "unknown answer to a view offered again":
            return withVersion("view_reoffer_failed", `unknown answer to view ${versionText} offered again: ${field("answer")}`);
        case "rebuilding a view instead of offering it again":
            return withVersion("view_reoffer_failed", `view ${versionText} ${field("reason")}; rebuilding instead of offering it again`);
        case "runner operation failed": {
            const operation = field("operation");
            const reoffered = /^offering view (\d+) again$/.exec(operation);
            return reoffered ? withVersion("view_reoffer_failed", `${operation} failed: ${field("error")}`, Number(reoffered[1])) : null;
        }
        case "ignoring a prompt reading from a stale view; waiting for a reading under the current view":
            return { at, kind: "stale_reading", line, detail: `ignoring a prompt of ${field("prompt_tokens")} tokens: reading from view ${versionText}, newest applied ${field("applied_view")}${fields.get("accepted_note") ?? ""}; waiting for a reading under the current view` };
        // The request carries both the causes and the size. A later line saying
        // the view did not change is not a second ride.
        case "the runner requested a ride":
            return { at, kind: "ride", line, detail: `ride ${field("causes")}, request ${field("request_tokens")} tokens, last prompt ${field("last_prompt_tokens")}, applied view ${field("applied_view")}` };
        case "signed floor moved; the runner strips signed reasoning at or before it":
            return { at, kind: "signed_floor", line, detail: `signed floor moved to ${field("signed_floor")} (${field("floor_ordinal")}) from ${field("previous_floor")}; the runner strips signed reasoning at or before it` };
        case "summary started over a message range":
            return { at, kind: "summary_start", detail: `summary started over messages ${field("first_ordinal")}..${field("last_ordinal")} (~${field("requested_tokens")} tokens)` };
        case "published summaries":
            return { at, kind: "summary_publish", detail: `${field("summary_count")} summaries published, through message ${field("through_ordinal")}` };
        case "no summary started":
            return { at, kind: "no_summary", detail: `no summary at ${field("usage_pct")}% (threshold ${field("threshold_pct")}%): ${field("reason")}` };
        default:
            return null;
    }
}

function parseLegacyDecision(at: number, body: string, line: string): RunnerDecision | null {
    // Setup is a handshake, not proof that the provider's cached prefix changed.
    if (body.startsWith("setup (")) return { at, kind: "setup", detail: body, line };
    // Old shape: b99525c82a, crates/mc-module/src/session.rs:3040.
    // Cut-through/no-cut shape: 8c75aafa8d, the same file at :3051.
    const view = /^view (\d+) accepted\b/.exec(body);
    const edits = /^view \d+ accepted \((\d+) edits/.exec(body)?.[1];
    // A note may follow the closing parenthesis, so the cut is not end-anchored.
    const cut = /^view \d+ accepted \(\d+ edits, cut through ([^)]+)\)/.exec(body)?.[1];
    if (view) return {
        at: viewAcceptedAt(at, body), kind: "view", version: Number(view[1]), line,
        detail: `view=${view[1]} edits=${edits ?? "unlogged"} cut=${cut ?? (body.includes(", no cut") ? "none" : "unlogged")}`,
    };
    const reoffer = /^(?:runner refused view|unknown answer to view) (\d+) offered again:/.exec(body) ??
        /^view (\d+) .+; rebuilding instead of offering it again$/.exec(body) ??
        /^offering view (\d+) again failed:/.exec(body);
    if (reoffer) return { at, kind: "view_reoffer_failed", version: Number(reoffer[1]), detail: body, line };
    const refused = /^runner refused view (\d+)(?: at a step boundary)?:/.exec(body);
    if (refused) return { at, kind: "view_refused", version: Number(refused[1]), detail: body, line };
    const unknown = /^unknown answer to view (\d+):/.exec(body);
    if (unknown) return { at, kind: "view_unknown", version: Number(unknown[1]), detail: body, line };
    if (/^ignoring a prompt of \d+ tokens: reading from view \d+, newest applied \d+.*; waiting for a reading under the current view$/.test(body))
        return { at, kind: "stale_reading", detail: body, line };
    // b99525c82a, session.rs:1681; Rust Debug preserves causes and optional sizes.
    if (/^ride \[.*\], request (?:Some\(\d+\)|None)/.test(body)) {
        return { at, kind: "ride", detail: body, line };
    }
    if (/^signed floor moved to \S+/.test(body)) return { at, kind: "signed_floor", detail: body, line };
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
    const changes = all.filter((event) =>
        event.kind === "view" && previousVersion !== undefined && event.version !== undefined && event.version > previousVersion &&
        (view === undefined || event.version === view));
    return { all, changes };
}
