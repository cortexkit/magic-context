import {
  OMO_INTERNAL_INITIATOR_MARKER,
  isSystemDirective,
  hasMeaningfulUserText2,
  extractTexts2,
  extractToolResultBodyTokens,
  extractToolCallSummaries,
  estimateTokens,
  normalizeText,
  compactRole,
  formatBlock,
  compactTextForSummary,
  mergeCommitHashes,
  stableStringify,
  resolveOpenCodeDbPath,
  assertOpenCodeStoreGeneration,
  openCodeDbPathExists,
  recordOpenCodeDbReadFailure,
  clearOpenCodeDbReadFailure,
  claimOpenCodeDbDiagnosticOnce,
  closeQuietly
} from "./chunk-q5f7wcc8.js";
import {
  harnessOwnsOpenCodeStore
} from "./chunk-6q6cxsv6.js";
import {
  log,
  Database
} from "./chunk-e4mkgkj9.js";

// ../plugin/src/hooks/magic-context/tag-content-primitives.ts
var encoder = new TextEncoder;

// ../plugin/src/shared/record-type-guard.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ../plugin/src/hooks/magic-context/image-token-estimate.ts
var JPEG_SCAN_LIMIT_BYTES = 256 * 1024;

// ../plugin/src/hooks/magic-context/todo-view.ts
var TODO_STATUS_PENDING = "pending";
var TODO_STATUS_IN_PROGRESS = "in_progress";
var TODO_STATUS_COMPLETED = "completed";
var TODO_STATUS_CANCELLED = "cancelled";
var TODO_PRIORITY_HIGH = "high";
var TODO_PRIORITY_MEDIUM = "medium";
var TODO_PRIORITY_LOW = "low";
var TODO_STATUSES = [
  TODO_STATUS_PENDING,
  TODO_STATUS_IN_PROGRESS,
  TODO_STATUS_COMPLETED,
  TODO_STATUS_CANCELLED
];
var TODO_PRIORITIES = [
  TODO_PRIORITY_HIGH,
  TODO_PRIORITY_MEDIUM,
  TODO_PRIORITY_LOW
];
var TODO_STATUS_SET = new Set(TODO_STATUSES);
var TODO_PRIORITY_SET = new Set(TODO_PRIORITIES);
var TERMINAL_STATUSES = new Set([
  TODO_STATUS_COMPLETED,
  TODO_STATUS_CANCELLED
]);
var TITLE_DONE_STATUSES = new Set([TODO_STATUS_COMPLETED]);

// ../plugin/src/hooks/magic-context/tail-hygiene-walk.ts
var MAX_CONTENT_MEMO_BYTES = 64 * 1024 * 1024;
var contentMemo = new Map;
var baselineMeasurementMemo = new Map;
var MAX_BASELINE_MEMO_SIZE = 32 * 1024 * 1024;

// ../plugin/src/hooks/magic-context/emergency-drop.ts
var T1_TOOLS = new Set(["read", "todowrite", "task", "aft_outline", "aft_zoom"]);
var T2_TOOLS = new Set(["edit", "write", "apply_patch", "grep", "glob", "aft_search"]);

// ../plugin/src/features/magic-context/storage-tags.ts
var insertTagStatements = new WeakMap;
var updateTagStatusStatements = new WeakMap;
var updateTagDropModeStatements = new WeakMap;
var updateTagMessageIdStatements = new WeakMap;
var getTagNumbersByMessageIdStatements = new WeakMap;
var deleteTagsByMessageIdStatements = new WeakMap;
var getMaxTagNumberBySessionStatements = new WeakMap;
var getTagNumberByMessageIdStatements = new WeakMap;
var getAssignableTagNumberByMessageIdStatements = new WeakMap;
var hasPiFallbackMessageTagStatements = new WeakMap;
var updateTagByteSizeStatements = new WeakMap;
var updateTagInputByteSizeStatements = new WeakMap;
var recentTagOwnerStatements = new WeakMap;
var RECLAIM_HINT_EXCLUDED_TOOLS = new Set([
  "ask",
  "bash_kill",
  "bash_status",
  "board",
  "task",
  "todoread",
  "todowrite",
  "work"
]);
var getActiveToolTagsForAgeReclaimStatements = new WeakMap;
var updateTagTokenCountStatements = new WeakMap;
var updateTagInputTokenCountStatements = new WeakMap;
function isTagRow(row) {
  if (row === null || typeof row !== "object")
    return false;
  const r = row;
  return typeof r.id === "number" && typeof r.message_id === "string" && typeof r.type === "string" && typeof r.status === "string" && typeof r.byte_size === "number" && typeof r.session_id === "string" && typeof r.tag_number === "number";
}
function toTagEntry(row) {
  const type = row.type === "tool" ? "tool" : row.type === "file" ? "file" : "message";
  const status = row.status === "dropped" || row.status === "compacted" ? row.status : "active";
  return {
    id: row.id,
    tagNumber: row.tag_number,
    messageId: row.message_id,
    type,
    status,
    dropMode: row.drop_mode === "truncated" ? "truncated" : row.drop_mode === "skeleton_real" ? "skeleton_real" : row.drop_mode === "skeleton_stripped" ? "skeleton_stripped" : row.drop_mode === "edit_marker" ? "edit_marker" : row.drop_mode === "edit_marker_stripped" ? "edit_marker_stripped" : "full",
    toolName: row.tool_name ?? null,
    inputByteSize: row.input_byte_size ?? 0,
    byteSize: row.byte_size,
    reasoningByteSize: row.reasoning_byte_size ?? 0,
    sessionId: row.session_id,
    cavemanDepth: typeof row.caveman_depth === "number" && Number.isFinite(row.caveman_depth) ? row.caveman_depth : 0,
    toolOwnerMessageId: typeof row.tool_owner_message_id === "string" ? row.tool_owner_message_id : null,
    tokenCount: typeof row.token_count === "number" ? row.token_count : null
  };
}
var foldStatements = new WeakMap;
var getOwnerScopedToolTagNumbersStatements = new WeakMap;
var getMinMessageTagNumberForRawIdStatements = new WeakMap;
var TAG_SELECT_COLUMNS = "id, message_id, type, status, drop_mode, tool_name, input_byte_size, byte_size, reasoning_byte_size, session_id, tag_number, caveman_depth, tool_owner_message_id, token_count";
var getActiveTagsBySessionStatements = new WeakMap;
var getNullOwnerToolTagsBySessionStatements = new WeakMap;
var getDroppedTagsBySessionStatements = new WeakMap;
var getMaxDroppedTagNumberStatements = new WeakMap;
function getTagById(db, sessionId, tagId) {
  const result = db.prepare(`SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND tag_number = ?`).get(sessionId, tagId);
  if (!isTagRow(result)) {
    return null;
  }
  return toTagEntry(result);
}
var getToolTagNumberByOwnerStatements = new WeakMap;
var getNullOwnerToolTagStatements = new WeakMap;
var adoptNullOwnerToolTagStatements = new WeakMap;
var getToolOwnerByTagIdStatements = new WeakMap;
var deleteToolTagsByOwnerStatements = new WeakMap;
function getCandidateToolOwners(db, sessionId, callId) {
  const rows = db.prepare(`SELECT DISTINCT tool_owner_message_id
             FROM tags
             WHERE session_id = ?
               AND message_id = ?
               AND type = 'tool'
               AND tool_owner_message_id IS NOT NULL`).all(sessionId, callId);
  return rows.map((r) => r.tool_owner_message_id);
}
function pickNearestPriorOwner(candidates, currentMessageId, times) {
  const currentTime = times.get(currentMessageId);
  if (typeof currentTime !== "number")
    return null;
  let best = null;
  for (const id of candidates) {
    const t = times.get(id);
    if (typeof t !== "number")
      continue;
    if (t > currentTime)
      continue;
    if (t === currentTime && id >= currentMessageId)
      continue;
    if (best === null || t > best.time || t === best.time && id > best.id) {
      best = { id, time: t };
    }
  }
  return best?.id ?? null;
}
// ../plugin/src/shared/historian-tool-defaults.json
var historian_tool_defaults_default = {
  ctx_note: "Note ${input.action} ${input.note_ids}: ${input.content} → ${output.truncate(160)}",
  ctx_memory: "Memory ${input.action} ${input.category} ${input.ids}: ${input.content} → ${output.truncate(160)}",
  todowrite: 'Todos (${input.todos.count}): ${input.todos.each("${status}: ${content}")}',
  question: 'Asked user: ${input.questions[*].question.join(" / ")} → ${output}',
  task: "Task ${input.subagent_type}: ${input.prompt} → ${output.truncate(200)}",
  ask: 'Asked: ${input.question.truncate(250)} [options: ${input.options.join(" / ")}] ${input.resolution} → ${output.truncate(300)}',
  peer_send: "PM to ${input.agent}${input.agent_id}: ${input.message.truncate(400)}",
  board: 'Board ${input.verb}: ${input.ops.each("${op} ${item}${lane.title} ${state}${lane.status}${props.text} ${lane.items[*].text}")}',
  room: "Room ${input.action} ${input.room_id}: ${input.text.truncate(400)}",
  work: "Work ${input.action} ${input.id}: ${input.prompt_file}${input.prompt.truncate(200)}${input.notes.truncate(200)} → ${output.truncate(160)}",
  knowhow: "Looked up how-to: ${input.query}${input.id}"
};

