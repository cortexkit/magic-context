#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { SubcClient } from "@cortexkit/subc-client";
import { loadPluginConfig } from "../src/config";
import { getDataDir, getMagicContextStorageDir } from "../src/shared/data-path";
import {
    setStoragePrivatePermissionEnforcement,
    writeStorageFileAtomicSync,
} from "../src/shared/storage-permissions";
import { parseAgentDeliverReply } from "./cache-bust-sentinel";
import { parseStepRender } from "./step-render-log";

const HOUR = 3_600_000;
const WINDOW = 10 * 60_000;
const MAX_BYTES = 4 * 1024 * 1024; // per file, per invocation
const AGENT_ID = "agent_b613e5cf2ee55b8c";
type Kind = "p90" | "single" | "timeout" | "park" | "refusal" | "module_climb" | "busy_refusal" | "busy_replay" | "long_lock";
const BUSY_REPLAY_THRESHOLD = 2;
const LONG_LOCK_MS = 5_000;
const UNKNOWN_SESSION = "unknown-session";
type Pass = { at: number; elapsed: number; module: number | null };
type Session = { passes: Pass[]; trend: Pass[]; lastAt: number; declines?: Record<string, Record<string, number>> };
export type LkgDeclineSummary = { sessionId: string; hour: string; reasons: Record<string, number> };
type Cursor = { dev: number; ino: number; offset: number };
type Sent = { at: number; severity: number };
type BusyCounts = { refusals: number; replays: number };
type Hold = { at: number; site: string; ms: number };
type State = { version: 1; files: Record<string, Cursor>; sessions: Record<string, Session>; sent: Record<string, Sent>; busy?: Record<string, Record<string, BusyCounts>>; holds?: Hold[]; pendingBusy?: Record<string, number>; lastSummaryDay?: string };
export type LatencyAlert = { kind: Kind; sessionId: string; name: string; at: string; detail: string; lkgDeclines: Record<string, number>; count: number; p50: number; p90: number; max: number; moduleP50: number | null; moduleP90: number | null; moduleMax: number | null; pluginP50: number | null; pluginP90: number | null; pluginMax: number | null; busy?: BusyCounts; lock?: { site: string; count: number; p90: number; max: number }; load: number[]; loadSampledAt: string };
export type LatencyOptions = { files: string[]; stateFile: string; db: string; peerDb?: string; connectionFile: string; send: boolean; now?: () => number; load?: () => number[]; wake?: (content: string, id: string) => Promise<void>; stdout?: (line: string) => void; stderr?: (line: string) => void; since?: number; until?: number; replay?: boolean; summary?: boolean };
const empty = (): State => ({ version: 1, files: {}, sessions: {}, sent: {}, busy: {}, holds: [], pendingBusy: {} });
const quantile = (values: number[], fraction: number) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : 0;

function readState(path: string): State {
    if (!existsSync(path)) return empty();
    const value = JSON.parse(readFileSync(path, "utf8")) as State;
    if (value.version !== 1 || !value.files || !value.sessions || !value.sent) throw new Error("invalid latency sentinel state");
    return value;
}
function saveState(path: string, state: State): void {
    writeStorageFileAtomicSync(path, `${JSON.stringify(state)}\n`);
}

// Leave an incomplete final line at the watermark; it can only be parsed after its newline arrives.
export function readNewLines(path: string, cursor: Cursor | undefined, maxBytes = MAX_BYTES): { lines: string[]; cursor: Cursor; bounded: boolean } {
    const fd = openSync(path, "r");
    try {
        const stat = fstatSync(fd);
        const offset = cursor?.dev === stat.dev && cursor.ino === stat.ino && cursor.offset <= stat.size ? cursor.offset : 0;
        const bytes = Math.min(maxBytes, stat.size - offset);
        const buffer = Buffer.alloc(bytes);
        const count = readSync(fd, buffer, 0, bytes, offset);
        const end = buffer.lastIndexOf(10, count - 1);
        // An oversized line cannot pin the cursor forever. Skip it if the entire read budget contains no newline.
        const consumed = end < 0 && count === maxBytes ? count : Math.max(0, end + 1);
        return { lines: consumed && end >= 0 ? buffer.subarray(0, end + 1).toString("utf8").split("\n").slice(0, -1) : [],
            cursor: { dev: stat.dev, ino: stat.ino, offset: offset + consumed }, bounded: offset + consumed < stat.size };
    } finally { closeSync(fd); }
}

