import {
  log
} from "./chunk-e4mkgkj9.js";

// ../plugin/src/shared/internal-initiator-marker.ts
var OMO_INTERNAL_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->";

// ../plugin/src/shared/system-directive.ts
var SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";
function isSystemDirective(text) {
  return text.trimStart().startsWith(SYSTEM_DIRECTIVE_PREFIX);
}
function removeSystemReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

// ../plugin/src/hooks/magic-context/read-session-formatting.ts
import { createRequire } from "node:module";

// ../plugin/src/shared/commit-detection.ts
var HASH_HEX = "[0-9a-f]{7,12}";
var COMMIT_HASH_TEST_PATTERN = new RegExp(`\\b${HASH_HEX}\\b`, "i");
var COMMIT_VERB_PATTERN = /\b(?:commit(?:ted|ting|s)?|cherry-?pick(?:ed|ing|s)?|merge[ds]?|merging|rebas(?:e|ed|es|ing))\b/i;
function createCommitHashExtractPattern() {
  return new RegExp(`\`?\\b(${HASH_HEX})\\b\`?`, "gi");
}

// ../plugin/src/hooks/magic-context/read-session-formatting.ts
var MAX_COMMITS_PER_BLOCK = 5;
function hasMeaningfulUserText2(parts) {
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const candidate = part;
    if (candidate.type !== "text" || typeof candidate.text !== "string")
      continue;
    if (candidate.ignored === true)
      continue;
    const cleaned = removeSystemReminders(candidate.text).replace(OMO_INTERNAL_INITIATOR_MARKER, "").trim();
    if (!cleaned)
      continue;
    if (isSystemDirective(cleaned))
      continue;
    return true;
  }
  return false;
}
function extractTexts2(parts) {
  const texts = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const p = part;
    if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
      texts.push(p.text.trim());
    }
  }
  return texts;
}
function extractToolResultBodyTokens(parts) {
  let tokens = 0;
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const p = part;
    if (p.type !== "tool")
      continue;
    const state = p.state;
    if (!state || typeof state !== "object")
      continue;
    const body = state.output ?? state.error;
    if (body === undefined)
      continue;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    tokens += Math.ceil(text.length / 4);
  }
  return tokens;
}
function extractToolCallSummaries(parts) {
  const summaries = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const p = part;
    if (p.type !== "tool" || typeof p.tool !== "string")
      continue;
    const state = p.state;
    if (!state || typeof state !== "object")
      continue;
    const input = state.input;
    const metadata = state.metadata;
    const description = input && typeof input.description === "string" && input.description || metadata && typeof metadata.description === "string" && metadata.description;
    if (description) {
      summaries.push(`TC: ${description}`);
      continue;
    }
    const toolName = p.tool;
    const keyArg = extractKeyArg(toolName, input);
    summaries.push(keyArg ? `TC: ${toolName}(${keyArg})` : `TC: ${toolName}`);
  }
  return summaries;
}
function extractKeyArg(_toolName, input) {
  if (!input)
    return null;
  if (typeof input.filePath === "string")
    return truncateArg(input.filePath);
  if (typeof input.path === "string")
    return truncateArg(input.path);
  if (typeof input.pattern === "string")
    return truncateArg(input.pattern);
  if (typeof input.query === "string")
    return truncateArg(input.query);
  if (typeof input.symbol === "string")
    return input.symbol;
  if (typeof input.module === "string")
    return input.module;
  if (typeof input.action === "string")
    return input.action;
  return null;
}
function truncateArg(value, maxLen = 60) {
  if (value.length <= maxLen)
    return value;
  return `${value.slice(0, maxLen)}…`;
}
var tokenizer;
var tokenizerLoadAttempted = false;
var tokenizerWarningSent = false;
var tokenizerEncodingPath;
var tokenizerSerializedTableBytes;
function constructTokenizer(tokenizerModule, claudeEncoding) {
  const typedModule = tokenizerModule;
  const Tokenizer = typedModule.default ?? typedModule.Tokenizer;
  if (!Tokenizer) {
    throw new Error("ai-tokenizer does not expose a Tokenizer constructor");
  }
  return new Tokenizer(claudeEncoding);
}
function loadTokenizer() {
  const requireFromThisModule = createRequire(import.meta.url);
  const encodingSpecifier = "ai-tokenizer/encoding/" + "claude";
  tokenizerEncodingPath = requireFromThisModule.resolve(encodingSpecifier);
  tokenizerSerializedTableBytes = undefined;
  return constructTokenizer(requireFromThisModule("ai-" + "tokenizer"), requireFromThisModule(encodingSpecifier));
}
function warnTokenizerFallback(error) {
  if (tokenizerWarningSent)
    return;
  tokenizerWarningSent = true;
  const reason = error instanceof Error ? error.message : String(error);
  log("[magic-context] ai-tokenizer is unavailable; using approximate character-based token counts for this process. Token budgets, persisted per-message counts, and protected-tail/compartment boundaries may be less accurate until restart:", reason);
}
function getTokenizer() {
  if (tokenizer || tokenizerLoadAttempted)
    return tokenizer;
  tokenizerLoadAttempted = true;
  try {
    tokenizer = loadTokenizer();
  } catch (error) {
    warnTokenizerFallback(error);
  }
  return tokenizer;
}
function estimateTokensHeuristically(text) {
  return Math.ceil(text.length / 3.5);
}
var TOKEN_ESTIMATOR_SAMPLE = 'Coverage check: const windows = chunk(text, 0x1f, 512); // ok? "naïve" café 日本語 <EOT> 3.14159 ->  done.';
var estimatorFingerprintTokenizer;
var estimatorFingerprint = "";
function getTokenEstimatorFingerprint() {
  const activeTokenizer = getTokenizer();
  if (!activeTokenizer) {
    return `heuristic:${estimateTokensHeuristically(TOKEN_ESTIMATOR_SAMPLE)}`;
  }
  if (estimatorFingerprintTokenizer === activeTokenizer)
    return estimatorFingerprint;
  let fingerprint;
  try {
    fingerprint = `tokenizer:${activeTokenizer.encode(TOKEN_ESTIMATOR_SAMPLE, "all").length}`;
  } catch {
    fingerprint = "tokenizer:sample-unencodable";
  }
  estimatorFingerprintTokenizer = activeTokenizer;
  estimatorFingerprint = fingerprint;
  return fingerprint;
}
function estimateTokens(text) {
  if (!text)
    return 0;
  const activeTokenizer = getTokenizer();
  if (!activeTokenizer)
    return estimateTokensHeuristically(text);
  try {
    return activeTokenizer.encode(text, "all").length;
  } catch (error) {
    tokenizer = undefined;
    tokenizerLoadAttempted = true;
    warnTokenizerFallback(error);
    return estimateTokensHeuristically(text);
  }
}
function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function compactRole(role) {
  if (role === "assistant")
    return "A";
  if (role === "user")
    return "U";
  return role.slice(0, 1).toUpperCase() || "M";
}
function formatBlock(block) {
  const range = block.startOrdinal === block.endOrdinal ? `[${block.startOrdinal}]` : `[${block.startOrdinal}-${block.endOrdinal}]`;
  const commitSuffix = block.commitHashes.length > 0 ? ` commits: ${block.commitHashes.join(", ")}` : "";
  return `${range} ${block.role}:${commitSuffix} ${block.parts.join(" / ")}`;
}
function extractCommitHashes(text) {
  const hashes = [];
  const seen = new Set;
  for (const match of text.matchAll(createCommitHashExtractPattern())) {
    const hash = match[1]?.toLowerCase();
    if (!hash || seen.has(hash))
      continue;
    seen.add(hash);
    hashes.push(hash);
    if (hashes.length >= MAX_COMMITS_PER_BLOCK)
      break;
  }
  return hashes;
}
function compactTextForSummary(text, role) {
  const commitHashes = role === "assistant" ? extractCommitHashes(text) : [];
  if (commitHashes.length === 0 || !COMMIT_VERB_PATTERN.test(text)) {
    return { text, commitHashes };
  }
  const withoutHashes = text.replace(createCommitHashExtractPattern(), "").replace(/\(\s*\)/g, "").replace(/\s+,/g, ",").replace(/,\s*,+/g, ", ").replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
  return {
    text: withoutHashes.length > 0 ? withoutHashes : text,
    commitHashes
  };
}
function mergeCommitHashes(existing, next) {
  if (next.length === 0)
    return existing;
  const merged = [...existing];
  for (const hash of next) {
    if (merged.includes(hash))
      continue;
    merged.push(hash);
    if (merged.length >= MAX_COMMITS_PER_BLOCK)
      break;
  }
  return merged;
}

