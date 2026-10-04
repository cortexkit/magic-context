// src/session.ts
import { createHash } from "node:crypto";
import { readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/transcript.ts
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function toolResultText(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  const fragments = [];
  for (const item of content) {
    if (isObject(item) && item.type === "text" && typeof item.text === "string") {
      fragments.push(item.text);
    }
  }
  return fragments.join(`
`);
}
function normalizeToolInput(input) {
  if (!isObject(input))
    return input ?? {};
  if (typeof input.file_path === "string" && input.filePath === undefined) {
    return { ...input, filePath: input.file_path };
  }
  return input;
}
function blockSignature(block) {
  return block.type === "text" ? `t:${block.text}` : `c:${block.callID}`;
}
function parseTimestamp(value) {
  if (typeof value !== "string")
    return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function tagContent(text, tag) {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}
function userText(text) {
  if (text.trim().length === 0)
    return null;
  if (/^\s*<local-command-(?:stdout|stderr|caveat)>/.test(text))
    return null;
  const command = tagContent(text, "command-name");
  if (command !== null && /^\s*<command-(?:name|message|args)>/.test(text)) {
    const args = tagContent(text, "command-args");
    return args ? `${command} ${args}` : command;
  }
  return text;
}
function isConversationRecord(record) {
  if (record.isSidechain === true)
    return false;
  if (record.isMeta === true)
    return false;
  if (record.isCompactSummary === true)
    return false;
  if (record.isVisibleInTranscriptOnly === true)
    return false;
  if (record.queueTranscriptOnly === true)
    return false;
  return true;
}
function toRawMessage(message, ordinal) {
  const parts = message.blocks.map((block) => {
    if (block.type === "text")
      return { type: "text", text: block.text };
    const state = { input: block.input };
    if (block.output !== undefined) {
      state.status = block.error ? "error" : "completed";
      if (block.error)
        state.error = block.output;
      else
        state.output = block.output;
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
    ...message.createdAt === null ? {} : { createdAt: message.createdAt }
  };
}
function parseClaudeCodeTranscript(text) {
  const records = [];
  let skippedLines = 0;
  for (const line of text.split(`
`)) {
    const trimmed = line.trim();
    if (trimmed.length === 0)
      continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isObject(parsed))
        records.push(parsed);
      else
        skippedLines++;
    } catch {
      skippedLines++;
    }
  }
  let boundaryPosition = -1;
  for (let position = records.length - 1;position >= 0; position--) {
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
  const logical = [];
  const assistantByProviderId = new Map;
  const toolBlockByCallId = new Map;
  const appendBlocks = (message, blocks, recordUuid) => {
    const known = new Set(message.blocks.map(blockSignature));
    for (const block of blocks) {
      const signature = blockSignature(block);
      if (known.has(signature))
        continue;
      known.add(signature);
      message.blocks.push(block);
    }
    message.version = `${recordUuid}:${message.blocks.length}`;
  };
  records.forEach((record, position) => {
    if (record.type !== "user" && record.type !== "assistant")
      return;
    if (!isConversationRecord(record))
      return;
    const message = record.message;
    if (!isObject(message) || message.role !== record.type)
      return;
    const uuid = asString(record.uuid) ?? `record-${position}`;
    const createdAt = parseTimestamp(record.timestamp);
    const content = message.content;
    if (record.type === "user") {
      const textBlocks = [];
      const orphanResults = [];
      if (typeof content === "string") {
        const text = userText(content);
        if (text !== null)
          textBlocks.push({ type: "text", text });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (!isObject(item))
            continue;
          if (item.type === "text" && typeof item.text === "string") {
            const text = userText(item.text);
            if (text !== null)
              textBlocks.push({ type: "text", text });
          } else if (item.type === "tool_result") {
            const callID = asString(item.tool_use_id);
            if (callID === null)
              continue;
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
                error: item.is_error === true
              });
            }
          }
        }
      }
      const blocks = [...textBlocks, ...orphanResults];
      if (blocks.length === 0)
        return;
      logical.push({
        id: uuid,
        role: "user",
        firstPosition: position,
        createdAt,
        blocks,
        version: `${uuid}:${blocks.length}`
      });
      return;
    }
    const blocks = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!isObject(item))
          continue;
        if (item.type === "text" && typeof item.text === "string") {
          if (item.text.trim().length > 0)
            blocks.push({ type: "text", text: item.text });
        } else if (item.type === "tool_use") {
          const callID = asString(item.id);
          if (callID === null)
            continue;
          blocks.push({
            type: "tool",
            tool: asString(item.name) ?? "unknown",
            callID,
            input: normalizeToolInput(item.input)
          });
        }
      }
    } else if (typeof content === "string" && content.trim().length > 0) {
      blocks.push({ type: "text", text: content });
    }
    if (blocks.length === 0)
      return;
    const providerMessageId = asString(message.id);
    const existing = providerMessageId === null ? undefined : assistantByProviderId.get(providerMessageId);
    const fresh = existing ? blocks.filter((block) => block.type === "text" || !existing.blocks.some((candidate) => candidate.type === "tool" && candidate.callID === block.callID)) : blocks;
    const target = existing ?? {
      id: providerMessageId ?? uuid,
      role: "assistant",
      firstPosition: position,
      createdAt,
      blocks: [],
      version: uuid
    };
    if (!existing) {
      logical.push(target);
      if (providerMessageId !== null)
        assistantByProviderId.set(providerMessageId, target);
    }
    appendBlocks(target, fresh, uuid);
    for (const block of fresh) {
      if (block.type === "tool")
        toolBlockByCallId.set(block.callID, block);
    }
  });
  const compactedThroughOrdinal = keepFromPosition < 0 ? 0 : logical.filter((message) => message.firstPosition < keepFromPosition).length;
  return {
    messages: logical.map((message, index) => toRawMessage(message, index + 1)),
    compactedThroughOrdinal,
    skippedLines
  };
}
var SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
function claudeConfigDir(env = process.env) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(homedir(), ".claude");
}
function encodeProjectDirectory(directory) {
  return directory.replace(/[^a-zA-Z0-9]/g, "-");
}
function locateTranscript(options) {
  if (options.transcriptPath && existsSync(options.transcriptPath)) {
    return options.transcriptPath;
  }
  if (!SESSION_ID_PATTERN.test(options.sessionId))
    return null;
  const projectsRoot = join(options.configDir ?? claudeConfigDir(), "projects");
  const fileName = `${options.sessionId}.jsonl`;
  if (options.directory) {
    const candidates = new Set([options.directory]);
    try {
      candidates.add(realpathSync.native(options.directory));
    } catch {}
    for (const candidate of candidates) {
      const path = join(projectsRoot, encodeProjectDirectory(candidate), fileName);
      if (existsSync(path))
        return path;
    }
  }
  let entries;
  try {
    entries = readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(projectsRoot, entry, fileName);
    if (existsSync(path))
      return path;
  }
  return null;
}
var transcriptCache = new Map;
var TRANSCRIPT_CACHE_LIMIT = 8;
function readClaudeCodeTranscript(path) {
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
    if (oldest !== undefined)
      transcriptCache.delete(oldest);
  }
  return parsed;
}
function createTranscriptSource(path) {
  return {
    path,
    provider: { readMessages: () => readClaudeCodeTranscript(path).messages },
    compactedThroughOrdinal: () => readClaudeCodeTranscript(path).compactedThroughOrdinal
  };
}