const LKG_DECLINE = /^lkg_(?:model_mismatch|invalidated_reshape|content_mismatch|unsafe_seam|seam_invalid|anthropic_reasoning_run_invalid)$/;
const hourKey = (at: number) => new Date(Math.floor(at / HOUR) * HOUR).toISOString();

function parse(line: string): { sessionId: string; at: number; pass?: Pass; kind?: Kind; detail?: string; decline?: string; busy?: keyof BusyCounts; hold?: { site: string; ms: number } } | null {
    const at = Date.parse(line.match(/(?:\[)?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)/)?.[1] ?? "");
    if (!Number.isFinite(at)) return null;
    // Sessions hosted by Thalamus's runners (thalamus-harness, thalamus-pi) run
    // Magic Context in the ck-mc subc module instead of this plugin. The runner
    // logs one `step render` line per model request: elapsed_ms is the whole
    // request hook, and wait_ms is the part spent waiting for the runner's step
    // answer, including any wait on the ck-mc module. That wait plays the part of
    // a Rust pass's module time, so the same thresholds apply, including the
    // alert when module time keeps rising across 20 passes. Pi session ids are
    // UUIDs, so this match takes any session token.
    const step = parseStepRender(line);
    if (step) return { sessionId: step.sessionId, at, pass: { at, elapsed: step.elapsed, module: step.wait } };
    const sessionId = line.match(/\[magic-context\]\[([^\]]+)\]/)?.[1] ?? line.match(/\bsession=(ses_[\w-]+)/)?.[1];
    const hold = line.match(/\[magic-context\] slow write transaction: site=(\S+) held=([\d.]+)ms(?:\s|$)/);
    if (hold && Number.isFinite(Number(hold[2]))) return { sessionId: UNKNOWN_SESSION, at, hold: { site: hold[1]!, ms: Number(hold[2]) } };
    if (/\[magic-context\] storage-busy refusal stage=\S+/.test(line)) return { sessionId: sessionId ?? UNKNOWN_SESSION, at, busy: "refusals" };
    if (!sessionId) return null;
    if (/TRANSIENT STORAGE FAILURE .*: LKG replay served \d+ messages instead of raw \d+/.test(line)) return { sessionId, at, busy: "replays" };
    if (/\] lkg_replay_served(?:\s|$)/.test(line)) return { sessionId, at, kind: "busy_replay" };
    // Release diagnostics can mention a decline again as `reason=lkg_*`; count only lines whose logged event is the decline code.
    const decline = line.match(/\] (lkg_[a-z_]+)(?:\s|$)/)?.[1];
    if (decline && LKG_DECLINE.test(decline)) return { sessionId, at, decline };
    const rust = line.match(/rust pass:.*?\belapsed=([\d.]+) ms module=([\d.]+) ms/);
    const ts = line.match(/transform completed in ([\d.]+)ms/);
    if (rust || ts) {
        const elapsed = Number((rust ?? ts)![1]);
        const module = rust ? Number(rust[2]) : null;
        if (!Number.isFinite(elapsed) || (module !== null && !Number.isFinite(module))) return null;
        return { sessionId, at, pass: { at, elapsed, module } };
    }
    if (/module request timed out|transport deadline expired|state_sync timeout/i.test(line)) return { sessionId, at, kind: "timeout", detail: line.match(/module request timed out|transport deadline expired|state_sync timeout/i)![0] };
    if (/mc_rust_park_transition/.test(line)) return { sessionId, at, kind: "park", detail: "mc_rust_park_transition" };
    if (/raw_fallback_over_context_limit|EmergencyFailClosed|storage[-_ ]busy.{0,80}(?:refus|reject)|(?:refus|reject).{0,80}storage[-_ ]busy/i.test(line)) return { sessionId, at, kind: "refusal", detail: line.match(/raw_fallback_over_context_limit|EmergencyFailClosed|storage[-_ ]busy/i)![0] };
    return null;
}

