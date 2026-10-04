import {
  getMagicContextTempDir
} from "./chunk-6q6cxsv6.js";
import {
  isValidSessionId
} from "./chunk-zkqy4wkq.js";

// src/capture.ts
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
function blocksOf(content) {
  return Array.isArray(content) ? content.filter((block) => block !== null && typeof block === "object") : [];
}
var EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
var CAPTURE_TOOL = /__ctx_(skill|memory)$/;
function positiveInteger(value, fallback) {
  if (value === undefined || value.trim() === "")
    return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
function captureSettingsFromEnv(env = process.env) {
  const mode = env.MAGIC_CONTEXT_AUTO_CAPTURE?.trim().toLowerCase();
  return {
    enabled: !["off", "0", "false", "no"].includes(mode ?? ""),
    afterActivity: Math.max(1, positiveInteger(env.MAGIC_CONTEXT_CAPTURE_AFTER, 10)),
    everyActivity: positiveInteger(env.MAGIC_CONTEXT_CAPTURE_EVERY, 60)
  };
}
function stateDirectory() {
  return join(getMagicContextTempDir("claude-code"), "capture");
}
function statePath(sessionId) {
  return join(stateDirectory(), `${sessionId}.json`);
}
var EMPTY_STATE = { offset: 0, activity: 0, edits: 0, verified: false };
function readCaptureState(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(sessionId), "utf8"));
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    return { ...EMPTY_STATE };
  }
}
function writeCaptureState(sessionId, state) {
  mkdirSync(stateDirectory(), { recursive: true, mode: 448 });
  const path = statePath(sessionId);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 384 });
  renameSync(temporary, path);
}
function setCaptureScope(sessionId, scope) {
  if (!isValidSessionId(sessionId))
    return;
  const state = readCaptureState(sessionId);
  if ((state.disabled ?? false) === scope.disabled && (state.memoryDisabled ?? false) === scope.memoryDisabled) {
    return;
  }
  writeCaptureState(sessionId, { ...state, ...scope });
}
function readTranscriptDelta(path, offset) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return { lines: [], offset };
  }
  try {
    const size = fstatSync(descriptor).size;
    const start = size < offset ? 0 : offset;
    if (size === start)
      return { lines: [], offset: start };
    const buffer = Buffer.alloc(size - start);
    readSync(descriptor, buffer, 0, buffer.length, start);
    const lastNewline = buffer.lastIndexOf(10);
    if (lastNewline < 0)
      return { lines: [], offset: start };
    const text = buffer.subarray(0, lastNewline).toString("utf8");
    return {
      lines: text.split(`
`).filter((line) => line.trim().length > 0),
      offset: start + lastNewline + 1
    };
  } finally {
    closeSync(descriptor);
  }
}
function accumulate(state, lines) {
  const next = { ...state };
  const bashCalls = new Set;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object")
      continue;
    if (record.isSidechain === true || record.isMeta === true)
      continue;
    const content = record.message?.content;
    if (record.type === "assistant") {
      for (const block of blocksOf(content)) {
        if (block.type !== "tool_use")
          continue;
        next.activity++;
        const name = String(block.name ?? "");
        if (CAPTURE_TOOL.test(name)) {
          next.activity = 0;
          next.edits = 0;
          next.verified = false;
        } else if (EDIT_TOOLS.has(name)) {
          next.edits++;
          next.verified = false;
        } else if (name === "Bash" && typeof block.id === "string") {
          bashCalls.add(block.id);
        }
      }
    } else if (record.type === "user") {
      if (typeof content === "string" && record.isCompactSummary !== true) {
        next.activity++;
      } else {
        for (const block of blocksOf(content)) {
          if (block.type === "text" && record.isCompactSummary !== true)
            next.activity++;
          if (block.type === "tool_result" && typeof block.tool_use_id === "string" && bashCalls.has(block.tool_use_id) && block.is_error !== true && next.edits > 0) {
            next.verified = true;
          }
        }
      }
    }
  }
  return next;
}
function captureDue(state, settings) {
  if (!settings.enabled || state.disabled)
    return null;
  if (state.edits > 0 && state.verified && state.activity >= settings.afterActivity) {
    return "verified-work";
  }
  if (!state.memoryDisabled && settings.everyActivity > 0 && state.activity >= settings.everyActivity) {
    return "activity";
  }
  return null;
}
function captureInstruction(reason, memoryEnabled = true) {
  const lines = [
    "Magic Context capture — do this yourself, briefly, then stop:",
    ...reason === "verified-work" ? [
      "- You changed code and verified it. If that completed a flow behind a user action (button, form, event, route → API → data written → state updated), save it with ctx_skill (action save): one operation per button/event with the trigger, action, APIs, data writes, state updates, save/linkage, files to modify, the steps to perform it, and how you verified it. Check ctx_skill list first and update an existing skill instead of duplicating it."
    ] : [],
    ...memoryEnabled ? [
      "- Save durable project facts learned since the last capture (decisions, constraints, conventions, config values) with ctx_memory, one fact each, without duplicating what <project-memory> already says."
    ] : [],
    'If nothing qualifies, reply "Nothing to capture." Do not repeat the work or summarize the session.'
  ];
  return lines.join(`
`);
}
function handleStop(payload, settings = captureSettingsFromEnv()) {
  const sessionId = payload.session_id;
  const transcriptPath = payload.transcript_path;
  if (!isValidSessionId(sessionId) || typeof transcriptPath !== "string")
    return null;
  const previous = readCaptureState(sessionId);
  const delta = readTranscriptDelta(transcriptPath, previous.offset);
  let state = accumulate({ ...previous, offset: delta.offset }, delta.lines);
  const due = payload.stop_hook_active === true ? null : captureDue(state, settings);
  if (due)
    state = { ...state, activity: 0, edits: 0, verified: false };
  writeCaptureState(sessionId, state);
  return due ? captureInstruction(due, !state.memoryDisabled) : null;
}

export { readCaptureState, setCaptureScope, handleStop };