// src/session.ts
var SESSION_ID_PATTERN2 = /^[A-Za-z0-9._-]{1,128}$/;
function isValidSessionId(value) {
  return typeof value === "string" && SESSION_ID_PATTERN2.test(value);
}
function resolveProjectDirectory(env = process.env, fallback = process.cwd()) {
  const fromEnv = env.CLAUDE_PROJECT_DIR?.trim();
  return fromEnv ? fromEnv : fallback;
}
function newestTranscriptSessionId(directory, env) {
  const projectDirectory = join2(claudeConfigDir(env), "projects", encodeProjectDirectory(directory));
  let newest = null;
  let entries;
  try {
    entries = readdirSync2(projectDirectory);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl"))
      continue;
    const id = entry.slice(0, -".jsonl".length);
    if (!isValidSessionId(id))
      continue;
    try {
      const { mtimeMs } = statSync2(join2(projectDirectory, entry));
      if (!newest || mtimeMs > newest.mtimeMs)
        newest = { id, mtimeMs };
    } catch {}
  }
  return newest?.id ?? null;
}
function resolveMcpSession(env = process.env, cwd = process.cwd()) {
  const directory = resolveProjectDirectory(env, cwd);
  const fromEnv = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (isValidSessionId(fromEnv))
    return { sessionId: fromEnv, directory, source: "env" };
  const newest = newestTranscriptSessionId(directory, env);
  if (newest)
    return { sessionId: newest, directory, source: "newest-transcript" };
  const digest = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  return { sessionId: `claude-code-${digest}`, directory, source: "project-fallback" };
}
function resolveHookSession(payload, env = process.env, cwd = process.cwd()) {
  const sessionId = isValidSessionId(payload.session_id) ? payload.session_id : env.CLAUDE_CODE_SESSION_ID?.trim() ?? "";
  if (!isValidSessionId(sessionId))
    return null;
  const payloadCwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : cwd;
  return { sessionId, directory: resolveProjectDirectory(env, payloadCwd), source: "hook" };
}

export { locateTranscript, createTranscriptSource, isValidSessionId, resolveMcpSession, resolveHookSession };
