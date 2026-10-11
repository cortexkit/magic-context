#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SubcClient } from "@cortexkit/subc-client";
import { loadPluginConfig } from "../src/config";
import { getDataDir, getMagicContextStorageDir } from "../src/shared/data-path";
import {
    setStoragePrivatePermissionEnforcement,
    writeStorageFileAtomicSync,
} from "../src/shared/storage-permissions";
import { parseAgentDeliverReply } from "./cache-bust-sentinel";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_NEW = 500;
const MAX_HISTORY = 5_000;
const AGENT_ID = "agent_b613e5cf2ee55b8c";

type Row = {
    id: number;
    session_id: string;
    subagent: string;
    task: string | null;
    ended_at: number;
    status: string;
    error: string | null;
};
type Cursor = { ended_at: number; id: number };
type Sent = { at: number; count: number };
type State = { version: 1; cursor: Cursor; sent: Record<string, Sent> };
export type Alert = {
    rule: "new_class" | "failure_share" | "class_doubled";
    subagent: string;
    task: string;
    class: string;
    count: number;
    share: number;
    example_error: string;
    newest_session_id: string;
    empty: number;
    aborted: number;
};
export type FailureSentinelOptions = {
    db: string;
    stateFile: string;
    connectionFile: string;
    send: boolean;
    now?: () => number;
    wake?: (content: string, deliveryId: string) => Promise<void>;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
};

export function normalizeError(error: string | null): string {
    return (error ?? "(no error)")
        .replace(/(?:[a-zA-Z]:)?(?:\/[\w.~-]+){2,}/g, "<path>")
        .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, "<id>")
        .replace(/\b(?:0x[a-f0-9]+|[a-f0-9]{16,}|(?:session|task|run|agent|invocation|request|trace|job|msg|wi|ct)_[a-z0-9_-]+)\b/gi, "<id>")
        .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi, "<duration>")
        .replace(/\b\d+(?:\.\d+)?\b/g, "<number>")
        .replace(/\s+/g, " ")
        .trim();
}

function cursorAfter(row: Cursor, cursor: Cursor): boolean {
    return row.ended_at > cursor.ended_at || (row.ended_at === cursor.ended_at && row.id > cursor.id);
}

function loadState(path: string, now: number): State {
    if (!existsSync(path)) return { version: 1, cursor: { ended_at: now - 5 * 60_000, id: 0 }, sent: {} };
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object") throw new Error("invalid failure sentinel state");
    const state = value as State;
    if (state.version !== 1 || !Number.isSafeInteger(state.cursor?.ended_at) ||
        !Number.isSafeInteger(state.cursor?.id) || !state.sent || typeof state.sent !== "object") {
        throw new Error("invalid failure sentinel state");
    }
    return state;
}