// ../plugin/src/shared/sqlite-helpers.ts
function closeQuietly(db) {
  if (!db)
    return;
  try {
    db.close();
  } catch {}
}

// ../plugin/src/shared/stable-json.ts
function stableStringify(value, seen = new WeakSet) {
  if (value === undefined)
    return "undefined";
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? String(value);
  if (seen.has(value))
    return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) => {
    if (a < b)
      return -1;
    if (a > b)
      return 1;
    return 0;
  });
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child, seen)}`).join(",")}}`;
}

// ../plugin/src/shared/opencode-db-path.ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
var cachedResolution = null;
var lastReadFailure = null;
var claimedDiagnostics = new Set;
function openCodeDataDir(env = process.env, dataHome) {
  return join(dataHome ?? env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
}
function environmentKey(dataDir, hostGeneration, channel, env) {
  return [
    hostGeneration,
    dataDir,
    env.OPENCODE_DB ?? "",
    env.OPENCODE_DISABLE_CHANNEL_DB ?? "",
    channel ?? env.OPENCODE_CHANNEL ?? ""
  ].join("\x00");
}
function channelPath(dataDir, channel) {
  return ["latest", "beta", "prod"].includes(channel) ? join(dataDir, "opencode.db") : join(dataDir, `opencode-${channel}.db`);
}
function discoveredCandidateNames(dataDir) {
  const names = ["opencode.db", "opencode-local.db", "opencode-dev.db"];
  try {
    const discovered = readdirSync(dataDir, { withFileTypes: true }).filter((entry) => /^opencode-.+\.db$/.test(entry.name) && !names.includes(entry.name)).map((entry) => entry.name).sort();
    names.push(...discovered);
  } catch {}
  return names;
}
function discoverOpenCodeDb(dataDir) {
  const candidates = discoveredCandidateNames(dataDir).map((name, order) => {
    const path = join(dataDir, name);
    try {
      const metadata = statSync(path);
      return metadata.isFile() ? { path, order, mtimeMs: metadata.mtimeMs } : null;
    } catch {
      return null;
    }
  });
  const existing = candidates.filter((candidate) => candidate !== null).sort((left, right) => right.mtimeMs - left.mtimeMs || left.order - right.order)[0];
  if (!existing) {
    return { path: join(dataDir, "opencode.db"), source: "default", channel: null };
  }
  const name = existing.path.slice(dataDir.length + 1);
  const channel = name === "opencode.db" ? null : name.slice("opencode-".length, -".db".length) || null;
  return { path: existing.path, source: "discovered", channel };
}
function resolveV1Fresh(dataDir, env = process.env) {
  const explicit = env.OPENCODE_DB;
  if (explicit !== undefined && explicit.length > 0) {
    if (explicit === ":memory:") {
      return { path: explicit, source: "OPENCODE_DB", channel: null };
    }
    return {
      path: isAbsolute(explicit) ? explicit : join(dataDir, explicit),
      source: "OPENCODE_DB",
      channel: null
    };
  }
  const disableChannelDb = env.OPENCODE_DISABLE_CHANNEL_DB;
  if (disableChannelDb === "1" || disableChannelDb === "true") {
    return { path: join(dataDir, "opencode.db"), source: "default", channel: null };
  }
  const channel = env.OPENCODE_CHANNEL;
  if (channel !== undefined && channel.length > 0) {
    return { path: channelPath(dataDir, channel), source: "channel", channel };
  }
  return discoverOpenCodeDb(dataDir);
}
function sourceOpenCodeDatabaseFilename(hostGeneration, channel, env = process.env) {
  if (hostGeneration === "v1") {
    const explicit = env.OPENCODE_DB;
    if (explicit !== undefined && explicit.length > 0)
      return explicit;
    if (env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true") {
      return "opencode.db";
    }
    return ["latest", "beta", "prod"].includes(channel) ? "opencode.db" : `opencode-${channel}.db`;
  }
  return env.OPENCODE_DB ?? (["latest", "dev", "beta", "next", "prod"].includes(channel) || env.OPENCODE_DISABLE_CHANNEL_DB === "1" || env.OPENCODE_DISABLE_CHANNEL_DB === "true" ? "opencode.db" : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "")}.db`);
}
function resolveV2Fresh(dataDir, channel, env) {
  const filename = sourceOpenCodeDatabaseFilename("v2", channel, env);
  const explicit = env.OPENCODE_DB !== undefined;
  return {
    path: filename === ":memory:" ? filename : resolve(dataDir, filename),
    source: explicit ? "OPENCODE_DB" : env.OPENCODE_CHANNEL ? "channel" : "default",
    channel: explicit ? null : channel
  };
}
function resolveOpenCodeDbPath(hostGeneration = "v1", options = {}) {
  const env = options.env ?? process.env;
  const dataDir = openCodeDataDir(env, options.dataHome);
  const channel = options.channel ?? env.OPENCODE_CHANNEL;
  const key = environmentKey(dataDir, hostGeneration, channel, env);
  if (cachedResolution?.key === key && (!cachedResolution.existed || existsSync(cachedResolution.resolution.path))) {
    if (cachedResolution.existed)
      return cachedResolution.resolution;
  }
  const resolution = hostGeneration === "v2" ? resolveV2Fresh(dataDir, channel ?? "latest", env) : resolveV1Fresh(dataDir, env);
  cachedResolution = {
    key,
    resolution,
    existed: resolution.path !== ":memory:" && existsSync(resolution.path)
  };
  return resolution;
}
function schemaTableNames(db, schema = "main") {
  const rows = db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name IN ('message', 'part', 'session', 'project', 'session_message', 'session_v2')`).all();
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}
function hasV1MessageTables(db, schema = "main") {
  const tables = schemaTableNames(db, schema);
  return tables.has("message") && tables.has("part");
}
function detectOpenCodeStoreGeneration(db, schema = "main") {
  const tables = schemaTableNames(db, schema);
  const hasV1Messages = tables.has("message") && tables.has("part");
  if (hasV1Messages)
    return "v1";
  if (tables.has("session_message"))
    return "v2";
  if (tables.has("session") || tables.has("project"))
    return "v1";
  return "unknown";
}
function hasMigratedV2Schema(tables) {
  return tables.has("session_message") && tables.has("session_v2");
}
function isOpenCodeV2Store(db, schema = "main") {
  return detectOpenCodeStoreGeneration(db, schema) === "v2" || hasMigratedV2Schema(schemaTableNames(db, schema));
}
function assertOpenCodeStoreGeneration(db, expected, path, schema = "main") {
  const actual = detectOpenCodeStoreGeneration(db, schema);
  if (actual === expected)
    return;
  if (expected === "v2" && isOpenCodeV2Store(db, schema))
    return;
  if (actual === "unknown")
    return;
  throw new Error(`OpenCode store generation mismatch at ${path}: expected ${expected}, found ${actual}; refusing generation-specific database access`);
}
function openCodeDbPathExists(resolution = resolveOpenCodeDbPath()) {
  return resolution.path !== ":memory:" && existsSync(resolution.path);
}
function getOpenCodeDbProbeDescriptions(resolution = resolveOpenCodeDbPath()) {
  if (resolution.source === "OPENCODE_DB")
    return [resolution.path];
  if (resolution.source === "channel" || process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" || process.env.OPENCODE_DISABLE_CHANNEL_DB === "true") {
    return [resolution.path];
  }
  const dataDir = openCodeDataDir();
  return [
    join(dataDir, "opencode.db"),
    join(dataDir, "opencode-local.db"),
    join(dataDir, "opencode-dev.db"),
    join(dataDir, "opencode-<channel>.db")
  ];
}
function recordOpenCodeDbReadFailure(resolution, error) {
  const message = error instanceof Error ? error.message : String(error);
  lastReadFailure = { ...resolution, message };
  return lastReadFailure;
}
function clearOpenCodeDbReadFailure(path) {
  if (path === undefined || lastReadFailure?.path === path)
    lastReadFailure = null;
}
function claimOpenCodeDbDiagnosticOnce(surface, resolution) {
  const key = `${surface}\x00${resolution.path}\x00${resolution.source}`;
  if (claimedDiagnostics.has(key))
    return false;
  claimedDiagnostics.add(key);
  return true;
}

