import {
  buildGuidance,
  escapeXmlContent,
  clearIndexedMessages,
  getSessionNotes,
  StorageUnavailableError,
  openRuntime,
  claudePidFromEnv,
  recordCurrentSession,
  pruneSessionHandoffs,
  getMemoriesByProject,
  getMemoriesByProjects,
  renderGlance,
  DEFAULT_MEMORY_BUDGET_TOKENS,
  resolveWorkspaceRenderContext,
  sourceNamesForMemories,
  trimMemoriesToBudgetV2,
  trimWorkspaceMemoriesToBudgetV2,
  renderMemoryBlockV2
} from "./chunk-32ztc1br.js";
import"./chunk-6q6cxsv6.js";
import {
  flushLogger
} from "./chunk-e4mkgkj9.js";
import {
  locateTranscript,
  resolveHookSession
} from "./chunk-zkqy4wkq.js";
import {
  setCaptureScope
} from "./chunk-by49a6at.js";
import"./chunk-q5f7wcc8.js";
import"./chunk-eea1pbdp.js";
import"./chunk-sztkf4tn.js";
import {
  listSkills,
  driftOf,
  isStale
} from "./chunk-q6aesfzf.js";
import"./chunk-t7etejbh.js";

// src/hook.ts
import { readFileSync } from "node:fs";

// src/inject.ts
var MAX_NOTES_SHOWN = 10;
var MAX_OPERATIONS_SHOWN = 40;
function renderProjectMemory(runtime, sessionId) {
  const { db, config, projectPath } = runtime;
  if (!projectPath)
    return { block: "", count: 0 };
  const workspace = resolveWorkspaceRenderContext({ db, projectPath });
  const now = Date.now();
  const memories = workspace.isWorkspaced ? getMemoriesByProjects(db, workspace.expandedIdentities, ["active", "permanent"], now, workspace.ownIdentities, workspace.shareCategories) : getMemoriesByProject(db, projectPath, ["active", "permanent"], now);
  if (memories.length === 0)
    return { block: "", count: 0 };
  const budget = config.memory?.injection_budget_tokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
  const renderOptions = {
    sourceNameByMemoryId: sourceNamesForMemories({ memories, projectPath, workspace })
  };
  const trimmed = workspace.isWorkspaced ? trimWorkspaceMemoriesToBudgetV2(sessionId, memories, budget, workspace, renderOptions) : trimMemoriesToBudgetV2(sessionId, memories, budget);
  return {
    block: renderMemoryBlockV2(trimmed.renderOrder, "project-memory", renderOptions),
    count: trimmed.renderOrder.length
  };
}
function renderSessionNotes(runtime, sessionId) {
  const notes = getSessionNotes(runtime.db, sessionId);
  if (notes.length === 0)
    return { block: "", count: 0 };
  const glance = renderGlance(notes.map((note) => ({ ...note, content: escapeXmlContent(note.content) })), { limit: MAX_NOTES_SHOWN, offset: 0, nowMs: Date.now() });
  return {
    block: `<session-notes>
${glance}
</session-notes>`,
    count: notes.length
  };
}
function renderProjectSkills(projectDir) {
  const skills = listSkills(projectDir);
  const lines = [];
  let count = 0;
  for (const skill of skills) {
    lines.push(`${skill.name} — ${skill.title} (scope: ${skill.scope})`);
    for (const operation of skill.operations) {
      count++;
      if (count > MAX_OPERATIONS_SHOWN)
        continue;
      const api = operation.apis[0];
      const parts = [`${operation.trigger.kind} "${operation.trigger.label}"`];
      if (api)
        parts.push(`${api.method ? `${api.method.toUpperCase()} ` : ""}${api.endpoint}`);
      if (operation.writes.length > 0) {
        parts.push(`writes ${operation.writes.map((write) => write.target).join(", ")}`);
      }
      const stale = isStale(driftOf(projectDir, operation)) ? " [files changed since verified]" : "";
      lines.push(`  - ${operation.id}: ${parts.join(" → ")}${stale}`);
    }
  }
  if (count === 0)
    return { block: "", count: 0 };
  if (count > MAX_OPERATIONS_SHOWN) {
    lines.push(`  … ${count - MAX_OPERATIONS_SHOWN} more (ctx_skill list)`);
  }
  return {
    block: `<project-skills>
${escapeXmlContent(lines.join(`
`))}
</project-skills>`,
    count
  };
}
function buildSessionContext(runtime, session, source) {
  if (runtime.config.enabled !== true)
    return null;
  const memoryEnabled = runtime.config.memory?.enabled !== false;
  const memory = memoryEnabled ? renderProjectMemory(runtime, session.sessionId) : { block: "", count: 0 };
  const notes = renderSessionNotes(runtime, session.sessionId);
  const skills = renderProjectSkills(session.directory);
  const sections = [buildGuidance({ memoryEnabled })];
  if (source === "compact") {
    sections.push("Claude Code just compacted this conversation. What it dropped is still retrievable: ctx_search finds it and ctx_expand returns the original wording. If the summary above holds durable facts or verified flows that are not saved yet, save them now (ctx_memory, ctx_skill).");
  }
  if (skills.block)
    sections.push(skills.block);
  if (memory.block)
    sections.push(memory.block);
  else if (memoryEnabled) {
    sections.push(`<project-memory>
No memories are recorded for this project yet.
</project-memory>`);
  }
  if (notes.block)
    sections.push(notes.block);
  return {
    text: `<magic-context>
${sections.join(`

`)}
</magic-context>`,
    memoryCount: memory.count,
    noteCount: notes.count,
    operationCount: skills.count
  };
}

