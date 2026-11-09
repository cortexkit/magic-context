import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";
/**
 * The three line shapes this reader accepts, discriminated by shape alone:
 *   fleet-r2 — `<ts> <LEVEL> <logger>: [<bound fields>] <message> <fields>`
 *   fleet-r1 — `<ts> <LEVEL> magic-context <session=…> <tag=…>* <message> <fields>`
 *   legacy   — `[<ts>] [magic-context][<session>] <message> <fields>`
 * r2 replaced r1's module column and `tag=` field with a dotted logger name and
 * moved the session into a bracket of bound context. Old files are never
 * rewritten, so all three keep parsing.
 */
export type LogGrammar = "fleet-r2" | "fleet-r1" | "legacy";
export type DetectedLogGrammar = LogGrammar | "mixed" | "unknown";
/** `opencode2` is the OpenCode 2 plugin, which logs under its own temp subtree. */
export type LogHarness = "opencode" | "opencode2" | "pi" | "omp";

export interface LogLineRecord {
    ts: string;
    level: LogLevel | null;
    /**
     * The dotted logger name r2 writes before the colon (`magic-context.historian`).
     * The two older grammars name only the module, so they report the bare
     * module id.
     */
    logger: string;
    session: string | null;
    /**
     * Logger segments below the module id (`magic-context.perf` → `["perf"]`).
     * r1 wrote the same distinction as repeated `tag=` fields, so consumers
     * that filter on a component keep reading one field across grammars.
     */
    tags: string[];
    /**
     * Context bound to a scope rather than to a single event: r2's bracket,
     * r1's leading `session=`. Values stay exactly as written
     * (`session=opencode:ses_x`) so a consumer can filter on a binding;
     * `session` above is the bare id the session pickers show.
     */
    bound: Record<string, string>;
    message: string;
    /** Decoded message and event fields, before the parser separates trailing k=v tokens. */
    rawMessage: string;
    kv: Record<string, string>;
}

export interface ParsedLogLine extends LogLineRecord {
    grammar: LogGrammar;
}

export interface LogFileInspection {
    path: string;
    exists: boolean;
    sizeKb: number;
    lineCount: number;
    grammar: DetectedLogGrammar;
}

const FLEET_ENVELOPE =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (TRACE|DEBUG|INFO |WARN |ERROR) (.*)$/;
const LEGACY_LINE = /^\[([^\]]+)\] \[magic-context\]\[([^\]]*)\]\s+(.*)$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** An r2 logger name: dotted segments of `[a-z][a-z0-9-]*`, rooted at the module id. */
const LOGGER_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
/** The module id the two pre-r2 grammars hard-code in their envelope. */
const MODULE_ID = "magic-context";

interface Token {
    raw: string;
    start: number;
}

function tokenize(input: string, limit = Number.POSITIVE_INFINITY): Token[] | null {
    const tokens: Token[] = [];
    let index = 0;
    while (index < input.length && tokens.length < limit) {
        while (input[index] === " ") index += 1;
        if (index >= input.length) break;
        const start = index;
        let quoted = false;
        let escaped = false;
        while (index < input.length) {
            const char = input[index];
            if (escaped) {
                escaped = false;
            } else if (quoted && char === "\\") {
                escaped = true;
            } else if (char === '"') {
                quoted = !quoted;
            } else if (!quoted && char === " ") {
                break;
            }
            index += 1;
        }
        if (quoted || escaped) return null;
        tokens.push({ raw: input.slice(start, index), start });
    }
    return tokens;
}

function decodeEscapes(value: string): string | null {
    let decoded = "";
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char !== "\\") {
            decoded += char;
            continue;
        }
        const next = value[index + 1];
        if (next === undefined) return null;
        if (next === "n") decoded += "\n";
        else if (next === '"') decoded += '"';
        else if (next === "\\") decoded += "\\";
        else if (next === "u") {
            const hex = value.slice(index + 2, index + 6);
            if (!/^[0-9a-f]{4}$/.test(hex)) return null;
            decoded += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
        } else return null;
        index += 1;
    }
    return decoded;
}

function parseField(token: string): [string, string] | null {
    const equals = token.indexOf("=");
    if (equals <= 0) return null;
    const key = token.slice(0, equals);
    if (!FIELD_NAME.test(key)) return null;
    const rawValue = token.slice(equals + 1);
    if (rawValue.startsWith('"')) {
        if (rawValue.length < 2 || !rawValue.endsWith('"')) return null;
        const value = decodeEscapes(rawValue.slice(1, -1));
        return value === null ? null : [key, value];
    }
    if (rawValue.length === 0 || rawValue.includes('"')) return null;
    return [key, rawValue];
}