function addLine(state: State, line: string, load: () => number[], file: string): LatencyAlert[] {
    const event = parse(line);
    if (!event) return [];
    const { sessionId, at } = event;
    // StorageBusyRefusalError logs without a session ID; parse assigns UNKNOWN_SESSION
    // instead of guessing which concurrent turn was refused.
    const session = state.sessions[sessionId] ??= { passes: [], trend: [], lastAt: at };
    session.lastAt = at;
    if (event.decline) {
        const reasons = (session.declines ??= {})[hourKey(at)] ??= {};
        reasons[event.decline] = (reasons[event.decline] ?? 0) + 1;
    }
    if (event.pass) {
        session.passes.push(event.pass);
        session.passes = session.passes.filter((p) => p.at > at - WINDOW).slice(-10);
        if (event.pass.module !== null) session.trend.push(event.pass);
        session.trend = session.trend.slice(-40);
    }
    const passes = session.passes;
    const elapsed = passes.map((p) => p.elapsed);
    const modules = passes.flatMap((p) => p.module === null ? [] : [p.module]);
    const plugins = passes.flatMap((p) => p.module === null ? [] : [Math.max(0, p.elapsed - p.module)]);
    const report = (kind: Kind, detail: string, severity: number): LatencyAlert | null => {
        const key = JSON.stringify([kind === "long_lock" ? detail.split(" ")[0] : sessionId, kind]);
        const previous = state.sent[key];
        if (previous && at - previous.at < 6 * HOUR && severity < previous.severity * 1.5) return null;
        state.sent[key] = { at, severity };
        return { kind, sessionId, name: sessionId, at: new Date(at).toISOString(), detail,
            lkgDeclines: kind === "refusal" ? { ...session.declines?.[hourKey(at)] } : {}, count: passes.length,
            p50: quantile(elapsed, .5), p90: quantile(elapsed, .9), max: Math.max(0, ...elapsed),
            moduleP50: modules.length ? quantile(modules, .5) : null,
            moduleP90: modules.length ? quantile(modules, .9) : null,
            moduleMax: modules.length ? Math.max(...modules) : null,
            pluginP50: plugins.length ? quantile(plugins, .5) : null,
            pluginP90: plugins.length ? quantile(plugins, .9) : null,
            pluginMax: plugins.length ? Math.max(...plugins) : null,
            load: load(), loadSampledAt: new Date().toISOString() };
    };
    const alerts: LatencyAlert[] = [];
    const emit = (kind: Kind, detail: string, severity: number) => { const alert = report(kind, detail, severity); if (alert) alerts.push(alert); };
    if (event.pass) {
        if (event.pass.elapsed > 12_000) emit("single", `pass ${event.pass.elapsed} ms (module ${event.pass.module ?? "n/a"} ms)`, event.pass.elapsed);
        if (passes.length === 10 && quantile(elapsed, .9) > 5_000) emit("p90", "last 10 passes within 10 minutes", quantile(elapsed, .9));
        const trend = session.trend;
        if (trend.length >= 20) {
            const first = quantile(trend.slice(0, 5).map((p) => p.module!), .5);
            const last = quantile(trend.slice(-5).map((p) => p.module!), .5);
            const halves = [0, 1, 2, 3].map((i) => quantile(trend.slice(i * 5, (i + 1) * 5).map((p) => p.module!), .5));
            if (last >= 1_000 && last >= first * 3 && halves.every((v, i) => i === 0 || v >= halves[i - 1] * .8))
                emit("module_climb", `module median first 5 ${first} ms to last 5 ${last} ms over ${trend.length} passes`, last);
        }
    }
    if (event.busy === "refusals") (state.pendingBusy ??= {})[file] = at;
    if (event.kind === "busy_replay") {
        // The generic replay marker is counted only when a storage-busy diagnostic
        // immediately preceded it in the same log; unrelated LKG replays stay out.
        if (at - (state.pendingBusy?.[file] ?? -Infinity) >= 0 && at - state.pendingBusy![file]! <= 5_000) {
            event.busy = "replays";
            delete state.pendingBusy![file];
        }
    } else if (event.kind) emit(event.kind, event.detail!, 1);
    if (event.busy) {
        const counts = ((state.busy ??= {})[sessionId] ??= {})[hourKey(at)] ??= { refusals: 0, replays: 0 };
        counts[event.busy]++;
        if (event.busy === "refusals" || counts.replays > BUSY_REPLAY_THRESHOLD) {
            const alert = report(event.busy === "refusals" ? "busy_refusal" : "busy_replay", `${counts.refusals} storage-busy refusals, ${counts.replays} busy-storage replays this hour`, event.busy === "refusals" ? 1 : counts.replays);
            if (alert) { alert.busy = { ...counts }; alerts.push(alert); }
        }
    }
    if (event.hold) {
        const holds = state.holds ??= [];
        holds.push({ at, ...event.hold });
        const siteHolds = holds.filter((hold) => hold.site === event.hold!.site && hold.at > at - 24 * HOUR).map((hold) => hold.ms);
        if (event.hold.ms > LONG_LOCK_MS) {
            const site = event.hold.site;
            const stats = { site, count: siteHolds.length, max: Math.max(...siteHolds), p90: quantile(siteHolds, .9) };
            const alert = report("long_lock", `${site} held ${stats.max.toFixed(1)}ms (p90 ${stats.p90.toFixed(1)}ms, ${stats.count} holds)`, event.hold.ms);
            if (alert) { alert.lock = stats; alerts.push(alert); }
        }
    }
    return alerts;
}