// ../plugin/src/features/magic-context/tool-definition-tokens.ts
var measurements = new Map;
var fingerprints = new Map;
var persistenceDb = null;
var cachedInsertStmt = null;
function keyFor(providerID, modelID, agentName) {
  const agent = agentName && agentName.length > 0 ? agentName : "default";
  return `${providerID}/${modelID}/${agent}`;
}
function setDatabase(db) {
  persistenceDb = db;
  cachedInsertStmt = null;
}
function loadToolDefinitionMeasurements(db) {
  let rows = [];
  try {
    rows = db.prepare("SELECT provider_id, model_id, agent_name, tool_id, token_count FROM tool_definition_measurements").all();
  } catch {
    return;
  }
  for (const row of rows) {
    const key = keyFor(row.provider_id, row.model_id, row.agent_name);
    let inner = measurements.get(key);
    if (!inner) {
      inner = new Map;
      measurements.set(key, inner);
    }
    inner.set(row.tool_id, row.token_count);
  }
}

export { OMO_INTERNAL_INITIATOR_MARKER, isSystemDirective, removeSystemReminders, hasMeaningfulUserText2, extractTexts2, extractToolResultBodyTokens, extractToolCallSummaries, getTokenEstimatorFingerprint, estimateTokens, normalizeText, compactRole, formatBlock, compactTextForSummary, mergeCommitHashes, stableStringify, resolveOpenCodeDbPath, hasV1MessageTables, assertOpenCodeStoreGeneration, openCodeDbPathExists, getOpenCodeDbProbeDescriptions, recordOpenCodeDbReadFailure, clearOpenCodeDbReadFailure, claimOpenCodeDbDiagnosticOnce, closeQuietly, setDatabase, loadToolDefinitionMeasurements };