/** Every token of `input` as fields, or null when any token is not one. */
function parseFieldList(input: string): [string, string][] | null {
    const tokens = tokenize(input);
    if (!tokens) return null;
    const fields: [string, string][] = [];
    for (const token of tokens) {
        const field = parseField(token.raw);
        if (!field) return null;
        fields.push(field);
    }
    return fields;
}

/**
 * Index of the `]` closing a bracket opened at index 0, or -1 when none closes
 * it. A `]` inside a quoted value is not the end of the bracket, which is why
 * r2 quotes a bound value containing a space.
 */
function boundBracketEnd(input: string): number {
    let quoted = false;
    let escaped = false;
    for (let index = 1; index < input.length; index += 1) {
        const char = input[index];
        if (escaped) escaped = false;
        else if (quoted && char === "\\") escaped = true;
        else if (char === '"') quoted = !quoted;
        else if (char === "]" && !quoted) return index;
    }
    return -1;
}

/**
 * True when a bracketed field list trails the message. r2 puts bound context
 * before the message so its column is stable, so a line that binds after the
 * message is malformed rather than a line with late context.
 */
function trailingBoundBracket(input: string): boolean {
    const trimmed = input.trimEnd();
    if (!trimmed.endsWith("]")) return false;
    const open = trimmed.lastIndexOf("[");
    // A space before `[` keeps an event field value such as `args=[a=1]` out of
    // this check; a bracket at index 0 is the bound bracket itself.
    if (open <= 0 || trimmed[open - 1] !== " ") return false;
    const fields = parseFieldList(trimmed.slice(open + 1, -1));
    return fields !== null && fields.length > 0;
}

function trailingToken(input: string, end: number): Token | null {
    let index = end;
    let quoted = false;
    while (index > 0) {
        const char = input[index - 1];
        if (char === '"') {
            let slashStart = index - 1;
            while (input[slashStart - 1] === "\\") slashStart -= 1;
            if ((index - 1 - slashStart) % 2 === 0) quoted = !quoted;
            index = slashStart;
        } else if (char === " " && !quoted) {
            break;
        } else {
            index -= 1;
        }
    }
    return quoted ? null : { raw: input.slice(index, end), start: index };
}

interface MessageSplitOptions {
    decodeMessage: boolean;
    /**
     * r2 lets a record carry fields and no message at all (`engram.retention:
     * pruned=3 kept=14`), so its last remaining token may be consumed as a
     * field. The older grammars keep the first token as prose instead, so a
     * message that is itself `key=value` (`status=failed`) survives as the
     * message it was written as.
     */
    allowEmptyMessage: boolean;
}

function splitMessageAndFields(
    input: string,
    { decodeMessage, allowEmptyMessage }: MessageSplitOptions,
): { message: string; rawMessage: string; kv: Record<string, string> } {
    // Message prose is opaque: only consume a well-formed field suffix from the right.
    // An unmatched quote earlier in the message must not hide the entire record.
    let messageEnd = input.trimEnd().length;
    const fields: [string, string][] = [];
    while (messageEnd > 0) {
        const token = trailingToken(input, messageEnd);
        const field = token && parseField(token.raw);
        if (!token || !field || (token.start === 0 && !allowEmptyMessage)) break;
        fields.push(field);
        messageEnd = token.start;
        while (messageEnd > 0 && input[messageEnd - 1] === " ") messageEnd -= 1;
    }
    const rawMessage = fields.length > 0 ? input.slice(0, messageEnd) : input;
    const message = decodeMessage ? (decodeEscapes(rawMessage) ?? rawMessage) : rawMessage;
    const kv: Record<string, string> = {};
    for (const [key, value] of fields.reverse()) kv[key] = value;
    return { message, rawMessage: decodeMessage ? (decodeEscapes(input) ?? input) : input, kv };
}

function rawSessionId(value: string): string | null {
    if (!value || value === "global") return null;
    const colon = value.indexOf(":");
    if (colon <= 0 || colon === value.length - 1) return null;
    return value.slice(colon + 1);
}

/**
 * r2: `<logger>: [<bound fields>] <message> <event fields>`. The bracket is
 * absent whenever a scope binds nothing, never empty.
 */
function parseFleetR2(
    ts: string,
    level: LogLevel,
    logger: string,
    body: string,
): ParsedLogLine | null {
    if (!LOGGER_NAME.test(logger)) return null;
    let remaining = body;
    const bound: Record<string, string> = {};
    if (remaining.startsWith("[")) {
        const end = boundBracketEnd(remaining);
        if (end >= 0) {
            const inner = remaining.slice(1, end);
            if (inner.trim().length === 0) return null;
            const fields = parseFieldList(inner);
            // A bracketed phrase that is not a field list (`[dreamer] tick fired`)
            // is message prose: only a well-formed field list is lifted as context.
            if (fields) {
                for (const [key, value] of fields) bound[key] = value;
                remaining = remaining.slice(end + 1).trimStart();
            }
        }
    }
    if (trailingBoundBracket(remaining)) return null;
    const session = bound.session === undefined ? null : rawSessionId(bound.session);
    // A bound session is a match key against a session store: an id without its
    // issuer, or the old `global` placeholder, names nothing.
    if (bound.session !== undefined && session === null) return null;
    const parsed = splitMessageAndFields(remaining, {
        decodeMessage: true,
        allowEmptyMessage: true,
    });
    return {
        ts,
        level,
        logger,
        session,
        tags: logger.split(".").slice(1),
        bound,
        ...parsed,
        grammar: "fleet-r2",
    };
}