// ../plugin/src/shared/historian-tool-template.ts
class Parser {
  source;
  pos = 0;
  constructor(source) {
    this.source = source;
  }
  error() {
    throw new Error(`Invalid tool expansion template at character ${this.pos + 1}`);
  }
  take(value) {
    if (!this.source.startsWith(value, this.pos))
      return false;
    this.pos += value.length;
    return true;
  }
  field() {
    const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.source.slice(this.pos));
    if (!match)
      return this.error();
    this.pos += match[0].length;
    return match[0];
  }
  quoted() {
    const start = this.pos;
    if (!this.take('"'))
      return this.error();
    while (this.pos < this.source.length) {
      if (this.take("\\")) {
        this.pos++;
        continue;
      }
      if (this.take('"')) {
        try {
          return JSON.parse(this.source.slice(start, this.pos));
        } catch {
          return this.error();
        }
      }
      this.pos++;
    }
    return this.error();
  }
  integer() {
    const match = /^\d+/.exec(this.source.slice(this.pos));
    if (!match)
      return this.error();
    this.pos += match[0].length;
    const n = Number(match[0]);
    if (!Number.isSafeInteger(n))
      return this.error();
    return n;
  }
  expression(relative) {
    const steps = [];
    if (!(relative && this.take("."))) {
      const root = this.field();
      if (!relative && root !== "input" && root !== "output")
        return this.error();
      steps.push({ field: root });
    }
    while (true) {
      if (this.take("[")) {
        if (this.take("*]."))
          steps.push({ project: this.field() });
        else {
          const index = this.integer();
          if (!this.take("]"))
            return this.error();
          steps.push({ index });
        }
      } else if (this.source[this.pos] === "." && !/^\.(each\(|join\(|count(?:\.|\})|truncate\()/.test(this.source.slice(this.pos))) {
        this.pos++;
        steps.push({ field: this.field() });
        if (this.source[this.pos] === "(")
          return this.error();
      } else
        break;
    }
    const expression = { steps, cap: 300 };
    if (this.take(".each(")) {
      if (relative)
        return this.error();
      expression.each = parseTemplate(this.quoted(), true);
      if (!this.take(")"))
        return this.error();
    }
    if (this.take(".join(")) {
      expression.join = this.quoted();
      if (!this.take(")"))
        return this.error();
    }
    if (this.take(".count")) {
      if (expression.each || expression.join !== undefined)
        return this.error();
      expression.count = true;
    }
    if (this.take(".truncate(")) {
      expression.cap = this.integer();
      if (!this.take(")"))
        return this.error();
    }
    if (!this.take("}"))
      return this.error();
    return expression;
  }
  template(relative) {
    const nodes = [];
    while (this.pos < this.source.length) {
      const next = this.source.indexOf("${", this.pos);
      if (next < 0) {
        nodes.push(this.source.slice(this.pos));
        break;
      }
      nodes.push(this.source.slice(this.pos, next));
      this.pos = next + 2;
      nodes.push(this.expression(relative));
    }
    return nodes;
  }
}
function parseTemplate(source, relative = false) {
  return new Parser(source).template(relative);
}
function toolTemplateError(source) {
  try {
    parseTemplate(source);
    return;
  } catch (error) {
    return error.message;
  }
}
var templates = new Map;
function compiled(source) {
  if (!templates.has(source)) {
    try {
      templates.set(source, parseTemplate(source));
    } catch {
      templates.set(source, null);
    }
  }
  return templates.get(source) ?? null;
}
function oneLine(value) {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ");
}
function truncate(value, cap) {
  const chars = Array.from(oneLine(value));
  return chars.length > cap ? `${chars.slice(0, cap).join("")}…` : chars.join("");
}
function scalar(value) {
  if (value === undefined)
    return "";
  return typeof value === "string" ? value : compactJson(value);
}
function compactJson(value) {
  if (Array.isArray(value))
    return `[${value.map((v) => compactJson(v)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${compactJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function field(value, key) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}
function render(nodes, root) {
  return nodes.map((node) => {
    if (typeof node === "string")
      return node;
    let value = root;
    let list = false;
    for (const step of node.steps) {
      if ("field" in step)
        value = list && Array.isArray(value) ? value.map((item) => field(item, step.field)) : field(value, step.field);
      else if ("index" in step)
        value = Array.isArray(value) ? value[step.index] : undefined;
      else {
        value = Array.isArray(value) ? value.map((item) => field(item, step.project)) : undefined;
        list = true;
      }
    }
    if (node.count)
      return truncate(Array.isArray(value) ? String(value.length) : "", node.cap);
    if (node.each || list || node.join !== undefined) {
      if (!Array.isArray(value))
        return "";
      const elements = value.slice(0, 10).map((item) => truncate(node.each ? render(node.each, item) : scalar(item), 300));
      if (value.length > 10)
        elements.push(`… +${value.length - 10} more`);
      return truncate(elements.join(node.join ?? (node.each ? "; " : ", ")), node.cap);
    }
    return truncate(scalar(value), node.cap);
  }).join("");
}
function renderToolTemplate(source, input, output) {
  const nodes = compiled(source);
  if (!nodes)
    return null;
  const text = typeof output === "string" ? output : output === undefined ? "" : compactJson(output);
  let structured = output;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      structured = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      structured = undefined;
    }
  }
  const root = { input, output: structured };
  const bareOutputNodes = nodes.map((node) => typeof node !== "string" && node.steps.length === 1 && ("field" in node.steps[0]) && node.steps[0].field === "output" && !node.each && !node.count && node.join === undefined ? truncate(text ?? "", node.cap) : node);
  return truncate(render(bareOutputNodes, root), 1000);
}

// ../plugin/src/shared/historian-tool-expansions.ts
function expandToolPart(part, overrides) {
  if (!part || typeof part !== "object")
    return null;
  const p = part;
  if (p.type !== "tool" || typeof p.tool !== "string")
    return null;
  const template = overrides && Object.hasOwn(overrides, p.tool) ? overrides[p.tool] : Object.hasOwn(historian_tool_defaults_default, p.tool) ? historian_tool_defaults_default[p.tool] : undefined;
  if (typeof template !== "string")
    return null;
  const state = p.state;
  return renderToolTemplate(template, state?.input, state?.output ?? state?.error);
}

// ../plugin/src/hooks/magic-context/host-served-rows.ts
var HOST_UNSERVED_ROW = "hostUnservedRow";
function markHostUnservedRow(target) {
  Object.defineProperty(target, HOST_UNSERVED_ROW, {
    value: true,
    enumerable: false,
    configurable: true
  });
  return target;
}
function isHostUnservedRow(value) {
  return typeof value === "object" && value !== null && value[HOST_UNSERVED_ROW] === true;
}

// ../plugin/src/hooks/magic-context/read-session-db.ts
function openCodeDbExists() {
  return harnessOwnsOpenCodeStore() && openCodeDbPathExists(resolveOpenCodeDbPath());
}
var cachedReadOnlyDb = null;
function closeCachedReadOnlyDb() {
  if (!cachedReadOnlyDb) {
    return;
  }
  try {
    closeQuietly(cachedReadOnlyDb.db);
  } catch (error) {
    log("[magic-context] failed to close cached OpenCode read-only DB:", error);
  } finally {
    cachedReadOnlyDb = null;
  }
}
function getReadOnlySessionDb() {
  if (!harnessOwnsOpenCodeStore()) {
    throw new Error("OpenCode session database is not readable from a Pi-compatible process; its history lives in Pi sessions");
  }
  const resolution = resolveOpenCodeDbPath();
  const dbPath = resolution.path;
  if (!openCodeDbPathExists(resolution)) {
    throw new Error(`OpenCode session database is unavailable at ${dbPath} (source=${resolution.source})`);
  }
  if (cachedReadOnlyDb?.path === dbPath) {
    return cachedReadOnlyDb.db;
  }
  closeCachedReadOnlyDb();
  const db = new Database(dbPath, { readonly: true });
  try {
    assertOpenCodeStoreGeneration(db, "v1", dbPath);
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
  cachedReadOnlyDb = { path: dbPath, db };
  clearOpenCodeDbReadFailure();
  return db;
}
function withReadOnlySessionDb(fn) {
  return fn(getReadOnlySessionDb());
}
function getRawSessionMessageCountFromDb(db, sessionId) {
  const row = db.prepare(`SELECT COUNT(*) as count FROM message WHERE session_id = ?
             AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                      AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')`).get(sessionId);
  return typeof row?.count === "number" ? row.count : 0;
}
var trackedSessions = new Map;
var pendingParts = new Map;
var probeLogObserverForTests;
function logProbeFailureOnce(resolution, error) {
  const failure = recordOpenCodeDbReadFailure(resolution, error);
  if (!claimOpenCodeDbDiagnosticOnce("session-state-probe", resolution))
    return;
  const message = `[magic-context] OpenCode DB probe failed: path=${resolution.path} source=${resolution.source} cause=${failure.message}`;
  probeLogObserverForTests?.(message);
  log(message);
}
function getMessageTimesFromOpenCodeDb(sessionId, messageIds) {
  const result = new Map;
  if (messageIds.length === 0 || !harnessOwnsOpenCodeStore())
    return result;
  try {
    withReadOnlySessionDb((db) => {
      const placeholders = messageIds.map(() => "?").join(",");
      const rows = db.prepare(`SELECT id, time_created FROM message WHERE session_id = ? AND id IN (${placeholders})`).all(sessionId, ...messageIds);
      for (const row of rows) {
        if (typeof row.id === "string" && typeof row.time_created === "number") {
          result.set(row.id, row.time_created);
        }
      }
    });
  } catch (error) {
    logProbeFailureOnce(resolveOpenCodeDbPath(), error);
  }
  return result;
}

// ../plugin/src/hooks/magic-context/read-session-raw.ts
var RAW_MESSAGE_PARTS_BY_ID_SQL = "SELECT message_id, data, time_updated FROM part WHERE +session_id = ? AND likelihood(message_id = ?, 0.000001) ORDER BY time_created ASC, id ASC";
function isRawMessageRow(row) {
  if (row === null || typeof row !== "object")
    return false;
  const candidate = row;
  return typeof candidate.id === "string" && typeof candidate.data === "string";
}
function isRawPartRow(row) {
  if (row === null || typeof row !== "object")
    return false;
  const candidate = row;
  return typeof candidate.message_id === "string" && typeof candidate.data === "string";
}
function parseJsonRecord(value) {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function isRawCompactionSummaryInfo(info) {
  if (info === null || typeof info !== "object" || Array.isArray(info))
    return false;
  const candidate = info;
  return candidate.summary === true && candidate.finish === "stop";
}
function parseJsonUnknown(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function attachRawPartVersion(value, timeUpdated) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  if (typeof timeUpdated !== "number")
    return value;
  try {
    Object.defineProperty(value, "__magicContextPartUpdatedAt", {
      value: timeUpdated,
      enumerable: false,
      configurable: true
    });
  } catch {}
  return value;
}
function readRawSessionMessagesFromDb(db, sessionId) {
  const messageRows = db.prepare("SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC").all(sessionId).filter(isRawMessageRow);
  const partsByMessageId = new Map;
  const partMessageBatchSize = 128;
  for (let offset = 0;offset < messageRows.length; offset += partMessageBatchSize) {
    const messageIds = messageRows.slice(offset, offset + partMessageBatchSize).map((row) => row.id);
    if (messageIds.length === 0)
      continue;
    const placeholders = messageIds.map(() => "?").join(", ");
    const partRows = db.prepare(`SELECT message_id, data, time_updated
                 FROM part
                 WHERE +session_id = ?
                   AND likelihood(message_id IN (${placeholders}), 0.000001)
                 ORDER BY message_id ASC, time_created ASC, id ASC`).all(sessionId, ...messageIds).filter(isRawPartRow);
    for (const part of partRows) {
      const list = partsByMessageId.get(part.message_id) ?? [];
      list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
      partsByMessageId.set(part.message_id, list);
    }
  }
  const filtered = messageRows.filter((row) => !isRawCompactionSummaryInfo(parseJsonRecord(row.data)));
  return filtered.flatMap((row, index) => {
    const info = parseJsonRecord(row.data);
    if (!info)
      return [];
    const role = typeof info.role === "string" ? info.role : "unknown";
    return {
      ordinal: index + 1,
      id: row.id,
      role,
      parts: partsByMessageId.get(row.id) ?? [],
      createdAt: row.time_created ?? null,
      version: row.time_updated ?? null
    };
  });
}
function readRawSessionMessagePageFromDb(db, sessionId, afterOrdinal, limit, finalWatermark = Number.MAX_SAFE_INTEGER, after) {
  const messageRows = readRawMessagePageRows(db, sessionId, afterOrdinal, limit, finalWatermark, after);
  if (messageRows.length === 0)
    return [];
  const placeholders = messageRows.map(() => "?").join(", ");
  const partRows = db.prepare(`SELECT message_id, data, time_updated
             FROM part
             WHERE +session_id = ?
               AND likelihood(message_id IN (${placeholders}), 0.000001)
             ORDER BY message_id ASC, time_created ASC, id ASC`).all(sessionId, ...messageRows.map((row) => row.id)).filter(isRawPartRow);
  return assembleRawMessagePage(messageRows, partRows);
}
function readRawMessagePageRows(db, sessionId, afterOrdinal, limit, finalWatermark, after) {
  const remaining = Math.max(0, Math.floor(finalWatermark) - Math.floor(afterOrdinal));
  const pageSize = Math.min(Math.max(1, Math.floor(limit)), remaining);
  if (pageSize === 0)
    return [];
  const parameters = [sessionId];
  if (after)
    parameters.push(after.timeCreated, after.timeCreated, after.timeCreated, after.id);
  parameters.push(pageSize);
  if (!after)
    parameters.push(Math.max(0, Math.floor(afterOrdinal)));
  return db.prepare(`SELECT id, data, time_created, time_updated
             FROM message
             WHERE session_id = ?
                ${after ? "AND time_created >= ? AND (time_created > ? OR (time_created = ? AND id > ?))" : ""}
                AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )
             ORDER BY time_created ASC, id ASC
             LIMIT ? ${after ? "" : "OFFSET ?"}`).all(...parameters).filter(isRawMessageRow).map((row, index) => ({
    ...row,
    ordinal: Math.floor(afterOrdinal) + index + 1
  }));
}
function assembleRawMessagePage(messageRows, partRows) {
  const partsByMessageId = new Map;
  for (const part of partRows) {
    const list = partsByMessageId.get(part.message_id) ?? [];
    list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
    partsByMessageId.set(part.message_id, list);
  }
  return messageRows.map((row) => {
    const info = parseJsonRecord(row.data);
    return {
      ordinal: row.ordinal,
      id: row.id,
      role: typeof info?.role === "string" ? info.role : "unknown",
      parts: partsByMessageId.get(row.id) ?? [],
      createdAt: row.time_created ?? null,
      version: row.time_updated ?? null
    };
  });
}
var RAW_SUMMARY_TEXT_MAX_CHARS = 8192;
var RAW_SUMMARY_ARG_MAX_CHARS = 512;
var RAW_SUMMARY_TOOL_INPUT_KEYS = [
  "description",
  "filePath",
  "path",
  "pattern",
  "query",
  "symbol",
  "module",
  "action"
];
function summaryStringField(jsonPath) {
  return `CASE WHEN json_type(data, '${jsonPath}') = 'text' THEN substr(json_extract(data, '${jsonPath}'), 1, ${RAW_SUMMARY_ARG_MAX_CHARS}) END`;
}
var RAW_SUMMARY_PART_DATA_SQL = `CASE
    WHEN json_extract(data, '$.type') = 'text'
        THEN json_set(data, '$.text', substr(json_extract(data, '$.text'), 1, ${RAW_SUMMARY_TEXT_MAX_CHARS}))
    ELSE json_object(
        'type', 'tool',
        'tool', ${summaryStringField("$.tool")},
        'callID', ${summaryStringField("$.callID")},
        'state', json_object(
            'status', ${summaryStringField("$.state.status")},
            'input', json_object(${RAW_SUMMARY_TOOL_INPUT_KEYS.map((key) => `'${key}', ${summaryStringField(`$.state.input.${key}`)}`).join(", ")}),
            'metadata', json_object('description', ${summaryStringField("$.state.metadata.description")})
        )
    )
END`;
function readRawSessionMessageSummaryPageFromDb(db, sessionId, afterOrdinal, limit, finalWatermark = Number.MAX_SAFE_INTEGER, after) {
  const messageRows = readRawMessagePageRows(db, sessionId, afterOrdinal, limit, finalWatermark, after);
  if (messageRows.length === 0)
    return [];
  const placeholders = messageRows.map(() => "?").join(", ");
  const partRows = db.prepare(`SELECT message_id, ${RAW_SUMMARY_PART_DATA_SQL} AS data, time_updated
             FROM part
             WHERE +session_id = ?
               AND likelihood(message_id IN (${placeholders}), 0.000001)
               AND json_valid(data) = 1
               AND json_extract(data, '$.type') IN ('text', 'tool')
             ORDER BY message_id ASC, time_created ASC, id ASC`).all(sessionId, ...messageRows.map((row) => row.id)).filter(isRawPartRow);
  return assembleRawMessagePage(messageRows, partRows);
}
function countRawSessionMessageOrdinalsFromDb(db, sessionId) {
  const row = db.prepare(`SELECT COUNT(*) AS count
             FROM message
             WHERE session_id = ?
               AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`).get(sessionId);
  return typeof row?.count === "number" ? row.count : 0;
}
function readRawSessionMessageIdOrdinalsFromDb(db, sessionId) {
  const messageRows = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC").all(sessionId).filter(isRawMessageRow);
  const ordinalById = new Map;
  let ordinal = 0;
  for (const row of messageRows) {
    const info = parseJsonRecord(row.data);
    if (isRawCompactionSummaryInfo(info))
      continue;
    ordinal += 1;
    if (info)
      ordinalById.set(row.id, ordinal);
  }
  return ordinalById;
}
function readRawSessionMessageOrdinalPageFromDb(db, sessionId, after, limit) {
  const pageSize = Math.max(1, Math.floor(limit));
  const rows = (after ? db.prepare(`SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                         AND (time_created, id) > (?, ?)
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`).all(sessionId, after.timeCreated, after.id, pageSize) : db.prepare(`SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`).all(sessionId, pageSize)).filter(isRawMessageRow);
  return rows.flatMap((row) => {
    if (typeof row.time_created !== "number")
      return [];
    const info = parseJsonRecord(row.data);
    return {
      id: row.id,
      timeCreated: row.time_created,
      contributesOrdinal: !isRawCompactionSummaryInfo(info),
      hasValidInfo: info !== null
    };
  });
}
function countStoredRawSessionMessagesFromDb(db, sessionId) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(sessionId);
  return typeof row?.count === "number" ? row.count : 0;
}
function isAnchorRow(row) {
  return row !== null && typeof row === "object" && typeof row.time_created === "number" && typeof row.id === "string";
}
function readRawSessionTailFromDb(db, sessionId, baseOrdinal, anchorMessageId) {
  const anchorRow = db.prepare("SELECT time_created, id, data FROM message WHERE id = ? AND session_id = ?").get(anchorMessageId, sessionId);
  if (!isAnchorRow(anchorRow))
    return null;
  const anchorInfo = parseJsonRecord(anchorRow.data ?? "");
  if (anchorInfo?.summary === true && anchorInfo?.finish === "stop")
    return null;
  const messageRows = db.prepare(`SELECT id, data, time_created, time_updated FROM message
             WHERE session_id = ?
               AND (time_created > ? OR (time_created = ? AND id >= ?))
             ORDER BY time_created ASC, id ASC`).all(sessionId, anchorRow.time_created, anchorRow.time_created, anchorRow.id).filter(isRawMessageRow);
  const filtered = messageRows.filter((row) => {
    const info = parseJsonRecord(row.data);
    return !(info?.summary === true && info?.finish === "stop");
  });
  const ids = filtered.map((row) => row.id);
  const partsByMessageId = new Map;
  if (ids.length > 0) {
    const CHUNK = 800;
    for (let i = 0;i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const partRows = db.prepare(`SELECT message_id, data, time_updated FROM part WHERE +session_id = ? AND likelihood(message_id IN (${placeholders}), 0.000001) ORDER BY time_created ASC, id ASC`).all(sessionId, ...slice).filter(isRawPartRow);
      for (const part of partRows) {
        const list = partsByMessageId.get(part.message_id) ?? [];
        list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
        partsByMessageId.set(part.message_id, list);
      }
    }
  }
  const messages = [];
  let ord = baseOrdinal;
  for (const row of filtered) {
    const info = parseJsonRecord(row.data);
    if (!info) {
      ord += 1;
      continue;
    }
    messages.push({
      ordinal: ord,
      id: row.id,
      role: typeof info.role === "string" ? info.role : "unknown",
      parts: partsByMessageId.get(row.id) ?? [],
      createdAt: row.time_created ?? null,
      version: row.time_updated ?? null
    });
    ord += 1;
  }
  return { messages, absoluteMessageCount: Math.max(0, ord - 1) };
}
function readRawSessionMessagePartsByIdFromDb(db, sessionId, messageId, onQuery) {
  onQuery?.();
  const row = db.prepare("SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?").get(sessionId, messageId);
  if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number")
    return null;
  const info = parseJsonRecord(row.data);
  if (!info || isRawCompactionSummaryInfo(info))
    return null;
  onQuery?.();
  const partRows = db.prepare(RAW_MESSAGE_PARTS_BY_ID_SQL).all(sessionId, messageId).filter(isRawPartRow);
  return {
    id: row.id,
    role: typeof info.role === "string" ? info.role : "unknown",
    parts: partRows.map((part) => attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated)),
    createdAt: row.time_created,
    version: row.time_updated ?? null
  };
}
function readRawSessionMessageOrdinalByIdFromDb(db, sessionId, messageId) {
  const row = db.prepare(`SELECT COUNT(candidate.id) AS ordinal
             FROM message AS target
             JOIN message AS candidate
               ON candidate.session_id = target.session_id
              AND NOT (
                  CASE WHEN json_valid(candidate.data) = 1
                       THEN COALESCE(json_extract(candidate.data, '$.summary'), 0)
                       ELSE 0 END = 1
                  AND CASE WHEN json_valid(candidate.data) = 1
                           THEN COALESCE(json_extract(candidate.data, '$.finish'), '')
                           ELSE '' END = 'stop'
              )
              AND (candidate.time_created < target.time_created
                   OR (candidate.time_created = target.time_created AND candidate.id <= target.id))
             WHERE target.session_id = ?
               AND target.id = ?
               AND NOT (
                   CASE WHEN json_valid(target.data) = 1
                        THEN COALESCE(json_extract(target.data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(target.data) = 1
                            THEN COALESCE(json_extract(target.data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`).get(sessionId, messageId);
  const ordinal = row?.ordinal;
  return typeof ordinal === "number" && ordinal > 0 ? ordinal : null;
}
function readRawSessionMessageByIdFromDb(db, sessionId, messageId) {
  const row = db.prepare("SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?").get(sessionId, messageId);
  if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") {
    return null;
  }
  const info = parseJsonRecord(row.data);
  if (!info || isRawCompactionSummaryInfo(info)) {
    return null;
  }
  const ordinalRow = db.prepare(`SELECT COUNT(*) AS ordinal FROM message
             WHERE session_id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
               AND (time_created < ? OR (time_created = ? AND id <= ?))`).get(sessionId, row.time_created, row.time_created, messageId);
  const ordinal = typeof ordinalRow?.ordinal === "number" ? ordinalRow.ordinal : 0;
  if (ordinal <= 0) {
    return null;
  }
  const partRows = db.prepare(RAW_MESSAGE_PARTS_BY_ID_SQL).all(sessionId, messageId).filter(isRawPartRow);
  const role = typeof info.role === "string" ? info.role : "unknown";
  return {
    ordinal,
    id: row.id,
    role,
    parts: partRows.map((part) => attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated)),
    createdAt: row.time_created,
    version: row.time_updated ?? null
  };
}
function readRawSeedTailFromDb(db, sessionId, boundaryId) {
  const rows = db.prepare(`
        WITH canonical AS (
            SELECT id, time_created,
                   ROW_NUMBER() OVER (ORDER BY time_created, id) AS ordinal
            FROM message WHERE session_id = ?
              AND NOT (CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.summary'), 0) ELSE 0 END = 1
                AND CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.finish'), '') ELSE '' END = 'stop')
        )
        SELECT c.id, m.data, c.time_created, m.time_updated, c.ordinal,
               p.data AS part_data, p.time_updated AS part_updated
        FROM canonical c JOIN message m ON m.id = c.id
        LEFT JOIN part p ON +p.session_id = ? AND likelihood(p.message_id = c.id, 0.000001)
        WHERE ? IS NULL OR c.ordinal >= (SELECT ordinal FROM canonical WHERE id = ?)
        ORDER BY c.ordinal, p.time_created, p.id
    `).all(sessionId, sessionId, boundaryId, boundaryId);
  const messages = new Map;
  for (const row of rows) {
    if (!messages.has(row.id)) {
      const info = parseJsonRecord(row.data);
      if (!info)
        continue;
      messages.set(row.id, {
        id: row.id,
        ordinal: row.ordinal,
        role: typeof info.role === "string" ? info.role : "unknown",
        createdAt: row.time_created,
        version: row.time_updated,
        parts: []
      });
    }
    if (row.part_data !== null)
      messages.get(row.id)?.parts.push(attachRawPartVersion(parseJsonUnknown(row.part_data), row.part_updated ?? undefined));
  }
  if (boundaryId !== null && !messages.has(boundaryId))
    throw new Error("state_sync materialized boundary is missing from raw storage");
  return messages;
}

