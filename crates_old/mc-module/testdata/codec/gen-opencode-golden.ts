#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "opencode-golden.json");
const dbPath = process.env.OPENCODE_DB ?? join(homedir(), ".local/share/opencode/opencode.db");
const check = process.argv.includes("--check");

const requiredClasses = [
  "text",
  "ignored_text",
  "empty_text",
  "reasoning_signature",
  "tool_completed",
  "tool_error",
  "file",
  "step_start",
  "compaction",
  "subtask",
  "step_finish",
  "patch",
] as const;

type RequiredClass = (typeof requiredClasses)[number];

type Row = {
  session_id: string;
  message_id: string;
  message_data: string;
  part_data: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
};

type PartRow = {
  id: string;
  time_created: number;
  data: string;
};

if (check) {
  const golden = JSON.parse(readFileSync(outPath, "utf8"));
  assertInternalConsistency(golden);
  process.exit(0);
}

if (!existsSync(dbPath)) {
  throw new Error(`OpenCode database not found: ${dbPath}`);
}

const db = new Database(dbPath, { readonly: true });
try {
  const selected = selectCapturedRows(db);
  const messageIds = [...new Set(selected.rows.map((row) => row.message_id))].sort();
  const messages = messageIds.map((messageId) => loadMessageV2(db, messageId));
  const golden = {
    projection_oracle: {
      status: "todo",
      reason:
        "The OpenCode SDK serializer is not vendored in the Rust workspace test closure; these goldens assert raw-part identity for wire-reachable parts plus sidecar re-attach, with compaction parts excluded because the codec emits them as a boundary signal. TODO: replace this fallback with toModelMessagesEffect byte projection when the SDK is available to the generator.",
    },
    generated_from: {
      db_path: dbPath,
      selection: "part-table feature queries over read-only captured OpenCode rows",
    },
    coverage: selected.coverage,
    missing_capture_classes: selected.missing,
    cases: [
      {
        name: "captured-opencode-feature-rows",
        source_message_ids: messageIds,
        messages,
      },
    ],
  };
  assertInternalConsistency(golden);
  writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
} finally {
  db.close();
}

function selectCapturedRows(db: Database): {
  rows: Row[];
  coverage: RequiredClass[];
  missing: RequiredClass[];
} {
  const predicates: Array<[RequiredClass, string, string]> = [
    ["text", "json_extract(p.data, '$.type') = 'text' AND COALESCE(json_extract(p.data, '$.ignored'), 0) = 0 AND COALESCE(json_extract(p.data, '$.text'), '') <> ''", "length(COALESCE(json_extract(p.data, '$.text'), '')) ASC"],
    ["ignored_text", "json_extract(p.data, '$.type') = 'text' AND COALESCE(json_extract(p.data, '$.ignored'), 0) = 1", "length(COALESCE(json_extract(p.data, '$.text'), '')) ASC"],
    ["empty_text", "json_extract(p.data, '$.type') = 'text' AND json_extract(p.data, '$.text') = ''", "p.time_created ASC"],
    ["reasoning_signature", "json_extract(p.data, '$.type') = 'reasoning' AND json_type(p.data, '$.metadata') IS NOT NULL", "length(COALESCE(json_extract(p.data, '$.text'), '')) ASC"],
    ["tool_completed", "json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.state.status') = 'completed'", "length(COALESCE(json_extract(p.data, '$.state.output'), '')) ASC"],
    ["tool_error", "json_extract(p.data, '$.type') = 'tool' AND json_extract(p.data, '$.state.status') = 'error'", "length(COALESCE(json_extract(p.data, '$.state.output'), '')) ASC"],
    ["file", "json_extract(p.data, '$.type') = 'file'", "length(p.data) ASC"],
    ["step_start", "json_extract(p.data, '$.type') = 'step-start'", "p.time_created ASC"],
    ["compaction", "json_extract(p.data, '$.type') = 'compaction'", "p.time_created DESC"],
    ["subtask", "json_extract(p.data, '$.type') = 'subtask'", "p.time_created DESC"],
    ["step_finish", "json_extract(p.data, '$.type') = 'step-finish'", "p.time_created ASC"],
    ["patch", "json_extract(p.data, '$.type') = 'patch'", "length(p.data) ASC"],
  ];

  const rows: Row[] = [];
  const coverage: RequiredClass[] = [];
  const missing: RequiredClass[] = [];
  for (const [klass, where, orderBy] of predicates) {
    const row = db
      .query<Row, []>(
        `SELECT p.session_id, p.message_id, m.data AS message_data, p.data AS part_data
         FROM part p
         JOIN message m ON m.id = p.message_id
         WHERE ${where}
         ORDER BY ${orderBy}, p.session_id ASC, p.message_id ASC, p.id ASC
         LIMIT 1`,
      )
      .get();
    if (row) {
      rows.push(row);
      coverage.push(klass);
    } else {
      missing.push(klass);
    }
  }
  return { rows, coverage, missing };
}