function saveState(path: string, state: State): void {
    writeStorageFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function key(alert: Alert): string {
    // The share rule describes the whole task, so one burst of mixed failure classes
    // must dedupe to a single alert instead of re-firing for every class it contains.
    const klass = alert.rule === "failure_share" ? "*" : alert.class;
    return JSON.stringify([alert.rule, alert.subagent, alert.task, klass]);
}

export function evaluateFailures(rows: Row[], newRows: Row[], now: number, completeSince: number): Alert[] {
    const failures = (row: Row) => row.status === "failed" || row.status === "timed_out";
    const taskName = (row: Row) => row.task ?? "(untitled)";
    const alerts: Alert[] = [];
    const seen = new Set<string>();
    for (const row of newRows) {
        if (!failures(row) || row.ended_at < now - DAY) continue;
        const task = taskName(row);
        const klass = normalizeError(row.error);
        const group = rows.filter((candidate) => candidate.subagent === row.subagent && taskName(candidate) === task);
        const current = group.filter((candidate) => candidate.ended_at > now - DAY);
        const prior = group.filter((candidate) => candidate.ended_at > now - 2 * DAY && candidate.ended_at <= now - DAY);
        const classRows = current.filter((candidate) => failures(candidate) && normalizeError(candidate.error) === klass);
        const oldClass = prior.filter((candidate) => failures(candidate) && normalizeError(candidate.error) === klass);
        const failuresToday = current.filter(failures).length;
        const share = current.length ? failuresToday / current.length : 0;
        const base = {
            subagent: row.subagent, task, class: klass, count: classRows.length, share,
            example_error: row.error ?? "(no error)",
            newest_session_id: classRows.at(0)?.session_id ?? row.session_id,
            empty: current.filter((candidate) => candidate.status === "empty").length,
            aborted: current.filter((candidate) => candidate.status === "aborted").length,
        };
        const earlier = rows.some((candidate) =>
            candidate.subagent === row.subagent && taskName(candidate) === task && failures(candidate) &&
            normalizeError(candidate.error) === klass && candidate.ended_at >= row.ended_at - 7 * DAY &&
            candidate.ended_at < row.ended_at && cursorAfter(row, candidate));
        const rules: Alert["rule"][] = [];
        if (completeSince <= now - 7 * DAY && !earlier) rules.push("new_class");
        if (completeSince <= now - DAY && current.length >= 8 && share >= 0.25) rules.push("failure_share");
        if (completeSince <= now - 2 * DAY && oldClass.length > 0 && classRows.length >= 2 * oldClass.length) rules.push("class_doubled");
        for (const rule of rules) {
            // A share alert counts every failure of the task, so the 50% re-alert
            // threshold tracks the task's failures rather than one class's.
            const alert =
                rule === "failure_share"
                    ? { rule, ...base, class: "*", count: failuresToday }
                    : { rule, ...base };
            if (!seen.has(key(alert))) { alerts.push(alert); seen.add(key(alert)); }
        }
    }
    return alerts;
}

async function deliver(options: FailureSentinelOptions, content: string, id: string): Promise<void> {
    if (options.wake) return options.wake(content, id);
    const client = await SubcClient.connect({ connectionFile: options.connectionFile, handshakeTimeoutMs: 2_000 });
    try {
        const reply = await client.call("prefrontal-core", "agent.deliver", {
            agent_id: AGENT_ID, delivery_id: id,
            body: { kind: "peer_message", from_agent: "mc-subagent-failure-sentinel",
                from_session_id: "health-sentinel-mc", from_harness: "magic-context", content,
                // A script sends this, so replies cannot reach it.
                one_way: true },
            urgency: "high",
        }, { identity: { project_root: process.cwd(), harness: "magic-context", session: "health-sentinel-mc" },
            consumerIdentity: null, timeoutMs: 15_000 });
        parseAgentDeliverReply(reply);
    } finally { client.close(); }
}

export async function runFailureSentinel(options: FailureSentinelOptions): Promise<{ examined: number; alerts: Alert[]; bounded: boolean }> {
    const now = (options.now ?? Date.now)();
    const log = options.stderr ?? console.error;
    const output = options.stdout ?? console.log;
    log(JSON.stringify({ kind: "subagent_failure_sentinel_start", at: new Date(now).toISOString() }));
    const state = loadState(options.stateFile, now);
    for (const [key, sent] of Object.entries(state.sent)) {
        if (now - sent.at >= 6 * HOUR) delete state.sent[key];
    }
    let db: Database | undefined;
    let examined = 0;
    let bounded = false;
    let alerts: Alert[] = [];
    try {
        if (!existsSync(options.db)) throw new Error(`context database missing: ${options.db}`);
        db = new Database(options.db, { readonly: true });
        db.exec("PRAGMA busy_timeout = 3000");
        const fields = "id, session_id, subagent, task, ended_at, status, error";
        const next = db.query(`SELECT ${fields} FROM subagent_invocations WHERE ended_at IS NOT NULL AND ended_at <= ? AND (ended_at > ? OR (ended_at = ? AND id > ?)) ORDER BY ended_at, id LIMIT ?`)
            .all(now, state.cursor.ended_at, state.cursor.ended_at, state.cursor.id, MAX_NEW + 1) as Row[];
        bounded = next.length > MAX_NEW;
        const fresh = next.slice(0, MAX_NEW);
        examined += next.length;
        if (fresh.length) {
            const history = db.query(`SELECT ${fields} FROM subagent_invocations WHERE ended_at > ? AND ended_at <= ? ORDER BY ended_at DESC, id DESC LIMIT ?`)
                .all(now - 7 * DAY, now, MAX_HISTORY + 1) as Row[];
            examined += history.length;
            bounded ||= history.length > MAX_HISTORY;
            const rows = history.slice(0, MAX_HISTORY);
            const completeSince = history.length > MAX_HISTORY ? rows.at(-1)!.ended_at : now - 7 * DAY;
            alerts = evaluateFailures(rows, fresh, now, completeSince).filter((alert) => {
                const previous = state.sent[key(alert)];
                return !previous || now - previous.at >= 6 * HOUR || alert.count >= Math.ceil(previous.count * 1.5);
            });
            for (const row of fresh) state.cursor = { ended_at: row.ended_at, id: row.id };
        }
    } finally { db?.close(false); }
    if (alerts.length) {
        const content = `Magic Context subagent failure sentinel: ${JSON.stringify(alerts)}`;
        const id = `mc-subagent-failure-${now}-${state.cursor.id}`;
        // Reserve the dedupe keys before network I/O so an ambiguous delivery cannot cause a repeated wake.
        for (const alert of alerts) state.sent[key(alert)] = { at: now, count: alert.count };
        saveState(options.stateFile, state);
        if (options.send) await deliver(options, content, id);
        else output(JSON.stringify({ delivery_id: id, alerts }));
    } else saveState(options.stateFile, state);
    log(JSON.stringify({ kind: "subagent_failure_sentinel_summary", at: new Date((options.now ?? Date.now)()).toISOString(), examined, alerts: alerts.length, bounded, watermark: state.cursor }));
    return { examined, alerts, bounded };
}

function parseArgs(args: string[]): FailureSentinelOptions & { once: boolean; interval: number } {
    const values = new Map<string, string>();
    const flags = new Set(["--db", "--state-file", "--connection-file", "--interval-ms"]);
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--once" || args[i] === "--send") continue;
        if (!flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`invalid argument: ${args[i]}`);
        values.set(args[i], args[++i]);
    }
    const interval = values.has("--interval-ms") ? Number(values.get("--interval-ms")) : 60_000;
    if (!Number.isSafeInteger(interval) || interval < 60_000 || interval > 300_000) throw new Error("interval must be 60000–300000 ms");
    const storage = getMagicContextStorageDir();
    return { once: args.includes("--once"), send: args.includes("--send"), interval,
        db: values.get("--db") ?? join(storage, "context.db"),
        stateFile: values.get("--state-file") ?? join(storage, "subagent-failure-sentinel-state.json"),
        connectionFile: values.get("--connection-file") ?? join(getDataDir(), "cortexkit", "run", "subc-connection.json") };
}

if (import.meta.main) {
    try {
        setStoragePrivatePermissionEnforcement(
            loadPluginConfig(process.cwd()).storage.enforce_private_permissions,
        );
        const options = parseArgs(process.argv.slice(2));
        do {
            await runFailureSentinel(options);
            if (options.once) break;
            await Bun.sleep(options.interval);
        } while (true);
    } catch (error) { console.error(error); process.exitCode = 1; }
}