// ../plugin/src/hooks/magic-context/read-session-true-raw-tokens.ts
var MAX_MESSAGE_CACHE_KEY_BYTES = 64 * 1024 * 1024;
var messageEstimateCache = new Map;
function firstStringField(record, fields) {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0)
      return value;
  }
  return null;
}
function stringValue(value) {
  if (typeof value === "string")
    return value;
  if (value === undefined || value === null)
    return "";
  return stableStringify(value);
}
function textFromToolResultContent(content) {
  if (typeof content === "string")
    return content;
  if (Array.isArray(content)) {
    const pieces = [];
    for (const entry of content) {
      if (typeof entry === "string") {
        pieces.push(entry);
      } else if (isRecord(entry)) {
        const text = firstStringField(entry, ["text", "content", "value"]);
        pieces.push(text ?? stableStringify(entry));
      } else if (entry !== null && entry !== undefined) {
        pieces.push(String(entry));
      }
    }
    return pieces.join(`
`);
  }
  return stringValue(content);
}
function partType(part) {
  return typeof part.type === "string" ? part.type : "";
}
function hasOwn(record, key) {
  return Object.hasOwn(record, key);
}
function callIdFromPart(part) {
  const direct = firstStringField(part, ["callID", "callId", "toolCallId", "tool_call_id", "id"]);
  if (direct)
    return direct;
  const state = isRecord(part.state) ? part.state : null;
  return state ? firstStringField(state, ["callID", "callId", "toolCallId", "tool_call_id", "id"]) ?? "" : "";
}
function toolSignalFromPart(part) {
  if (!isRecord(part))
    return null;
  const type = partType(part);
  const state = isRecord(part.state) ? part.state : null;
  const callId = callIdFromPart(part);
  if (!callId && type !== "tool")
    return null;
  if (type === "tool") {
    const hasInput = state !== null && hasOwn(state, "input");
    const outputKey = state ? hasOwn(state, "output") ? "output" : hasOwn(state, "error") ? "error" : hasOwn(state, "result") ? "result" : null : null;
    const hasOutput = outputKey !== null;
    const outputValue = outputKey && state ? state[outputKey] : undefined;
    const providerExecuted = part.providerExecuted === true;
    const openInvocation = !providerExecuted && !hasOutput;
    return {
      callId,
      hasInput: hasInput || openInvocation,
      hasOutput,
      inputText: hasInput && state ? stringValue(state.input) : "",
      outputText: hasOutput ? stringValue(outputValue) : ""
    };
  }
  if (type === "tool-invocation") {
    const args = part.args ?? part.input;
    return {
      callId,
      hasInput: args !== undefined,
      hasOutput: false,
      inputText: args !== undefined ? stringValue(args) : "",
      outputText: ""
    };
  }
  if (type === "tool_use") {
    const input = part.input;
    return {
      callId,
      hasInput: input !== undefined,
      hasOutput: false,
      inputText: input !== undefined ? stringValue(input) : "",
      outputText: ""
    };
  }
  if (type === "tool_result") {
    const content = part.content ?? part.output ?? part.result;
    return {
      callId,
      hasInput: false,
      hasOutput: content !== undefined,
      inputText: "",
      outputText: content !== undefined ? textFromToolResultContent(content) : ""
    };
  }
  return null;
}
function buildToolArcs(messages) {
  const openQueues = new Map;
  const arcs = [];
  for (const message of messages) {
    for (const part of message.parts) {
      const signal = toolSignalFromPart(part);
      if (!signal || signal.callId.length === 0)
        continue;
      if (signal.hasInput && signal.hasOutput) {
        arcs.push({
          callId: signal.callId,
          invOrdinal: message.ordinal,
          resOrdinal: message.ordinal
        });
        continue;
      }
      if (signal.hasInput) {
        const queue = openQueues.get(signal.callId) ?? [];
        queue.push(message.ordinal);
        openQueues.set(signal.callId, queue);
        continue;
      }
      if (signal.hasOutput) {
        const queue = openQueues.get(signal.callId) ?? [];
        const invOrdinal = queue.shift();
        if (queue.length === 0)
          openQueues.delete(signal.callId);
        else
          openQueues.set(signal.callId, queue);
        if (invOrdinal !== undefined) {
          arcs.push({ callId: signal.callId, invOrdinal, resOrdinal: message.ordinal });
        }
      }
    }
  }
  for (const [callId, queue] of openQueues) {
    for (const invOrdinal of queue) {
      arcs.push({ callId, invOrdinal, resOrdinal: null });
    }
  }
  return arcs.sort((a, b) => a.invOrdinal - b.invOrdinal || (a.resOrdinal ?? Number.MAX_SAFE_INTEGER) - (b.resOrdinal ?? Number.MAX_SAFE_INTEGER));
}