function names(dbPath: string, peerDbPath: string | undefined, alerts: LatencyAlert[]): void {
    if (!alerts.length) return;
    if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
            db.exec("PRAGMA busy_timeout = 3000");
            const lookup = db.query("SELECT project_path FROM session_projects WHERE session_id = ? LIMIT 1");
            for (const alert of alerts) {
                const row = lookup.get(alert.sessionId) as { project_path: string } | null;
                if (row?.project_path) alert.name = row.project_path;
            }
        } finally { db.close(false); }
    }
    if (peerDbPath && existsSync(peerDbPath)) {
        const db = new Database(peerDbPath, { readonly: true });
        try {
            db.exec("PRAGMA busy_timeout = 3000");
            const agent = db.query("SELECT name FROM agent WHERE json_extract(residence_address_json, '$.session') = ? AND terminal_reason IS NULL LIMIT 1");
            // Prefrontal's store no longer has the legacy `peers` table; preparing a query on it
            // threw and stopped every run before any alert went out. Use it only where it exists.
            const hasPeers = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'peers'").get() !== null;
            const peer = hasPeers ? db.query("SELECT name FROM peers WHERE session_id = ? ORDER BY added_at DESC LIMIT 1") : null;
            for (const alert of alerts) {
                const row = (agent.get(alert.sessionId) ?? peer?.get(alert.sessionId) ?? null) as { name: string } | null;
                if (row?.name) alert.name = row.name;
            }
        } finally { db.close(false); }
    }
}

// A roster name marks a head session; a project identity or raw session id marks a short-lived
// child or worker session. Children of one project are summarised together so a load spike
// produces one line per project instead of one alert per child.
const isUnnamedSession = (alert: LatencyAlert) => alert.name === alert.sessionId || /^(git|dir):/.test(alert.name);
const seconds = (ms: number | null) => `${((ms ?? 0) / 1000).toFixed(1)} s`;
const KIND_LABEL: Record<Kind, string> = { p90: "slow p90", single: "slow pass", timeout: "timeout", park: "park", refusal: "refused turn", module_climb: "module time climbing", busy_refusal: "storage-busy refusal", busy_replay: "busy-storage replay", long_lock: "long lock holder" };

/** Only a park or a refused turn needs to interrupt; latency alone is reported at medium urgency. */
export function alertUrgency(alerts: LatencyAlert[]): "high" | "normal" {
    return alerts.some((alert) => alert.kind === "park" || alert.kind === "refusal") ? "high" : "normal";
}

export function formatAlerts(alerts: LatencyAlert[]): string {
    const groups = new Map<string, { label: string; sessions: Set<string>; alerts: LatencyAlert[] }>();
    for (const alert of alerts) {
        const unnamed = alert.kind !== "long_lock" && isUnnamedSession(alert);
        const key = unnamed ? `project:${alert.name}` : `session:${alert.sessionId}`;
        const group = groups.get(key) ?? { label: alert.name, sessions: new Set<string>(), alerts: [] };
        group.sessions.add(alert.sessionId);
        group.alerts.push(alert);
        groups.set(key, group);
    }
    const lines = [...groups.entries()].map(([key, group]) => {
        const counts = new Map<Kind, number>();
        for (const alert of group.alerts) counts.set(alert.kind, (counts.get(alert.kind) ?? 0) + 1);
        const kinds = [...counts.entries()].map(([kind, count]) => `${count} ${KIND_LABEL[kind]}${count > 1 ? "s" : ""}`).join(", ");
        const worst = group.alerts.reduce((a, b) => (b.max > a.max ? b : a));
        const p90 = Math.max(...group.alerts.map((alert) => alert.p90));
        const who = key.startsWith("project:") ? `${group.label} (${group.sessions.size} unnamed session${group.sessions.size > 1 ? "s" : ""})` : group.label;
        const declines = group.alerts.filter((alert) => alert.kind === "refusal")
            .flatMap((alert) => Object.entries(alert.lkgDeclines).map(([reason, count]) => `${count} ${reason}`));
        const locks = group.alerts.flatMap((alert) => alert.lock ? [alert.lock] : []).map((lock) => `${lock.site} max ${seconds(lock.max)}, p90 ${seconds(lock.p90)} (${lock.count} holds)`);
        const busy = group.alerts.flatMap((alert) => alert.busy ? [alert.busy] : []).at(-1);
        return `- ${who}: ${kinds}; worst pass ${seconds(worst.max)} (module ${seconds(worst.moduleMax)}); p90 up to ${seconds(p90)}${busy ? `; busy storage ${busy.refusals} refusals, ${busy.replays} replays/hour` : ""}${locks.length ? `; lock ${locks.join(", ")}` : ""}${declines.length ? `; LKG declines ${declines.join(", ")}` : ""}`;
    });
    const load = alerts[0]?.load.map((value) => value.toFixed(0)).join("/") ?? "?";
    const from = alerts.map((alert) => alert.at).sort()[0];
    return `Magic Context transform latency since ${from} (load now ${load}):\n${lines.join("\n")}`;
}

