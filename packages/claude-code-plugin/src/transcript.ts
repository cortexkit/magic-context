/**
 * Claude Code transcript reader.
 *
 * Claude Code keeps every session as a JSONL file under
 * `<config dir>/projects/<encoded cwd>/<session id>.jsonl`. This module turns one
 * of those files into the `RawMessage[]` the shared Magic Context readers
 * (`ctx_search`'s message lane, `ctx_expand`, the session formatter) already
 * understand, using the same OpenCode-shaped parts the Pi adapter synthesizes:
 *
 *   - text            -> `{ type: "text", text }`
 *   - tool call       -> `{ type: "tool", tool, callID, state: { input, output | error } }`
 *
 * Tool results are paired onto the assistant message that made the call, because
 * that is where OpenCode keeps them and where `ctx_expand(message=N)` looks for a
 * tool's full output. Thinking blocks and images are dropped.
 *
 * What the file records beyond the conversation, and how it is treated:
 *
 *   - One assistant API message is written as several records sharing
 *     `message.id` (one per streamed content block). They merge into one logical
 *     message; identical blocks replayed after a compaction are not added twice.
 *   - A `system` record with `subtype: "compact_boundary"` marks a compaction.
 *     The user record that follows it carrying `isCompactSummary` is Claude
 *     Code's generated summary, not something anyone said, so it is skipped.
 *   - Sidechain (subagent) records, `isMeta` records and transcript-only records
 *     are not part of the conversation and are skipped.
 *   - A slash command the user typed is recorded as `<command-name>` markup; it
 *     becomes the command line (`/compact`, `/plugin:cmd args`). The echo of a
 *     local command's output (`<local-command-stdout>`) is dropped.
 *
 * Ordinals are 1-based, in order of first appearance, and append-only: a new
 * record can extend the last message but never renumbers an earlier one.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";

export interface ParsedTranscript {
    messages: RawMessage[];
    /**
     * Number of leading messages that Claude Code's latest compaction removed from
     * the live context (they exist only in this file now). 0 when the session was
     * never compacted. Messages Claude Code kept verbatim through the compaction
     * (`preservedSegment`) are not counted.
     */
    compactedThroughOrdinal: number;
    /** Lines that were not valid JSON objects. */
    skippedLines: number;
}

interface TextBlock {
    type: "text";
    text: string;
}

interface ToolBlock {
    type: "tool";
    tool: string;
    callID: string;
    input: unknown;
    output?: string;
    error?: boolean;
}

type Block = TextBlock | ToolBlock;

interface LogicalMessage {
    id: string;
    role: "user" | "assistant";
    firstPosition: number;
    createdAt: number | null;
    blocks: Block[];
    version: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** Text of a `tool_result` content field: a string, or an array of text blocks. */
function toolResultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const fragments: string[] = [];
    for (const item of content) {
        if (isObject(item) && item.type === "text" && typeof item.text === "string") {
            fragments.push(item.text);
        }
    }
    return fragments.join("\n");
}

/**
 * Claude Code names the path argument `file_path`; the shared formatter's
 * one-line tool summaries look for `filePath`. Add the alias, never overwrite.
 */
function normalizeToolInput(input: unknown): unknown {
    if (!isObject(input)) return input ?? {};
    if (typeof input.file_path === "string" && input.filePath === undefined) {
        return { ...input, filePath: input.file_path };
    }
    return input;
}