function loadMessageV2(db: Database, messageId: string): unknown {
  const message = db
    .query<MessageRow, [string]>(
      "SELECT id, session_id, time_created, data FROM message WHERE id = ? LIMIT 1",
    )
    .get(messageId);
  if (!message) throw new Error(`selected message vanished: ${messageId}`);
  const parts = db
    .query<PartRow, [string]>(
      "SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC",
    )
    .all(messageId)
    .map((part) => sanitizePart(JSON.parse(part.data)));
  return {
    info: {
      id: message.id,
      sessionID: message.session_id,
      ...sanitizeMessageInfo(JSON.parse(message.data)),
    },
    parts,
  };
}

function sanitizeMessageInfo(value: unknown): unknown {
  return sanitize(value, []);
}

function sanitizePart(value: unknown): unknown {
  return sanitize(value, []);
}

function sanitize(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) return value.map((item, index) => sanitize(item, [...path, String(index)]));
  if (value === null || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (typeof child === "string") {
      output[key] = sanitizeString(key, child, input);
    } else {
      output[key] = sanitize(child, [...path, key]);
    }
  }
  return output;
}

function sanitizeString(key: string, text: string, parent: Record<string, unknown>): string {
  if (text.length === 0) return text;
  if (key === "url" && text.startsWith("data:")) {
    const mime = typeof parent.mime === "string" ? parent.mime : "application/octet-stream";
    return `data:${mime};base64,${sameLength(text.split(",").at(1) ?? "", "base64")}`;
  }
  if (key === "data") return sameLength(text, "base64");
  if (new Set(["text", "output", "summary", "errorMessage", "content", "prompt", "cmd", "command", "query", "q"]).has(key)) {
    return sameLength(text, key);
  }
  return text;
}

function sameLength(text: string, label: string): string {
  const seed = `[redacted:${label}]`;
  return seed.repeat(Math.ceil(text.length / seed.length)).slice(0, text.length);
}

function assertInternalConsistency(golden: any): void {
  const coverage = new Set<string>(golden.coverage ?? []);
  const missing = new Set<string>(golden.missing_capture_classes ?? []);
  const unresolved = requiredClasses.filter((klass) => !coverage.has(klass) && !missing.has(klass));
  if (unresolved.length > 0) {
    throw new Error(`OpenCode golden neither covers nor records missing classes: ${unresolved.join(", ")}`);
  }
  const cases = golden.cases ?? [];
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("OpenCode golden has no cases");
  for (const testCase of cases) {
    if (!Array.isArray(testCase.messages) || testCase.messages.length === 0) {
      throw new Error(`OpenCode case ${testCase.name ?? "<unnamed>"} has no messages`);
    }
    for (const message of testCase.messages) {
      if (!message?.info?.id || !Array.isArray(message.parts)) {
        throw new Error("OpenCode fixture message is not MessageV2-shaped");
      }
    }
  }
}