/** r1: `magic-context <session=…> <tag=…>* <message> <event fields>`. */
function parseFleetR1(ts: string, level: LogLevel, body: string): ParsedLogLine | null {
    let remaining = body;
    const bound: Record<string, string> = {};
    const tags: string[] = [];
    let session: string | null = null;
    if (remaining.startsWith("session=")) {
        const token = tokenize(remaining, 1)?.[0];
        if (!token || token.raw.includes("\u001b")) return null;
        const sessionField = parseField(token.raw);
        if (!sessionField) return null;
        session = rawSessionId(sessionField[1]);
        if (!session) return null;
        // r1 has no bracket; `session=` in the column before the message is the
        // one binding it expresses, so consumers read it from the same place.
        bound.session = sessionField[1];
        remaining = remaining.slice(token.raw.length).trimStart();
    }
    while (remaining.startsWith("tag=")) {
        const token = tokenize(remaining, 1)?.[0];
        if (!token || token.raw.includes("\u001b")) return null;
        const tagField = parseField(token.raw);
        if (!tagField?.[1]) return null;
        tags.push(tagField[1]);
        remaining = remaining.slice(token.raw.length).trimStart();
    }
    const parsed = splitMessageAndFields(remaining, {
        decodeMessage: true,
        allowEmptyMessage: false,
    });
    return {
        ts,
        level,
        logger: MODULE_ID,
        session,
        tags,
        bound,
        ...parsed,
        grammar: "fleet-r1",
    };
}

export function parseLogLine(line: string): ParsedLogLine | null {
    const fleet = FLEET_ENVELOPE.exec(line);
    if (fleet) {
        const ts = fleet[1];
        if (Number.isNaN(Date.parse(ts)) || new Date(ts).toISOString() !== ts) return null;
        const level = fleet[2].trim() as LogLevel;
        const body = fleet[3];
        // One envelope, two fleet grammars: r2 terminates its logger with a
        // colon and r1 puts the bare module id in the same column, so the colon
        // is the whole discriminator. Without it the name reads as the first
        // word of the message, which is why r2 requires it.
        const headEnd = body.indexOf(" ");
        const head = headEnd < 0 ? body : body.slice(0, headEnd);
        const remaining = headEnd < 0 ? "" : body.slice(headEnd + 1).trimStart();
        if (head.endsWith(":")) return parseFleetR2(ts, level, head.slice(0, -1), remaining);
        if (head === MODULE_ID) return parseFleetR1(ts, level, remaining);
        return null;
    }

    const legacy = LEGACY_LINE.exec(line);
    if (!legacy || legacy[2].includes("\u001b") || Number.isNaN(Date.parse(legacy[1]))) return null;
    const body = splitMessageAndFields(legacy[3], {
        decodeMessage: false,
        allowEmptyMessage: false,
    });
    const legacySession = legacy[2].trim();
    return {
        ts: legacy[1],
        level: null,
        logger: MODULE_ID,
        session: legacySession && legacySession !== "global" ? legacySession : null,
        tags: [],
        // The legacy session sits in a fixed bracket slot rather than in a field
        // list, so there is nothing to lift as bound context.
        bound: {},
        ...body,
        grammar: "legacy",
    };
}

const LEVEL_ORDER: Record<LogLevel, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
/** No level clears this threshold, which is what `off` means. */
const LEVEL_OFF = Number.POSITIVE_INFINITY;
const LEVEL_DEFAULT = LEVEL_ORDER.INFO;

interface LogLevelSpec {
    root: number;
    directives: { logger: string; threshold: number }[];
}

function levelThreshold(token: string): number | null {
    const level = token.trim().toUpperCase();
    if (level === "OFF") return LEVEL_OFF;
    return level in LEVEL_ORDER ? LEVEL_ORDER[level as LogLevel] : null;
}

/**
 * Parse a CK_LOG spec: comma-separated directives, each either a bare level
 * (the root default) or `<logger>=<level>`. A spec that does not parse falls
 * back to the default, info — a logging knob with a typo in it must not
 * silence the fleet.
 */