// ../plugin/src/hooks/magic-context/system-injection-stripper.ts
var STEERING_WRAPPER_REGEX = /<system-reminder>\nThe user sent the following message:\n[\s\S]*?\n\nPlease address this message and continue with your tasks\.\n<\/system-reminder>/g;
function stripOutsideSteeringWrappers(text, strip) {
  STEERING_WRAPPER_REGEX.lastIndex = 0;
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(STEERING_WRAPPER_REGEX)) {
    result += strip(text.slice(cursor, match.index));
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + strip(text.slice(cursor));
}

// ../plugin/src/hooks/magic-context/tag-part-guards.ts
function isTextPart(part) {
  if (part === null || typeof part !== "object")
    return false;
  const p = part;
  return p.type === "text" && typeof p.text === "string";
}
function isFilePart(part) {
  if (part === null || typeof part !== "object")
    return false;
  const p = part;
  return p.type === "file" && typeof p.url === "string";
}

// ../plugin/src/features/magic-context/dreamer/token-budget.ts
var finalizingChildren = new Map;

// ../plugin/src/hooks/magic-context/dropped-input-guard.ts
var recordedToolParameters = new Map;

// ../plugin/src/hooks/magic-context/edit-marker.ts
var PATH_KEYS = new Set(["filePath", "file_path", "path"]);
var DIFF_KEYS = new Set(["oldString", "newString", "content", "old_string", "new_string"]);