function blockSignature(block: Block): string {
    return block.type === "text" ? `t:${block.text}` : `c:${block.callID}`;
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function tagContent(text: string, tag: string): string | null {
    const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return match ? match[1].trim() : null;
}

/** The text a user record contributes, or null when it is only command plumbing. */
function userText(text: string): string | null {
    if (text.trim().length === 0) return null;
    if (/^\s*<local-command-(?:stdout|stderr|caveat)>/.test(text)) return null;
    const command = tagContent(text, "command-name");
    if (command !== null && /^\s*<command-(?:name|message|args)>/.test(text)) {
        const args = tagContent(text, "command-args");
        return args ? `${command} ${args}` : command;
    }
    return text;
}

function isConversationRecord(record: JsonObject): boolean {
    if (record.isSidechain === true) return false;
    if (record.isMeta === true) return false;
    if (record.isCompactSummary === true) return false;
    if (record.isVisibleInTranscriptOnly === true) return false;
    if (record.queueTranscriptOnly === true) return false;
    return true;
}

function toRawMessage(message: LogicalMessage, ordinal: number): RawMessage {
    const parts: unknown[] = message.blocks.map((block) => {
        if (block.type === "text") return { type: "text", text: block.text };
        const state: Record<string, unknown> = { input: block.input };
        if (block.output !== undefined) {
            state.status = block.error ? "error" : "completed";
            if (block.error) state.error = block.output;
            else state.output = block.output;
        } else {
            state.status = "pending";
        }
        return { type: "tool", tool: block.tool, callID: block.callID, state };
    });
    return {
        ordinal,
        id: message.id,
        role: message.role,
        parts,
        version: message.version,
        ...(message.createdAt === null ? {} : { createdAt: message.createdAt }),
    };
}

export function parseClaudeCodeTranscript(text: string): ParsedTranscript {
    const records: JsonObject[] = [];
    let skippedLines = 0;
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (isObject(parsed)) records.push(parsed);
            else skippedLines++;
        } catch {
            skippedLines++;
        }
    }

    // The latest compaction decides what is still in Claude Code's live context.
    let boundaryPosition = -1;
    for (let position = records.length - 1; position >= 0; position--) {
        const record = records[position];
        if (record.type === "system" && record.subtype === "compact_boundary") {
            boundaryPosition = position;
            break;
        }
    }
    let keepFromPosition = boundaryPosition;
    if (boundaryPosition >= 0) {
        const metadata = records[boundaryPosition].compactMetadata;
        const segment = isObject(metadata) ? metadata.preservedSegment : undefined;
        const headUuid = isObject(segment) ? asString(segment.headUuid) : null;
        if (headUuid !== null) {
            const headPosition = records.findIndex((record) => record.uuid === headUuid);
            if (headPosition >= 0 && headPosition < boundaryPosition) {
                keepFromPosition = headPosition;
            }
        }
    }

    const logical: LogicalMessage[] = [];
    const assistantByProviderId = new Map<string, LogicalMessage>();
    const toolBlockByCallId = new Map<string, ToolBlock>();

    const appendBlocks = (message: LogicalMessage, blocks: Block[], recordUuid: string): void => {
        const known = new Set(message.blocks.map(blockSignature));
        for (const block of blocks) {
            const signature = blockSignature(block);
            if (known.has(signature)) continue;
            known.add(signature);
            message.blocks.push(block);
        }
        message.version = `${recordUuid}:${message.blocks.length}`;
    };

    records.forEach((record, position) => {
        if (record.type !== "user" && record.type !== "assistant") return;
        if (!isConversationRecord(record)) return;
        const message = record.message;
        if (!isObject(message) || message.role !== record.type) return;
        const uuid = asString(record.uuid) ?? `record-${position}`;
        const createdAt = parseTimestamp(record.timestamp);
        const content = message.content;

        if (record.type === "user") {
            const textBlocks: TextBlock[] = [];
            const orphanResults: ToolBlock[] = [];
            if (typeof content === "string") {
                const text = userText(content);
                if (text !== null) textBlocks.push({ type: "text", text });
            } else if (Array.isArray(content)) {
                for (const item of content) {
                    if (!isObject(item)) continue;
                    if (item.type === "text" && typeof item.text === "string") {
                        const text = userText(item.text);
                        if (text !== null) textBlocks.push({ type: "text", text });
                    } else if (item.type === "tool_result") {
                        const callID = asString(item.tool_use_id);
                        if (callID === null) continue;
                        const output = toolResultText(item.content);
                        const call = toolBlockByCallId.get(callID);
                        if (call) {
                            call.output = output;
                            call.error = item.is_error === true;
                        } else {
                            orphanResults.push({
                                type: "tool",
                                tool: "unknown",
                                callID,
                                input: {},
                                output,
                                error: item.is_error === true,
                            });
                        }
                    }
                }
            }
            const blocks: Block[] = [...textBlocks, ...orphanResults];
            // A record that only carried tool results is already attached to the
            // assistant message that made the calls; it is not a message of its own.
            if (blocks.length === 0) return;
            logical.push({
                id: uuid,
                role: "user",
                firstPosition: position,
                createdAt,
                blocks,
                version: `${uuid}:${blocks.length}`,
            });
            return;
        }

        const blocks: Block[] = [];
        if (Array.isArray(content)) {
            for (const item of content) {
                if (!isObject(item)) continue;
                if (item.type === "text" && typeof item.text === "string") {
                    if (item.text.trim().length > 0) blocks.push({ type: "text", text: item.text });
                } else if (item.type === "tool_use") {
                    const callID = asString(item.id);
                    if (callID === null) continue;
                    blocks.push({
                        type: "tool",
                        tool: asString(item.name) ?? "unknown",
                        callID,
                        input: normalizeToolInput(item.input),
                    });
                }
            }
        } else if (typeof content === "string" && content.trim().length > 0) {
            blocks.push({ type: "text", text: content });
        }
        if (blocks.length === 0) return;

        const providerMessageId = asString(message.id);
        const existing =
            providerMessageId === null ? undefined : assistantByProviderId.get(providerMessageId);
        // A tool block replayed after a compaction keeps the instance that already
        // holds its result, so later results still attach to the surviving block.
        const fresh = existing
            ? blocks.filter(
                  (block) =>
                      block.type === "text" ||
                      !existing.blocks.some(
                          (candidate) =>
                              candidate.type === "tool" && candidate.callID === block.callID,
                      ),
              )
            : blocks;
        const target: LogicalMessage =
            existing ??
            ({
                id: providerMessageId ?? uuid,
                role: "assistant",
                firstPosition: position,
                createdAt,
                blocks: [],
                version: uuid,
            } satisfies LogicalMessage);
        if (!existing) {
            logical.push(target);
            if (providerMessageId !== null) assistantByProviderId.set(providerMessageId, target);
        }
        appendBlocks(target, fresh, uuid);
        for (const block of fresh) {
            if (block.type === "tool") toolBlockByCallId.set(block.callID, block);
        }
    });

    const compactedThroughOrdinal =
        keepFromPosition < 0
            ? 0
            : logical.filter((message) => message.firstPosition < keepFromPosition).length;

    return {
        messages: logical.map((message, index) => toRawMessage(message, index + 1)),
        compactedThroughOrdinal,
        skippedLines,
    };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.CLAUDE_CONFIG_DIR?.trim();
    return configured ? configured : join(homedir(), ".claude");
}