function parseLogLevelSpec(spec: string): LogLevelSpec {
    const fallback: LogLevelSpec = { root: LEVEL_DEFAULT, directives: [] };
    const trimmed = spec.trim();
    if (!trimmed) return fallback;
    const directives: { logger: string; threshold: number }[] = [];
    let root = LEVEL_DEFAULT;
    for (const raw of trimmed.split(",")) {
        const directive = raw.trim();
        if (!directive) return fallback;
        const equals = directive.indexOf("=");
        if (equals < 0) {
            const threshold = levelThreshold(directive);
            if (threshold === null) return fallback;
            root = threshold;
            continue;
        }
        const logger = directive.slice(0, equals).trim();
        const threshold = levelThreshold(directive.slice(equals + 1));
        if (!LOGGER_NAME.test(logger) || threshold === null) return fallback;
        directives.push({ logger, threshold });
    }
    return { root, directives };
}

/**
 * Would a record at (`level`, `logger`) be emitted under this CK_LOG spec?
 *
 * A directive names a logger prefix and applies to it and every name beneath
 * it; the most specific matching directive decides. The prefix is matched on
 * dotted segments, not on characters, so `aft` covers `aft.index` but not
 * `aftershock`.
 *
 * This reads the same grammar the writers filter on, so a reader can tell
 * which lines a given CK_LOG would have kept out of a file it is looking at.
 */
export function logSpecAdmits(spec: string, level: LogLevel, logger: string): boolean {
    const { root, directives } = parseLogLevelSpec(spec);
    let threshold = root;
    let matchedDepth = -1;
    for (const directive of directives) {
        if (logger !== directive.logger && !logger.startsWith(`${directive.logger}.`)) continue;
        const depth = directive.logger.split(".").length;
        if (depth >= matchedDepth) {
            matchedDepth = depth;
            threshold = directive.threshold;
        }
    }
    return LEVEL_ORDER[level] >= threshold;
}

export interface LogPathOptions {
    tempDir?: string;
    storageDir?: string;
    override?: string | null;
}

export function getMagicContextLogPaths(
    harness: LogHarness,
    options: LogPathOptions = {},
): string[] {
    const override =
        options.override === undefined
            ? process.env.MAGIC_CONTEXT_LOG_PATH?.trim()
            : options.override?.trim();
    const storageLogs = join(options.storageDir ?? getMagicContextStorageDir(), "logs");
    return [
        ...(override ? [override] : []),
        join(options.tempDir ?? tmpdir(), harness, "magic-context", "magic-context.log"),
        join(storageLogs, `magic-context.${harness}.log`),
        join(storageLogs, "magic-context.log"),
    ].filter((path, index, paths) => paths.indexOf(path) === index);
}

export function inspectLogFile(path: string): LogFileInspection {
    if (!existsSync(path)) {
        return { path, exists: false, sizeKb: 0, lineCount: 0, grammar: "unknown" };
    }
    try {
        const content = readFileSync(path, "utf8");
        const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
        const grammars = new Set(
            lines.flatMap((line) => {
                const parsed = parseLogLine(line);
                return parsed ? [parsed.grammar] : [];
            }),
        );
        const grammar: DetectedLogGrammar =
            grammars.size > 1 ? "mixed" : (grammars.values().next().value ?? "unknown");
        return {
            path,
            exists: true,
            sizeKb: Math.round(statSync(path).size / 1024),
            lineCount: lines.length,
            grammar,
        };
    } catch {
        return { path, exists: true, sizeKb: 0, lineCount: 0, grammar: "unknown" };
    }
}

export function inspectMagicContextLogs(
    harness: LogHarness,
    options: LogPathOptions = {},
): LogFileInspection[] {
    return getMagicContextLogPaths(harness, options).map(inspectLogFile);
}

export function readLogLines(
    files: readonly Pick<LogFileInspection, "path" | "exists">[],
): string[] {
    const lines = files.flatMap((file, fileIndex) => {
        if (!file.exists) return [];
        try {
            let precedingTimestamp = "";
            return readFileSync(file.path, "utf8")
                .split(/\r?\n/)
                .filter((line) => line.length > 0)
                .map((line, lineIndex) => {
                    precedingTimestamp = parseLogLine(line)?.ts ?? precedingTimestamp;
                    return { line, timestamp: precedingTimestamp, fileIndex, lineIndex };
                });
        } catch {
            return [];
        }
    });
    lines.sort(
        (left, right) =>
            left.timestamp.localeCompare(right.timestamp) ||
            left.fileIndex - right.fileIndex ||
            left.lineIndex - right.lineIndex,
    );
    return lines.map(({ line }) => line);
}

export function formatLogFileInspection(file: LogFileInspection): string {
    return `${file.path} (grammar=${file.grammar}, lines=${file.lineCount}, ${file.sizeKb} KB)`;
}