// src/maintenance.ts
var IDLE_BEFORE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
var PRUNE_BATCH = 25;
function pruneVanishedTranscriptIndexes(db, options = {}) {
  const cutoff = (options.now ?? Date.now()) - IDLE_BEFORE_PRUNE_MS;
  const rows = db.prepare("SELECT session_id FROM message_history_index WHERE harness = 'claude-code' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?").all(cutoff, PRUNE_BATCH);
  let pruned = 0;
  for (const { session_id: sessionId } of rows) {
    if (locateTranscript({ sessionId, configDir: options.configDir }))
      continue;
    clearIndexedMessages(db, sessionId);
    pruned++;
  }
  return { checked: rows.length, pruned };
}

// src/hook.ts
console.log = console.error;
console.info = console.error;
console.debug = console.error;
var SESSION_START_SOURCES = [
  "startup",
  "resume",
  "clear",
  "compact"
];
function readPayload() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function emit(output) {
  process.stdout.write(`${JSON.stringify(output)}
`);
}
function sessionStart(payload) {
  const session = resolveHookSession(payload);
  if (!session) {
    console.error("[magic-context] SessionStart payload carried no usable session id");
    return;
  }
  const source = SESSION_START_SOURCES.find((candidate) => candidate === payload.source) ?? "startup";
  const claudePid = claudePidFromEnv();
  if (claudePid !== null) {
    try {
      recordCurrentSession(claudePid, {
        sessionId: session.sessionId,
        directory: session.directory,
        updatedAt: Date.now()
      });
    } catch (error) {
      console.error(`[magic-context] could not record the current session: ${String(error)}`);
    }
  }
  let runtime;
  try {
    runtime = openRuntime(session.directory);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[magic-context] ${reason}`);
    if (error instanceof StorageUnavailableError) {
      emit({ systemMessage: `Magic Context memory is not loaded. ${reason}` });
    }
    return;
  }
  try {
    setCaptureScope(session.sessionId, {
      disabled: runtime.config.enabled !== true,
      memoryDisabled: runtime.config.memory?.enabled === false
    });
  } catch (error) {
    console.error(`[magic-context] could not record capture settings: ${String(error)}`);
  }
  try {
    const context = buildSessionContext(runtime, session, source);
    if (context) {
      emit({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context.text
        }
      });
    }
    try {
      pruneVanishedTranscriptIndexes(runtime.db);
      pruneSessionHandoffs();
    } catch (error) {
      console.error(`[magic-context] index pruning skipped: ${String(error)}`);
    }
  } finally {
    runtime.close();
  }
}
var event = process.argv[2];
try {
  if (event === "session-start")
    sessionStart(readPayload());
  else
    console.error(`[magic-context] unknown hook event: ${event ?? "(none)"}`);
} catch (error) {
  console.error(`[magic-context] hook ${event ?? ""} failed: ${String(error)}`);
}
flushLogger();
process.exit(0);