/** How Claude Code names a project's transcript directory: every non-alphanumeric becomes `-`. */
export function encodeProjectDirectory(directory: string): string {
    return directory.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface LocateTranscriptOptions {
    sessionId: string;
    /** Directory Claude Code was started in (`CLAUDE_PROJECT_DIR`). */
    directory?: string;
    /** `transcript_path` from a hook payload; wins when it exists. */
    transcriptPath?: string;
    configDir?: string;
}

/**
 * Find a session's transcript file. The encoded project directory is only a fast
 * path: Claude Code does not promise that naming, so a miss falls back to looking
 * for `<session id>.jsonl` in every project directory.
 */
export function locateTranscript(options: LocateTranscriptOptions): string | null {
    if (options.transcriptPath && existsSync(options.transcriptPath)) {
        return options.transcriptPath;
    }
    if (!SESSION_ID_PATTERN.test(options.sessionId)) return null;
    const projectsRoot = join(options.configDir ?? claudeConfigDir(), "projects");
    const fileName = `${options.sessionId}.jsonl`;

    if (options.directory) {
        const candidates = new Set<string>([options.directory]);
        try {
            candidates.add(realpathSync.native(options.directory));
        } catch {
            // A directory that cannot be resolved still has its literal spelling.
        }
        for (const candidate of candidates) {
            const path = join(projectsRoot, encodeProjectDirectory(candidate), fileName);
            if (existsSync(path)) return path;
        }
    }
    let entries: string[];
    try {
        entries = readdirSync(projectsRoot);
    } catch {
        return null;
    }
    for (const entry of entries) {
        const path = join(projectsRoot, entry, fileName);
        if (existsSync(path)) return path;
    }
    return null;
}

interface CachedTranscript {
    size: number;
    mtimeMs: number;
    parsed: ParsedTranscript;
}

const transcriptCache = new Map<string, CachedTranscript>();
const TRANSCRIPT_CACHE_LIMIT = 8;

/** Parse a transcript file, reusing the last parse while the file is unchanged. */
export function readClaudeCodeTranscript(path: string): ParsedTranscript {
    const stat = statSync(path);
    const cached = transcriptCache.get(path);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.parsed;
    }
    const parsed = parseClaudeCodeTranscript(readFileSync(path, "utf8"));
    transcriptCache.delete(path);
    transcriptCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, parsed });
    if (transcriptCache.size > TRANSCRIPT_CACHE_LIMIT) {
        const oldest = transcriptCache.keys().next().value;
        if (oldest !== undefined) transcriptCache.delete(oldest);
    }
    return parsed;
}

export interface TranscriptSource {
    /** The per-session provider the shared readers consult. */
    provider: RawMessageProvider;
    /** See {@link ParsedTranscript.compactedThroughOrdinal}. */
    compactedThroughOrdinal: () => number;
    path: string;
}

export function createTranscriptSource(path: string): TranscriptSource {
    return {
        path,
        provider: { readMessages: () => readClaudeCodeTranscript(path).messages },
        compactedThroughOrdinal: () => readClaudeCodeTranscript(path).compactedThroughOrdinal,
    };
}

/** Test seam: forget every cached parse. */
export function __resetTranscriptCacheForTests(): void {
    transcriptCache.clear();
}
