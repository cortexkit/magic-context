import { constants, Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BodyProvider } from "./cache-bust-body-sources";

export type RunnerKind = "oc2" | "pi";
export const DEFAULT_RUNNER_DATA_DIR = join(homedir(), ".local/share/cortexkit");
export interface RunnerRequest {
    id: string;
    parentId?: string;
    at: number;
    streamedAt?: number;
    completedAt?: number;
    sequence: number;
    model: string;
    provider: string;
    variant?: string;
    usage?: { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number; totalTokens?: number; cost?: unknown };
}
export interface RunnerSession {
    kind: RunnerKind;
    session: string;
    files: string[];
    requests: RunnerRequest[];
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" ? value as Json : {};
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function usage(input: unknown, output: unknown, read: unknown, write: unknown): RunnerRequest["usage"] {
    const values = [input, output, read, write].map(number);
    if (values.some((value) => value === undefined || value < 0)) return undefined;
    return { input: values[0]!, output: values[1]!, cacheRead: values[2]!, cacheWrite: values[3]! };
}

/** A known provider/model is required; unknown meters must not masquerade as Anthropic. */
export function runnerMeter(request: RunnerRequest): BodyProvider | undefined {
    if (/anthropic/i.test(request.provider) || /(?:^|\/)claude[-.]/i.test(request.model)) return "anthropic";
    if (/openai/i.test(request.provider)) return "openai";
    if (/google|gemini/i.test(request.provider)) return "gemini";
    return undefined;
}

export function runnerDumpDirectory(root: string, kind: RunnerKind): string {
    return join(root, kind === "oc2" ? "thalamus-harness/opencode2-server/tmp/opencode-anthropic-auth-dumps" : "thalamus-pi/anthropic-auth-dumps");
}

function loadOc2(root: string, session: string): RunnerSession | undefined {
    const path = join(root, "thalamus-harness/opencode2-server/data/opencode/opencode.db");
    if (!existsSync(path)) return undefined;
    // URI read-only mode preserves the live WAL view without opening any account tables.
    const db = new Database(`${pathToFileURL(path).href}?mode=ro`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
    try {
        const rows = db.query("SELECT seq, data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq")
            .all(session) as { seq: number; data: string }[];
        if (!rows.length) return undefined;
        const requests = rows.map((row): RunnerRequest => {
            const data = object(JSON.parse(row.data));
            const tokens = object(data.tokens);
            const cache = object(tokens.cache);
            const time = object(data.time);
            const model = object(data.model);
            const at = number(time.created);
            if (at === undefined) throw new Error(`OC2 assistant seq=${row.seq} has no request time`);
            const reading = usage(tokens.input, tokens.output, cache.read, cache.write);
            return {
                id: String(row.seq), at, streamedAt: number(time.streamed), completedAt: number(time.completed), sequence: row.seq,
                model: String(model.id ?? ""), provider: String(model.providerID ?? ""),
                ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
                usage: reading ? { ...reading, reasoning: number(tokens.reasoning) } : undefined,
            };
        });
        return { kind: "oc2", session, files: [path], requests };
    } finally { db.close(); }
}

function loadPi(root: string, session: string): RunnerSession | undefined {
    const directory = join(root, "thalamus-pi/hosted-heads");
    if (!existsSync(directory)) return undefined;
    const matches = new Map<string, string[]>();
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
        const metadataPath = join(directory, file);
        const metadata = object(JSON.parse(readFileSync(metadataPath, "utf8")));
        if (typeof metadata.session_file !== "string") continue;
        const sessionPath = resolve(dirname(metadataPath), metadata.session_file);
        const id = basename(sessionPath).match(/(?:^|_)([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$/i)?.[1];
        if (id !== session) continue;
        matches.set(sessionPath, [...(matches.get(sessionPath) ?? []), metadataPath]);
    }
    if (matches.size > 1) throw new Error(`Multiple hosted Pi files for session ${session}`);
    const match = [...matches][0];
    if (!match) return undefined;
    const [path, metadataPaths] = match;
    const requests: RunnerRequest[] = [];
    const lines = readFileSync(path, "utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
        if (!lines[index]!.trim()) continue;
        let entry: Json;
        try { entry = object(JSON.parse(lines[index]!)); }
        catch (error) {
            // A live JSONL writer may not have finished its final record yet.
            if (index === lines.length - 1) break;
            throw error;
        }
        const message = object(entry.message);
        if (entry.type !== "message" || message.role !== "assistant") continue;
        const at = number(message.timestamp) ?? Date.parse(String(entry.timestamp));
        if (!Number.isFinite(at)) throw new Error(`Pi assistant ${entry.id} has no request time`);
        const tokens = object(message.usage);
        const reading = usage(tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite);
        requests.push({
            id: String(entry.id), parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
            at, sequence: index, model: String(message.model ?? ""), provider: String(message.provider ?? ""),
            usage: reading ? { ...reading, totalTokens: number(tokens.totalTokens), cost: tokens.cost } : undefined,
        });
    }
    return { kind: "pi", session, files: [...metadataPaths, path], requests };
}

export function loadRunnerSession(root: string, session: string, kind?: RunnerKind): RunnerSession | undefined {
    if (kind === "oc2") return loadOc2(root, session);
    if (kind === "pi") return loadPi(root, session);
    return loadOc2(root, session) ?? loadPi(root, session);
}