// ../plugin/src/hooks/magic-context/tokenizer-calibration-seeds.json
var tokenizer_calibration_seeds_default = [
  {
    prefix: "google/gemini-3.8-flash",
    systemRatio: 0.961167,
    toolsRatio: 0.967504,
    proseRatio: 1.006909
  },
  {
    prefix: "google/gemini-3.7-flash",
    systemRatio: 0.961167,
    toolsRatio: 0.967504,
    proseRatio: 1.006909
  },
  {
    prefix: "google/gemini-3.1-pro-preview",
    systemRatio: 0.961167,
    toolsRatio: 0.967504,
    proseRatio: 1.006909
  },
  {
    prefix: "anthropic/claude-fable-5-1",
    systemRatio: 1.511497,
    toolsRatio: 1.551639,
    proseRatio: 1.571778
  },
  {
    prefix: "anthropic/claude-opus-5",
    systemRatio: 1.511497,
    toolsRatio: 1.551639,
    proseRatio: 1.571778
  },
  {
    prefix: "anthropic/claude-sonnet-5",
    systemRatio: 1.511497,
    toolsRatio: 1.554814,
    proseRatio: 1.571815
  },
  {
    prefix: "openrouter/anthropic/claude-fable-5-1",
    systemRatio: 1.511497,
    toolsRatio: 1.551639,
    proseRatio: 1.571778
  },
  {
    prefix: "openrouter/anthropic/claude-opus-5",
    systemRatio: 1.511497,
    toolsRatio: 1.551639,
    proseRatio: 1.571778
  },
  {
    prefix: "openrouter/anthropic/claude-sonnet-5",
    systemRatio: 1.511497,
    toolsRatio: 1.554814,
    proseRatio: 1.571815
  },
  {
    prefix: "github-copilot/claude-fable-5-1",
    systemRatio: 1.511497,
    toolsRatio: 1.551639,
    proseRatio: 1.571778
  },
  {
    prefix: "github-copilot/claude-opus-5",
    systemRatio: 1.511497,
    toolsRatio: 1.551639,
    proseRatio: 1.571778
  },
  {
    prefix: "github-copilot/claude-sonnet-5",
    systemRatio: 1.511497,
    toolsRatio: 1.554814,
    proseRatio: 1.571815
  },
  {
    prefix: "anthropic/claude-opus-4-8",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "anthropic/claude-opus-4.8",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "anthropic/claude-opus-4-7",
    systemRatio: 1.51,
    toolsRatio: 1.57,
    proseRatio: 1.571778
  },
  {
    prefix: "anthropic/claude-opus-4.7",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "anthropic/claude-opus-4-5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "anthropic/claude-opus-4.5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "anthropic/claude-opus-4-6",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "anthropic/claude-opus-4.6",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "anthropic/claude-sonnet-4-5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "anthropic/claude-sonnet-4.5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "anthropic/claude-sonnet-4-6",
    systemRatio: 1.02,
    toolsRatio: 1.14,
    proseRatio: 1.057976
  },
  {
    prefix: "anthropic/claude-sonnet-4.6",
    systemRatio: 1.02,
    toolsRatio: 1.14
  },
  {
    prefix: "anthropic/claude-haiku-4-5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "anthropic/claude-haiku-4.5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "openrouter/anthropic/claude-opus-4-8",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "openrouter/anthropic/claude-opus-4.8",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "github-copilot/claude-opus-4-8",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "github-copilot/claude-opus-4.8",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "openrouter/anthropic/claude-opus-4-7",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "openrouter/anthropic/claude-opus-4.7",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "github-copilot/claude-opus-4-7",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "github-copilot/claude-opus-4.7",
    systemRatio: 1.51,
    toolsRatio: 1.57
  },
  {
    prefix: "openrouter/anthropic/claude-sonnet-4.6",
    systemRatio: 1.02,
    toolsRatio: 1.14
  },
  {
    prefix: "github-copilot/claude-sonnet-4.6",
    systemRatio: 1.02,
    toolsRatio: 1.14
  },
  {
    prefix: "github-copilot/claude-sonnet-4.5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "github-copilot/claude-opus-4.5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "github-copilot/claude-haiku-4.5",
    systemRatio: 1.02,
    toolsRatio: 1.16
  },
  {
    prefix: "openai/gpt-5.5",
    systemRatio: 1.000278,
    toolsRatio: 0.850953,
    proseRatio: 1.000017
  },
  {
    prefix: "openai/gpt-6-astra",
    systemRatio: 1.000278,
    toolsRatio: 0.850953,
    proseRatio: 1.000017
  },
  {
    prefix: "openai/gpt-6-sol",
    systemRatio: 1.000278,
    toolsRatio: 0.850953,
    proseRatio: 1.000017,
    provenance: "Mirrored from openai/gpt-6-astra; prose inherited-unmeasured. Reported OAuth system/tools counts match GPT-5.5; no independent API-key measurement."
  },
  {
    prefix: "openai/gpt-6.1-sol",
    systemRatio: 1.000278,
    toolsRatio: 0.850953,
    proseRatio: 1.000017,
    provenance: "Mirrored from openai/gpt-6-astra; prose inherited-unmeasured. Reported OAuth system/tools counts match GPT-5.5; no independent API-key measurement."
  },
  {
    prefix: "openai/gpt-5",
    systemRatio: 1,
    toolsRatio: 0.84
  },
  {
    prefix: "xai/grok-4-latest",
    systemRatio: 0.817751,
    toolsRatio: 0.880494,
    proseRatio: 0.880137
  },
  {
    prefix: "xai/grok-code-fast-1",
    systemRatio: 0.817751,
    toolsRatio: 0.880494,
    proseRatio: 0.880137
  },
  {
    prefix: "xai/grok-4",
    systemRatio: 0.82,
    toolsRatio: 0.88
  },
  {
    prefix: "xai/grok-code-fast",
    systemRatio: 0.82,
    toolsRatio: 0.89
  },
  {
    prefix: "cerebras/qwen-3-235b",
    systemRatio: 1,
    toolsRatio: 1.1
  },
  {
    prefix: "cerebras/zai-glm-4.7",
    systemRatio: 1,
    toolsRatio: 1.09
  },
  {
    prefix: "cerebras/gpt-oss-120b",
    systemRatio: 0.84,
    toolsRatio: 0.79
  },
  {
    prefix: "fireworks-ai/accounts/fireworks/models/glm-5p1",
    systemRatio: 1,
    toolsRatio: 1.06
  },
  {
    prefix: "fireworks-ai/accounts/fireworks/models/deepseek-v3p2",
    systemRatio: 1.05,
    toolsRatio: 1.09
  },
  {
    prefix: "opencode-go/glm-5.1",
    systemRatio: 1,
    toolsRatio: 1.06
  },
  {
    prefix: "opencode-go/glm-5",
    systemRatio: 1,
    toolsRatio: 1.06
  },
  {
    prefix: "opencode-go/kimi-k2.6",
    systemRatio: 0.87,
    toolsRatio: 0.86,
    proseRatio: 0.925501
  },
  {
    prefix: "moonshot/kimi-k2.6",
    systemRatio: 0.872126,
    toolsRatio: 0.863853,
    proseRatio: 0.925501
  },
  {
    prefix: "moonshot/kimi-for-coding",
    systemRatio: 0.872126,
    toolsRatio: 0.863853,
    proseRatio: 0.925501
  },
  {
    prefix: "zai/glm-4.7",
    systemRatio: 0.999721,
    toolsRatio: 1.056823,
    proseRatio: 1.000875
  },
  {
    prefix: "meta/muse-spark",
    systemRatio: 0.865949,
    toolsRatio: 1.024605,
    proseRatio: 0.923366
  },
  {
    prefix: "opencode/muse-spark",
    systemRatio: 0.865949,
    toolsRatio: 1.024605,
    proseRatio: 0.923366
  }
];

// ../plugin/src/hooks/magic-context/tokenizer-calibration.ts
var CALIBRATION_TABLE = tokenizer_calibration_seeds_default;
var UNKNOWN_FIT_RATIO = Math.max(2, ...CALIBRATION_TABLE.flatMap((entry) => [
  entry.systemRatio,
  entry.toolsRatio,
  entry.proseRatio ?? 1
]));

// ../plugin/src/features/magic-context/overflow-detection.ts
var PREFIX_BOUND_THINKING_MODELS = [
  ["fable", 5, 1],
  ["opus", 5, 5],
  ["sonnet", 5, 5]
];
var PREFIX_BOUND_THINKING_PATTERN = new RegExp(`(?:^|[-_.:/])(?:${PREFIX_BOUND_THINKING_MODELS.map(([family, major, minor]) => `${family}[-_.]?${major}[-_.]${minor}`).join("|")})(?:$|[-_.:/@])`, "i");

// ../plugin/src/hooks/magic-context/sentinel.ts
var REMOVED_REASONING_MARK = Symbol.for("magic-context.removed-reasoning");
var NEUTRALIZED_ORIGINALS = new WeakMap;

// ../plugin/src/hooks/magic-context/tool-input-size.ts
var encoder2 = new TextEncoder;

// ../plugin/src/hooks/magic-context/tool-drop-target.ts
var IGNORE_PART_TYPES = new Set([
  "thinking",
  "reasoning",
  "redacted_thinking",
  "meta",
  "step-start",
  "step-finish"
]);
function isToolCallId(value) {
  return typeof value === "string" && value.length > 0;
}
function extractToolCallObservation(part) {
  if (!isRecord(part))
    return null;
  if (part.type === "tool" && isToolCallId(part.callID)) {
    return { callId: part.callID, kind: "result" };
  }
  if (part.type === "tool-invocation" && isToolCallId(part.callID)) {
    return { callId: part.callID, kind: "invocation" };
  }
  if (part.type === "tool_use" && isToolCallId(part.id)) {
    return { callId: part.id, kind: "invocation" };
  }
  if (part.type === "tool_result" && isToolCallId(part.tool_use_id)) {
    return { callId: part.tool_use_id, kind: "result" };
  }
  return null;
}