async function deliver(options: LatencyOptions, content: string, id: string, urgency: "high" | "normal"): Promise<void> {
    if (options.wake) return options.wake(content, id);
    const client = await SubcClient.connect({ connectionFile: options.connectionFile, handshakeTimeoutMs: 2_000 });
    try {
        const reply = await client.call("prefrontal-core", "agent.deliver", {
            agent_id: AGENT_ID, delivery_id: id,
            body: { kind: "peer_message", from_agent: "mc-transform-latency-sentinel", from_session_id: "health-sentinel-mc", from_harness: "magic-context", content, one_way: true }, urgency,
        }, { identity: { project_root: process.cwd(), harness: "magic-context", session: "health-sentinel-mc" }, consumerIdentity: null, timeoutMs: 15_000 });
        parseAgentDeliverReply(reply);
    } finally { client.close(); }
}

export async function runLatencySentinel(options: LatencyOptions): Promise<{ alerts: LatencyAlert[]; declines: LkgDeclineSummary[]; examined: number; bounded: boolean; files: Record<string, Cursor> }> {
    const now = (options.now ?? Date.now)();
    const state = options.replay || options.summary ? empty() : readState(options.stateFile);
    const alerts: LatencyAlert[] = [];
    let examined = 0;
    let bounded = false;
    for (const file of options.files) {
        if (!existsSync(file)) continue;
        do {
            const result = readNewLines(file, state.files[file], MAX_BYTES);
            state.files[file] = result.cursor;
            bounded ||= result.bounded;
            examined += result.lines.length;
            for (const line of result.lines) {
                const at = Date.parse(line.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/)?.[0] ?? "");
                if ((options.since !== undefined && at < options.since) || (options.until !== undefined && at >= options.until) || at > now) continue;
                alerts.push(...addLine(state, line, options.load ?? loadavg, file));
            }
            if (!(options.replay || options.summary) || !result.bounded || result.lines.length === 0) break;
        } while (true);
    }
    const declines = Object.entries(state.sessions).flatMap(([sessionId, session]) =>
        Object.entries(session.declines ?? {}).map(([hour, reasons]) => ({ sessionId, hour, reasons }))
    ).sort((a, b) => a.hour.localeCompare(b.hour) || a.sessionId.localeCompare(b.sessionId));
    for (const [id, session] of Object.entries(state.sessions)) {
        if (session.lastAt < now - 24 * HOUR) delete state.sessions[id];
        else for (const hour of Object.keys(session.declines ?? {}))
            if (Date.parse(hour) < now - 24 * HOUR) delete session.declines![hour];
    }
    for (const [key, sent] of Object.entries(state.sent)) if (sent.at < now - 6 * HOUR) delete state.sent[key];
    const today = new Date(now).toISOString().slice(0, 10);
    const yesterday = new Date(now - 24 * HOUR).toISOString().slice(0, 10);
    const daily = {
        kind: "transform_latency_daily_summary", day: yesterday,
        busy: Object.entries(state.busy ?? {}).flatMap(([sessionId, hours]) => Object.entries(hours)
            .filter(([hour]) => hour.startsWith(yesterday)).map(([hour, counts]) => ({ sessionId, hour, ...counts }))),
        holds: (state.holds ?? []).filter((hold) => new Date(hold.at).toISOString().startsWith(yesterday)).length,
        longHolds: (state.holds ?? []).filter((hold) => new Date(hold.at).toISOString().startsWith(yesterday) && hold.ms > LONG_LOCK_MS).length,
    };
    const writeDaily = !(options.replay || options.summary) && state.lastSummaryDay !== today;
    if (writeDaily) state.lastSummaryDay = today;
    for (const [id, hours] of Object.entries(state.busy ?? {})) {
        for (const hour of Object.keys(hours)) if (Date.parse(hour) < now - 48 * HOUR) delete hours[hour];
        if (!Object.keys(hours).length) delete state.busy![id];
    }
    state.holds = (state.holds ?? []).filter((hold) => hold.at > now - 48 * HOUR);
    names(options.db, options.peerDb, alerts.filter((alert) => alert.kind !== "long_lock" && alert.sessionId !== UNKNOWN_SESSION));
    if (!(options.replay || options.summary)) saveState(options.stateFile, state);
    if (writeDaily) (options.stdout ?? console.log)(JSON.stringify(daily));
    if (options.summary) (options.stdout ?? console.log)(JSON.stringify({ kind: "lkg_decline_summary", declines }));
    else if (alerts.length) {
        const content = formatAlerts(alerts);
        const id = `mc-transform-latency-${now}-${examined}`;
        if (options.send) await deliver(options, content, id, alertUrgency(alerts));
        else (options.stdout ?? console.log)(JSON.stringify({ delivery_id: id, alerts }));
    }
    (options.stderr ?? console.error)(JSON.stringify({ kind: "transform_latency_sentinel_summary", examined, alerts: alerts.length, bounded, watermark: state.files }));
    return { alerts, declines, examined, bounded, files: state.files };
}