// ../plugin/src/hooks/magic-context/read-session-chunk.ts
var BLOCK_TOKEN_MEMO_MAX = 2048;
var blockTokenMemo = new Map;
function estimateBlockTokens(blockText) {
  const cached = blockTokenMemo.get(blockText);
  if (cached !== undefined) {
    blockTokenMemo.delete(blockText);
    blockTokenMemo.set(blockText, cached);
    return cached;
  }
  const count = estimateTokens(blockText);
  if (blockTokenMemo.size >= BLOCK_TOKEN_MEMO_MAX) {
    const oldest = blockTokenMemo.keys().next().value;
    if (oldest !== undefined)
      blockTokenMemo.delete(oldest);
  }
  blockTokenMemo.set(blockText, count);
  return count;
}
var activeRawMessageCache = null;
var activeAbsoluteCountCache = null;
var sessionProviders = new Map;
function resolveHostServedBoundaryId2(sessionId, messageId) {
  if (messageId.length === 0)
    return messageId;
  return sessionProviders.get(sessionId)?.provider.readServedBoundaryId?.(messageId) ?? messageId;
}
function hasRawMessageProvider2(sessionId) {
  return sessionProviders.has(sessionId);
}
function setRawMessageProvider2(sessionId, provider) {
  const current = sessionProviders.get(sessionId);
  const registration = current?.provider === provider ? current : { provider, scopes: 0 };
  registration.scopes += 1;
  sessionProviders.set(sessionId, registration);
  let active = true;
  return () => {
    if (!active)
      return;
    active = false;
    registration.scopes -= 1;
    if (registration.scopes === 0 && sessionProviders.get(sessionId) === registration) {
      sessionProviders.delete(sessionId);
    }
  };
}
var boundedProviderWrappers = new WeakMap;
function setBoundedRawMessageProvider2(sessionId, provider) {
  let wrapper = boundedProviderWrappers.get(provider);
  if (!wrapper) {
    wrapper = {
      ...provider,
      readMessages: () => {
        throw new Error("Bounded raw-message providers cannot read complete history; full reads are reserved for store-generation conversion");
      }
    };
    boundedProviderWrappers.set(provider, wrapper);
  }
  return setRawMessageProvider2(sessionId, wrapper);
}
function withRawMessageProvider2(sessionId, provider, fn) {
  const cleanup = setRawMessageProvider2(sessionId, provider);
  let result;
  try {
    result = fn();
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result !== null && typeof result === "object" && typeof result.then === "function") {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}
var SYSTEM_REMINDER_BLOCK_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
function cleanUserText2(text) {
  return stripOutsideSteeringWrappers(text, (segment) => segment.replace(SYSTEM_REMINDER_BLOCK_REGEX, "").replace(OMO_INTERNAL_INITIATOR_MARKER, "")).trim();
}
function hasMeaningfulChunkUserText(parts) {
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const candidate = part;
    if (candidate.type !== "text" || typeof candidate.text !== "string")
      continue;
    if (candidate.ignored === true)
      continue;
    const cleaned = cleanUserText2(candidate.text);
    if (!cleaned)
      continue;
    if (isSystemDirective(cleaned))
      continue;
    return true;
  }
  return false;
}
function withRawSessionMessageCache2(fn) {
  const outerCache = activeRawMessageCache;
  if (!outerCache) {
    activeRawMessageCache = new Map;
    activeAbsoluteCountCache = new Map;
  }
  try {
    return fn();
  } finally {
    if (!outerCache) {
      activeRawMessageCache = null;
      activeAbsoluteCountCache = null;
    }
  }
}
function readRawSessionMessages2(sessionId) {
  if (activeRawMessageCache) {
    const cached = activeRawMessageCache.get(sessionId);
    if (cached?.coveredFromOrdinal === 1 && cached.coveredToOrdinal === null) {
      return cached.messages;
    }
    const messages = readRawSessionMessagesFromSource(sessionId);
    if (!cached) {
      activeRawMessageCache.set(sessionId, {
        messages,
        coveredFromOrdinal: 1,
        coveredToOrdinal: null
      });
    }
    return messages;
  }
  return readRawSessionMessagesFromSource(sessionId);
}
function readRawSessionMessagePage2(sessionId, afterOrdinal, limit, finalWatermark) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.readMessagePage) {
    return provider.readMessagePage(afterOrdinal, limit, finalWatermark);
  }
  if (provider) {
    return provider.readMessages().filter((message) => message.ordinal > afterOrdinal && message.ordinal <= finalWatermark).slice(0, limit);
  }
  if (!openCodeDbExists())
    return [];
  return withReadOnlySessionDb((db) => readRawSessionMessagePageFromDb(db, sessionId, afterOrdinal, limit, finalWatermark));
}
function getRawSessionMessageOrdinalCount2(sessionId) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider) {
    if (provider.getMessageCount)
      return provider.getMessageCount();
    const messages = provider.readMessages();
    return messages.reduce((maximum, message) => Math.max(maximum, message.ordinal), messages.length);
  }
  if (!openCodeDbExists())
    return 0;
  return withReadOnlySessionDb((db) => countRawSessionMessageOrdinalsFromDb(db, sessionId));
}
var RAW_MESSAGE_RANGE_PAGE_SIZE = 100;
function readRawSessionMessageRangeFromSource(sessionId, fromOrdinal, toOrdinal) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.iterateMessageRange)
    return [...provider.iterateMessageRange(fromOrdinal, toOrdinal)];
  if (provider && !provider.readMessagePage) {
    return provider.readMessages().filter((message) => message.ordinal >= fromOrdinal && message.ordinal <= toOrdinal);
  }
  if (!provider && !openCodeDbExists())
    return [];
  const messages = [];
  let afterOrdinal = fromOrdinal - 1;
  let after;
  while (afterOrdinal < toOrdinal) {
    const limit = Math.min(RAW_MESSAGE_RANGE_PAGE_SIZE, toOrdinal - afterOrdinal);
    const page = provider?.readMessagePage ? provider.readMessagePage(afterOrdinal, limit, toOrdinal, after) : withReadOnlySessionDb((db) => readRawSessionMessagePageFromDb(db, sessionId, afterOrdinal, limit, toOrdinal, after));
    if (page.length === 0)
      break;
    let nextOrdinal = afterOrdinal;
    for (const message of page) {
      if (message.ordinal < fromOrdinal || message.ordinal > toOrdinal)
        continue;
      messages.push(message);
      nextOrdinal = Math.max(nextOrdinal, message.ordinal);
    }
    if (nextOrdinal <= afterOrdinal)
      break;
    afterOrdinal = nextOrdinal;
    const last = page.at(-1);
    after = last ? { timeCreated: last.createdAt ?? 0, id: last.id } : undefined;
  }
  return messages;
}
var RAW_MESSAGE_VISIT_PAGE_SIZE2 = 50;
function visitRawSessionMessages2(sessionId, fromOrdinal, toOrdinal, visit, options = {}) {
  const from = Math.max(1, Math.floor(fromOrdinal));
  const to = Math.floor(toOrdinal);
  if (to < from)
    return;
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.iterateMessageRange) {
    for (const message of provider.iterateMessageRange(from, to)) {
      if (!visit(message))
        return;
    }
    return;
  }
  if (provider && !provider.readMessagePage) {
    for (const message of provider.readMessages()) {
      if (message.ordinal < from || message.ordinal > to)
        continue;
      if (!visit(message))
        return;
    }
    return;
  }
  if (!provider && !openCodeDbExists())
    return;
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? RAW_MESSAGE_VISIT_PAGE_SIZE2));
  let afterOrdinal = from - 1;
  let after;
  while (afterOrdinal < to) {
    const limit = Math.min(pageSize, to - afterOrdinal);
    const cursor = afterOrdinal;
    const page = provider?.readMessagePage ? provider.readMessagePage(cursor, limit, to, after) : withReadOnlySessionDb((db) => options.summary ? readRawSessionMessageSummaryPageFromDb(db, sessionId, cursor, limit, to, after) : readRawSessionMessagePageFromDb(db, sessionId, cursor, limit, to, after));
    if (page.length === 0)
      return;
    let nextOrdinal = afterOrdinal;
    for (const message of page) {
      if (message.ordinal < from || message.ordinal > to)
        continue;
      if (!visit(message))
        return;
      nextOrdinal = Math.max(nextOrdinal, message.ordinal);
    }
    if (nextOrdinal <= afterOrdinal)
      return;
    afterOrdinal = nextOrdinal;
    const last = page.at(-1);
    after = last ? { timeCreated: last.createdAt ?? 0, id: last.id } : undefined;
  }
}
function readRawSessionMessageRange2(sessionId, fromOrdinal, toOrdinal) {
  const from = Math.max(1, Math.floor(fromOrdinal));
  const to = Math.floor(toOrdinal);
  if (to < from)
    return [];
  const cached = activeRawMessageCache?.get(sessionId);
  if (!cached)
    return readRawSessionMessageRangeFromSource(sessionId, from, to);
  const coveredTo = cached.coveredToOrdinal ?? Number.POSITIVE_INFINITY;
  const overlapFrom = Math.max(from, cached.coveredFromOrdinal);
  const overlapTo = Math.min(to, coveredTo);
  if (overlapTo < overlapFrom) {
    return readRawSessionMessageRangeFromSource(sessionId, from, to);
  }
  const messages = [];
  if (from < overlapFrom) {
    messages.push(...readRawSessionMessageRangeFromSource(sessionId, from, overlapFrom - 1));
  }
  messages.push(...cached.messages.filter((message) => message.ordinal >= overlapFrom && message.ordinal <= overlapTo));
  if (overlapTo < to) {
    messages.push(...readRawSessionMessageRangeFromSource(sessionId, overlapTo + 1, to));
  }
  return messages;
}
readRawSessionMessages2.readPage = readRawSessionMessagePage2;
readRawSessionMessages2.getCount = getRawSessionMessageOrdinalCount2;
function primeTailRawMessageCache2(args) {
  const { sessionId, lastCompartmentEnd, anchorMessageId } = args;
  if (!activeRawMessageCache)
    return false;
  if (activeRawMessageCache.has(sessionId))
    return false;
  if (lastCompartmentEnd < 1 || !anchorMessageId)
    return false;
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider) {
    if (!provider.readMessagePage || !provider.getMessageCount)
      return false;
    const absoluteMessageCount = provider.getMessageCount();
    const messages = readRawSessionMessageRange2(sessionId, lastCompartmentEnd, absoluteMessageCount);
    if (messages.find((message) => message.ordinal === lastCompartmentEnd)?.id !== anchorMessageId)
      return false;
    activeRawMessageCache.set(sessionId, {
      messages,
      coveredFromOrdinal: lastCompartmentEnd,
      coveredToOrdinal: lastCompartmentEnd === 1 ? null : absoluteMessageCount
    });
    activeAbsoluteCountCache?.set(sessionId, absoluteMessageCount);
    return true;
  }
  if (!openCodeDbExists())
    return false;
  const result = withReadOnlySessionDb((db) => readRawSessionTailFromDb(db, sessionId, lastCompartmentEnd, anchorMessageId));
  if (!result)
    return false;
  activeRawMessageCache.set(sessionId, {
    messages: result.messages,
    coveredFromOrdinal: lastCompartmentEnd,
    coveredToOrdinal: lastCompartmentEnd === 1 ? null : result.absoluteMessageCount
  });
  activeAbsoluteCountCache?.set(sessionId, result.absoluteMessageCount);
  return true;
}
function getCachedAbsoluteMessageCount2(sessionId) {
  return activeAbsoluteCountCache?.get(sessionId) ?? null;
}
function primeInMemoryTailRawMessageCache2(args) {
  const { sessionId, messages, absoluteMessageCount } = args;
  if (!activeRawMessageCache)
    return false;
  if (activeRawMessageCache.has(sessionId))
    return false;
  const coveredFromOrdinal = messages[0]?.ordinal ?? absoluteMessageCount + 1;
  activeRawMessageCache.set(sessionId, {
    messages,
    coveredFromOrdinal,
    coveredToOrdinal: coveredFromOrdinal === 1 ? null : absoluteMessageCount
  });
  activeAbsoluteCountCache?.set(sessionId, absoluteMessageCount);
  return true;
}
function readRawSessionMessageOrdinalPage2(sessionId, after, limit) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.readMessageOrdinalPage)
    return provider.readMessageOrdinalPage(after, limit);
  if (provider) {
    const rows = provider.readMessages().map((message) => ({
      id: message.id,
      timeCreated: message.createdAt ?? message.ordinal,
      contributesOrdinal: true,
      hasValidInfo: true
    })).filter((row) => !after || row.timeCreated > after.timeCreated || row.timeCreated === after.timeCreated && row.id > after.id).sort((left, right) => left.timeCreated - right.timeCreated || left.id.localeCompare(right.id));
    return rows.slice(0, Math.max(1, Math.floor(limit)));
  }
  if (!openCodeDbExists())
    return [];
  return withReadOnlySessionDb((db) => readRawSessionMessageOrdinalPageFromDb(db, sessionId, after, limit));
}
function getRawSessionStoredMessageCount2(sessionId) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.getStoredMessageCount)
    return provider.getStoredMessageCount();
  if (provider)
    return provider.readMessages().length;
  if (!openCodeDbExists())
    return 0;
  return withReadOnlySessionDb((db) => countStoredRawSessionMessagesFromDb(db, sessionId));
}
function readRawSessionMessageIdOrdinalsForRange2(sessionId, fromOrdinal, toOrdinal) {
  const from = Math.max(1, Math.floor(fromOrdinal));
  const to = Math.floor(toOrdinal);
  if (to < from)
    return new Map;
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.readMessageIdOrdinalsForRange) {
    return provider.readMessageIdOrdinalsForRange(from, to);
  }
  const all = provider?.readMessageIdOrdinals ? provider.readMessageIdOrdinals() : provider ? new Map(provider.readMessages().map((message) => [message.id, message.ordinal])) : !openCodeDbExists() ? new Map : withReadOnlySessionDb((db) => readRawSessionMessageIdOrdinalsFromDb(db, sessionId));
  return new Map([...all].filter(([, ordinal]) => ordinal >= from && ordinal <= to));
}
function readRawSessionMessageIdOrdinals2(sessionId) {
  const count = getRawSessionMessageOrdinalCount2(sessionId);
  return readRawSessionMessageIdOrdinalsForRange2(sessionId, 1, count);
}
function readRawSessionMessagePartsById2(sessionId, messageId, onQuery) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.readMessagePartsById)
    return provider.readMessagePartsById(messageId);
  if (provider?.readMessageById)
    return provider.readMessageById(messageId);
  if (provider) {
    return provider.readMessages().find((message) => message.id === messageId) ?? null;
  }
  if (!openCodeDbExists())
    return null;
  return withReadOnlySessionDb((db) => readRawSessionMessagePartsByIdFromDb(db, sessionId, messageId, onQuery));
}
function hasRawSessionMessageById2(sessionId, messageId) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.hasMessageById)
    return provider.hasMessageById(messageId);
  return readRawSessionMessageById2(sessionId, messageId) !== null;
}
function readRawSessionMessageOrdinalById2(sessionId, messageId) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.readMessageOrdinalById) {
    return provider.readMessageOrdinalById(messageId);
  }
  if (provider?.readMessageIdOrdinals) {
    return provider.readMessageIdOrdinals().get(messageId) ?? null;
  }
  if (provider?.readMessageOrdinalPage) {
    let after = null;
    let ordinal = 0;
    while (true) {
      const page = provider.readMessageOrdinalPage(after, 500);
      if (page.length === 0)
        return null;
      for (const entry of page) {
        if (entry.contributesOrdinal)
          ordinal += 1;
        if (entry.id === messageId)
          return entry.contributesOrdinal ? ordinal : null;
      }
      const last = page.at(-1);
      if (!last || page.length < 500)
        return null;
      after = { timeCreated: last.timeCreated, id: last.id };
    }
  }
  if (provider?.readMessageById) {
    return provider.readMessageById(messageId)?.ordinal ?? null;
  }
  if (provider) {
    return provider.readMessages().find((message) => message.id === messageId)?.ordinal ?? null;
  }
  if (!openCodeDbExists())
    return null;
  return withReadOnlySessionDb((db) => readRawSessionMessageOrdinalByIdFromDb(db, sessionId, messageId));
}
function compareRawSessionMessageOrder2(sessionId, leftId, rightId) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider) {
    if (!provider.readMessageOrdinalById)
      return null;
    const left = provider.readMessageOrdinalById(leftId);
    const right = provider.readMessageOrdinalById(rightId);
    return left === null || right === null ? null : left - right;
  }
  if (!openCodeDbExists())
    return null;
  return withReadOnlySessionDb((db) => {
    const lookup = db.prepare("SELECT time_created, id FROM message WHERE session_id = ? AND id = ? LIMIT 1");
    const left = lookup.get(sessionId, leftId);
    const right = lookup.get(sessionId, rightId);
    if (typeof left?.time_created !== "number" || typeof right?.time_created !== "number" || typeof left.id !== "string" || typeof right.id !== "string") {
      return null;
    }
    if (left.time_created !== right.time_created) {
      return left.time_created - right.time_created;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}
function readRawSessionMessageById2(sessionId, messageId) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider?.readMessageById) {
    return provider.readMessageById(messageId);
  }
  if (provider) {
    return provider.readMessages().find((message) => message.id === messageId) ?? null;
  }
  if (!openCodeDbExists())
    return null;
  return withReadOnlySessionDb((db) => readRawSessionMessageByIdFromDb(db, sessionId, messageId));
}
function readRawSessionMessagesFromSource(sessionId) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider)
    return provider.readMessages();
  if (!openCodeDbExists())
    return [];
  return withReadOnlySessionDb((db) => readRawSessionMessagesFromDb(db, sessionId));
}
function getRawSessionMessageCount2(sessionId) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider) {
    if (provider.getMessageCount)
      return provider.getMessageCount();
    const messages = provider.readMessages();
    return messages.reduce((maximum, message) => Math.max(maximum, message.ordinal), messages.length);
  }
  if (!openCodeDbExists())
    return 0;
  return withReadOnlySessionDb((db) => getRawSessionMessageCountFromDb(db, sessionId));
}
var RAW_SESSION_TAG_KEY_PAGE_SIZE2 = 32;
function yieldRawSessionTagKeyPage() {
  return new Promise((resolve) => {
    const immediate = globalThis.setImmediate;
    if (typeof immediate === "function") {
      immediate(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}
async function getRawSessionTagKeysThrough2(sessionId, upToMessageIndex, options = {}) {
  const messageFileKeys = new Set;
  const toolObservations = new Map;
  const unpairedInvocations = new Map;
  const candidateOwnersByCallId = new Map;
  const messageTimesById = new Map;
  const finalWatermark = Number.isFinite(upToMessageIndex) ? Math.max(0, Math.floor(upToMessageIndex)) : getRawSessionMessageOrdinalCount2(sessionId);
  const pageSize = Number.isFinite(options.pageSize) ? Math.max(1, Math.floor(options.pageSize ?? RAW_SESSION_TAG_KEY_PAGE_SIZE2)) : RAW_SESSION_TAG_KEY_PAGE_SIZE2;
  const yieldToEventLoop = options.yieldToEventLoop ?? yieldRawSessionTagKeyPage;
  const nearestPersistedOwner = (callId, currentMessageId) => {
    if (!options.db)
      return null;
    let candidates = candidateOwnersByCallId.get(callId);
    if (!candidates) {
      candidates = getCandidateToolOwners(options.db, sessionId, callId);
      candidateOwnersByCallId.set(callId, candidates);
    }
    if (candidates.length === 0)
      return null;
    const ids = [...candidates, currentMessageId];
    const unresolved = ids.filter((id) => !messageTimesById.has(id));
    if (unresolved.length > 0) {
      const resolved = getMessageTimesFromOpenCodeDb(sessionId, unresolved);
      for (const id of unresolved) {
        messageTimesById.set(id, resolved.get(id) ?? null);
      }
    }
    const times = new Map;
    for (const id of ids) {
      const time = messageTimesById.get(id);
      if (typeof time === "number")
        times.set(id, time);
    }
    return pickNearestPriorOwner(candidates, currentMessageId, times);
  };
  const firstOrdinal = Number.isFinite(options.fromMessageIndex) ? Math.max(1, Math.floor(options.fromMessageIndex ?? 1)) : 1;
  let afterOrdinal = firstOrdinal - 1;
  while (afterOrdinal < finalWatermark) {
    const messages = readRawSessionMessages2.readPage(sessionId, afterOrdinal, pageSize, finalWatermark);
    if (messages.length === 0)
      break;
    let nextOrdinal = afterOrdinal;
    for (const message of messages) {
      if (message.ordinal <= afterOrdinal || message.ordinal > finalWatermark)
        continue;
      nextOrdinal = Math.max(nextOrdinal, message.ordinal);
      messageTimesById.set(message.id, typeof message.createdAt === "number" ? message.createdAt : null);
      for (const [partIndex, part] of message.parts.entries()) {
        if (isTextPart(part)) {
          messageFileKeys.add(`${message.id}:p${partIndex}`);
          continue;
        }
        if (isFilePart(part)) {
          messageFileKeys.add(`${message.id}:file${partIndex}`);
          continue;
        }
        const observation = extractToolCallObservation(part);
        if (!observation)
          continue;
        let ownerMessageId;
        if (observation.kind === "invocation") {
          ownerMessageId = message.id;
          const queue = unpairedInvocations.get(observation.callId) ?? [];
          queue.push(message.id);
          unpairedInvocations.set(observation.callId, queue);
        } else {
          const queue = unpairedInvocations.get(observation.callId);
          const pairedOwner = queue?.shift();
          if (queue?.length === 0)
            unpairedInvocations.delete(observation.callId);
          ownerMessageId = pairedOwner ?? nearestPersistedOwner(observation.callId, message.id) ?? message.id;
        }
        const owners = toolObservations.get(observation.callId) ?? new Set;
        owners.add(ownerMessageId);
        toolObservations.set(observation.callId, owners);
      }
    }
    if (nextOrdinal <= afterOrdinal)
      break;
    afterOrdinal = nextOrdinal;
    if (afterOrdinal < finalWatermark)
      await yieldToEventLoop();
  }
  return { messageFileKeys, toolObservations };
}
var PROTECTED_TAIL_USER_TURNS = 5;
function getLegacyProtectedTailStartOrdinal2(sessionId) {
  const count = getRawSessionMessageOrdinalCount2(sessionId);
  const userOrdinals = [];
  let toOrdinal = count;
  while (toOrdinal >= 1 && userOrdinals.length < PROTECTED_TAIL_USER_TURNS) {
    const fromOrdinal = Math.max(1, toOrdinal - RAW_MESSAGE_RANGE_PAGE_SIZE + 1);
    const messages = readRawSessionMessageRange2(sessionId, fromOrdinal, toOrdinal);
    for (let index = messages.length - 1;index >= 0; index--) {
      const message = messages[index];
      if (message?.role === "user" && hasMeaningfulUserText2(message.parts)) {
        userOrdinals.push(message.ordinal);
        if (userOrdinals.length === PROTECTED_TAIL_USER_TURNS)
          break;
      }
    }
    toOrdinal = fromOrdinal - 1;
  }
  return userOrdinals.length < PROTECTED_TAIL_USER_TURNS ? 1 : userOrdinals[PROTECTED_TAIL_USER_TURNS - 1] ?? 1;
}
function getProtectedTailStartOrdinal2(sessionId) {
  return getLegacyProtectedTailStartOrdinal2(sessionId);
}
function readSessionChunk2(sessionId, tokenBudget, offset = 1, eligibleEndOrdinal, options = {}) {
  const totalMessageCount = getCachedAbsoluteMessageCount2(sessionId) ?? getRawSessionMessageOrdinalCount2(sessionId);
  const startOrdinal = Math.max(1, offset);
  const finalOrdinal = eligibleEndOrdinal === undefined ? totalMessageCount : Math.min(totalMessageCount, eligibleEndOrdinal - 1);
  const messages = readRawSessionMessageRange2(sessionId, Math.max(1, startOrdinal - 1), finalOrdinal);
  const expandedParts = new Map;
  const expandedResults = new Set;
  if (options.expand !== false) {
    const calls = new Map;
    for (const message of messages)
      for (const part of message.parts) {
        if (!part || typeof part !== "object")
          continue;
        const p = part;
        if (p.type !== "tool")
          continue;
        const state = p.state;
        if (state?.input !== undefined && typeof p.callID === "string")
          calls.set(p.callID, p);
        expandedParts.set(part, expandToolPart(part, options.expandTools));
        if (state?.input === undefined && state?.output !== undefined && typeof p.callID === "string") {
          const call = calls.get(p.callID);
          if (call) {
            const expansion = expandToolPart({ ...call, state: { ...call.state, output: state.output } }, options.expandTools);
            if (expansion !== null) {
              expandedParts.set(call, expansion);
              expandedResults.add(part);
            }
            calls.delete(p.callID);
          }
        }
      }
  }
  const completedToolArcs = buildToolArcs(messages).flatMap((arc) => arc.resOrdinal === null ? [] : [{ start: arc.invOrdinal, end: arc.resOrdinal }]);
  const completedToolComponents = [];
  for (const arc of completedToolArcs) {
    const component = completedToolComponents[completedToolComponents.length - 1];
    if (component && arc.start <= component.end)
      component.end = Math.max(component.end, arc.end);
    else
      completedToolComponents.push({ ...arc });
  }
  const lines = [];
  const lineMeta = [];
  const flushedToolOnlyBlocks = [];
  let totalTokens = 0;
  let messagesProcessed = 0;
  let lastOrdinal = startOrdinal - 1;
  let highestScannedOrdinal = startOrdinal - 1;
  let lastMessageId = "";
  let firstMessageId = "";
  let currentBlock = null;
  let pendingNoiseMeta = [];
  let commitClusters = 0;
  let lastFlushedRole = "";
  let admittedOversizeComponentEnd = null;
  let currentBlockApproxTokens = 0;
  let formattedBudgetCrossed = false;
  let sourceCharacters = 0;
  const toolResultBoundaries = [];
  function pinComponentWhenFormattedBudgetCrosses(ordinal, appendedText) {
    if (admittedOversizeComponentEnd !== null || formattedBudgetCrossed || !currentBlock)
      return;
    currentBlockApproxTokens += estimateTokens(appendedText) + (currentBlock.parts.length > 1 ? 1 : 0);
    if (totalTokens + currentBlockApproxTokens + 64 <= tokenBudget)
      return;
    const previewTokens = totalTokens + estimateTokens(formatBlock(currentBlock));
    if (previewTokens <= tokenBudget)
      return;
    formattedBudgetCrossed = true;
    const component = completedToolComponents.find((candidate) => candidate.start <= ordinal && candidate.end >= ordinal);
    if (component)
      admittedOversizeComponentEnd = component.end;
  }
  function recordFilteredNoise(meta) {
    pendingNoiseMeta.push(meta);
    if (!currentBlock) {
      highestScannedOrdinal = Math.max(highestScannedOrdinal, meta.ordinal);
    }
  }
  function flushCurrentBlock() {
    if (!currentBlock)
      return true;
    const blockText = formatBlock(currentBlock);
    const blockTokens = estimateBlockTokens(blockText);
    if (totalTokens + blockTokens > tokenBudget && totalTokens > 0) {
      const splitsCompletedArc = completedToolArcs.some((arc) => arc.start <= lastOrdinal && arc.end > lastOrdinal);
      if (!splitsCompletedArc)
        return false;
    }
    if (currentBlock.role === "A" && currentBlock.commitHashes.length > 0 && lastFlushedRole !== "A") {
      commitClusters++;
    }
    lastFlushedRole = currentBlock.role;
    if (!firstMessageId)
      firstMessageId = currentBlock.meta[0]?.messageId ?? "";
    lastOrdinal = currentBlock.meta[currentBlock.meta.length - 1]?.ordinal ?? currentBlock.endOrdinal;
    highestScannedOrdinal = Math.max(highestScannedOrdinal, lastOrdinal);
    lastMessageId = currentBlock.meta[currentBlock.meta.length - 1]?.messageId ?? "";
    messagesProcessed += currentBlock.meta.length;
    const lineStart = sourceCharacters + (lines.length > 0 ? 1 : 0);
    const renderedParts = currentBlock.parts.join(" / ");
    let partOffset = lineStart + (blockText.length - renderedParts.length);
    for (let index = 0;index < currentBlock.parts.length; index++) {
      const part = currentBlock.parts[index] ?? "";
      const partMeta = currentBlock.partMeta[index];
      if (partMeta && partMeta.toolResultBodyTokens > 0) {
        toolResultBoundaries.push({
          ordinal: partMeta.ordinal,
          sourceOffset: partOffset,
          bodyTokens: partMeta.toolResultBodyTokens
        });
      }
      partOffset += part.length + (index + 1 < currentBlock.parts.length ? 3 : 0);
    }
    lines.push(blockText);
    sourceCharacters = lineStart + blockText.length;
    lineMeta.push(...currentBlock.meta);
    totalTokens += blockTokens;
    if (currentBlock.isToolOnly) {
      flushedToolOnlyBlocks.push({
        start: currentBlock.startOrdinal,
        end: currentBlock.endOrdinal
      });
    }
    currentBlock = null;
    currentBlockApproxTokens = 0;
    return true;
  }
  for (const msg of messages) {
    if (eligibleEndOrdinal !== undefined && msg.ordinal >= eligibleEndOrdinal)
      break;
    if (admittedOversizeComponentEnd !== null && msg.ordinal > admittedOversizeComponentEnd) {
      break;
    }
    if (msg.ordinal < startOrdinal)
      continue;
    const meta = { ordinal: msg.ordinal, messageId: msg.id };
    if (isHostUnservedRow(msg))
      markHostUnservedRow(meta);
    if (msg.role === "user" && !hasMeaningfulChunkUserText(msg.parts)) {
      const tcSummaries = msg.parts.flatMap((part) => {
        if (expandedResults.has(part))
          return [];
        const expansion = expandedParts.get(part) ?? null;
        return expansion === null ? extractToolCallSummaries([part]) : [`TC: ${expansion}`];
      });
      if (tcSummaries.length === 0) {
        recordFilteredNoise(meta);
        continue;
      }
      const tcText = tcSummaries.join(" / ");
      if (currentBlock && currentBlock.role === "A") {
        currentBlock.endOrdinal = msg.ordinal;
        currentBlock.parts.push(tcText);
        currentBlock.partMeta.push({
          ordinal: msg.ordinal,
          toolResultBodyTokens: extractToolResultBodyTokens(msg.parts)
        });
        currentBlock.meta.push(...pendingNoiseMeta, meta);
        pendingNoiseMeta = [];
      } else {
        if (!flushCurrentBlock())
          break;
        currentBlock = {
          role: "A",
          startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
          endOrdinal: msg.ordinal,
          parts: [tcText],
          partMeta: [
            {
              ordinal: msg.ordinal,
              toolResultBodyTokens: extractToolResultBodyTokens(msg.parts)
            }
          ],
          meta: [...pendingNoiseMeta, meta],
          commitHashes: [],
          isToolOnly: true
        };
        pendingNoiseMeta = [];
      }
      pinComponentWhenFormattedBudgetCrosses(msg.ordinal, tcText);
      continue;
    }
    const role = compactRole(msg.role);
    const textParts = extractTexts2(msg.parts).map((t) => msg.role === "user" ? cleanUserText2(t) : t).map(normalizeText).filter((value) => value.length > 0);
    const allParts = options.expand === false ? [
      ...textParts,
      ...textParts.length === 0 ? extractToolCallSummaries(msg.parts) : []
    ] : msg.parts.flatMap((part) => {
      if (expandedResults.has(part))
        return [];
      const expansion = expandedParts.get(part) ?? null;
      if (expansion !== null)
        return [`TC: ${expansion}`];
      const texts = extractTexts2([part]).map((t) => msg.role === "user" ? cleanUserText2(t) : t).map(normalizeText).filter(Boolean);
      return texts.length ? texts : textParts.length === 0 ? extractToolCallSummaries([part]) : [];
    });
    const compacted = compactTextForSummary(allParts.join(" / "), msg.role);
    const text = compacted.text;
    if (!text) {
      recordFilteredNoise(meta);
      continue;
    }
    const msgHasNarrative = textParts.length > 0;
    if (currentBlock && currentBlock.role === role) {
      currentBlock.endOrdinal = msg.ordinal;
      currentBlock.parts.push(text);
      currentBlock.partMeta.push({
        ordinal: msg.ordinal,
        toolResultBodyTokens: extractToolResultBodyTokens(msg.parts)
      });
      currentBlock.meta.push(...pendingNoiseMeta, meta);
      currentBlock.commitHashes = mergeCommitHashes(currentBlock.commitHashes, compacted.commitHashes);
      if (msgHasNarrative)
        currentBlock.isToolOnly = false;
      pendingNoiseMeta = [];
      pinComponentWhenFormattedBudgetCrosses(msg.ordinal, text);
      continue;
    }
    if (!flushCurrentBlock())
      break;
    currentBlock = {
      role,
      startOrdinal: pendingNoiseMeta[0]?.ordinal ?? msg.ordinal,
      endOrdinal: msg.ordinal,
      parts: [text],
      partMeta: [
        {
          ordinal: msg.ordinal,
          toolResultBodyTokens: extractToolResultBodyTokens(msg.parts)
        }
      ],
      meta: [...pendingNoiseMeta, meta],
      commitHashes: [...compacted.commitHashes],
      isToolOnly: !msgHasNarrative
    };
    pendingNoiseMeta = [];
    pinComponentWhenFormattedBudgetCrosses(msg.ordinal, text);
  }
  if (flushCurrentBlock() && pendingNoiseMeta.length > 0) {
    highestScannedOrdinal = Math.max(highestScannedOrdinal, pendingNoiseMeta[pendingNoiseMeta.length - 1]?.ordinal ?? highestScannedOrdinal);
  }
  const toolOnlyRanges = [];
  for (const range of flushedToolOnlyBlocks) {
    const last = toolOnlyRanges[toolOnlyRanges.length - 1];
    if (last && range.start === last.end + 1) {
      last.end = range.end;
    } else {
      toolOnlyRanges.push({ start: range.start, end: range.end });
    }
  }
  const text = lines.join(`
`);
  const oversizeAtomicUnit = estimateBlockTokens(text) > tokenBudget && completedToolArcs.some((arc) => arc.start <= lastOrdinal && arc.end >= startOrdinal);
  return {
    startIndex: startOrdinal,
    endIndex: lastOrdinal,
    startMessageId: firstMessageId,
    endMessageId: lastMessageId,
    messageCount: messagesProcessed,
    tokenEstimate: totalTokens,
    ...oversizeAtomicUnit ? { oversizeAtomicUnit: true } : {},
    hasMore: Math.max(lastOrdinal, highestScannedOrdinal) < (eligibleEndOrdinal !== undefined ? Math.min(eligibleEndOrdinal - 1, totalMessageCount) : totalMessageCount),
    text,
    lines: lineMeta,
    ...messagesProcessed === 0 && text.length === 0 ? { filteredNoiseLines: pendingNoiseMeta } : {},
    commitClusterCount: commitClusters,
    toolOnlyRanges,
    completedToolArcs,
    toolResultBoundaries
  };
}
function getRawSessionMessageIdsThrough2(sessionId, endOrdinal) {
  if (endOrdinal < 1)
    return [];
  return [...readRawSessionMessageIdOrdinalsForRange2(sessionId, 1, endOrdinal).entries()].sort((left, right) => left[1] - right[1]).map(([id]) => id);
}
function readRawSessionSeedTail2(sessionId, boundaryId, onQuery) {
  const provider = sessionProviders.get(sessionId)?.provider;
  if (provider) {
    const boundaryOrdinal = boundaryId === null ? 1 : readRawSessionMessageOrdinalById2(sessionId, boundaryId);
    if (boundaryOrdinal === null)
      throw new Error("state_sync materialized boundary is missing from raw provider");
    const messages = readRawSessionMessageRange2(sessionId, boundaryOrdinal, getRawSessionMessageOrdinalCount2(sessionId));
    return new Map(messages.map((message) => [message.id, message]));
  }
  if (!openCodeDbExists()) {
    if (boundaryId !== null)
      throw new Error("state_sync raw storage is unavailable for materialized boundary");
    return new Map;
  }
  return withReadOnlySessionDb((db) => {
    onQuery?.();
    return readRawSeedTailFromDb(db, sessionId, boundaryId);
  });
}

export { toolTemplateError, getTagById, expandToolPart, resolveHostServedBoundaryId2, hasRawMessageProvider2, setRawMessageProvider2, setBoundedRawMessageProvider2, withRawMessageProvider2, cleanUserText2, withRawSessionMessageCache2, readRawSessionMessages2, readRawSessionMessagePage2, getRawSessionMessageOrdinalCount2, RAW_MESSAGE_VISIT_PAGE_SIZE2, visitRawSessionMessages2, readRawSessionMessageRange2, primeTailRawMessageCache2, getCachedAbsoluteMessageCount2, primeInMemoryTailRawMessageCache2, readRawSessionMessageOrdinalPage2, getRawSessionStoredMessageCount2, readRawSessionMessageIdOrdinalsForRange2, readRawSessionMessageIdOrdinals2, readRawSessionMessagePartsById2, hasRawSessionMessageById2, readRawSessionMessageOrdinalById2, compareRawSessionMessageOrder2, readRawSessionMessageById2, getRawSessionMessageCount2, RAW_SESSION_TAG_KEY_PAGE_SIZE2, getRawSessionTagKeysThrough2, getLegacyProtectedTailStartOrdinal2, getProtectedTailStartOrdinal2, readSessionChunk2, getRawSessionMessageIdsThrough2, readRawSessionSeedTail2 };