if (import.meta.main) {
    try {
        setStoragePrivatePermissionEnforcement(
            loadPluginConfig(process.cwd()).storage.enforce_private_permissions,
        );
        const args = process.argv.slice(2);
        const values = new Map<string, string>();
        const flags = new Set(["--opencode-log", "--pi-log", "--module-log", "--harness-log", "--pi-runner-log", "--db", "--peer-db", "--state-file", "--connection-file", "--since", "--until"]);
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "--once" || args[i] === "--send" || args[i] === "--replay" || args[i] === "--summary") continue;
            if (!flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`invalid argument: ${args[i]}`);
            values.set(args[i], args[++i]);
        }
        const replay = args.includes("--replay");
        if ((replay || args.includes("--summary")) && args.includes("--send")) throw new Error("replay and summary cannot send alerts");
        const storage = getMagicContextStorageDir();
        const date = new Date().toISOString().slice(0, 10);
        const opencodeLog = values.get("--opencode-log") ?? join(tmpdir(), "opencode/magic-context/magic-context.log");
        const options: LatencyOptions = {
            files: [args.includes("--summary") ? `${opencodeLog}.1` : "", opencodeLog, values.get("--pi-log") ?? join(tmpdir(), "pi/magic-context/magic-context.log"), values.get("--module-log") ?? join(homedir(), `.local/share/cortexkit/magic-context/logs/magic-context.${date}.log`),
                // Thalamus's runner logs, whose `step render` times stand in for the plugin's transform times.
                values.get("--harness-log") ?? join(homedir(), `.local/share/cortexkit/thalamus-harness/logs/thalamus-harness.${date}.log`),
                values.get("--pi-runner-log") ?? join(homedir(), `.local/share/cortexkit/thalamus-pi/logs/thalamus-pi.${date}.log`)],
            db: values.get("--db") ?? join(storage, "context.db"), peerDb: values.get("--peer-db") ?? join(getDataDir(), "cortexkit/prefrontal-core/store.db"), stateFile: values.get("--state-file") ?? join(storage, "transform-latency-sentinel-state.json"),
            connectionFile: values.get("--connection-file") ?? join(getDataDir(), "cortexkit/run/subc-connection.json"), send: args.includes("--send"), replay, summary: args.includes("--summary"),
            since: values.has("--since") ? Date.parse(values.get("--since")!) : undefined, until: values.has("--until") ? Date.parse(values.get("--until")!) : undefined,
        };
        if (options.since !== undefined && !Number.isFinite(options.since) || options.until !== undefined && !Number.isFinite(options.until)) throw new Error("invalid UTC range");
        do { await runLatencySentinel(options); if (args.includes("--once") || replay || options.summary) break; await Bun.sleep(300_000); } while (true);
    } catch (error) { console.error(error); process.exitCode = 1; }
}
