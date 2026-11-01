#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "pi-golden.json");
const defaultSession = join(
  homedir(),
  ".pi/agent/sessions/--Users-ufukaltinok-Work-Projects-CortexKit-anthropic-auth--/2026-05-01T16-48-44-508Z_019de471-4fdc-762d-9286-624dfad0b5fe.jsonl",
);
const sessionsRoot = process.env.PI_SESSIONS_ROOT ?? join(homedir(), ".pi/agent/sessions");
const check = process.argv.includes("--check");

const requiredClasses = [
  "text_signature",
  "thinking_signature",
  "redacted_thinking",
  "image",
  "tool_call_split_pipe",
  "thought_signature",
  "tool_result",
  "tool_result_details",
  "custom_message",
  "compaction",
  "aborted_assistant",
  "response_id_mid",
  "timestamp_fallback_mid",
] as const;

type RequiredClass = (typeof requiredClasses)[number];

type CapturedEntry = { path: string; entry: any };

if (check) {
  const golden = JSON.parse(readFileSync(outPath, "utf8"));
  assertInternalConsistency(golden);
  process.exit(0);
}

const files = sessionFiles();
const selected = selectEntries(files);
const entries = selected.entries.map(({ entry }) => sanitizeEntry(entry));
const golden = {
  projection_oracle: {
    status: "todo",
    reason:
      "The Pi provider serializer entry points are not vendored in the Rust workspace test closure; these goldens assert AgentMessage/session-entry round-trip identity for non-compaction entries. TODO: replace this fallback with provider serializer byte projection when the Pi SDK is available to the generator.",
  },
  generated_from: {
    session_files: [...new Set(selected.entries.map((entry) => entry.path))].sort(),
    selection: "JSONL session-entry feature scan over captured Pi session files",
  },
  coverage: selected.coverage,
  missing_capture_classes: selected.missing,
  cases: [
    {
      name: "captured-pi-feature-entries",
      entries,
    },
  ],
};
assertInternalConsistency(golden);
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);

function sessionFiles(): string[] {
  if (existsSync(defaultSession)) return [defaultSession, ...walkJsonl(sessionsRoot).filter((p) => p !== defaultSession)];
  return walkJsonl(sessionsRoot);
}

function walkJsonl(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) stack.push(path);
      else if (path.endsWith(".jsonl")) out.push(path);
    }
  }
  return out.sort();
}

function selectEntries(files: string[]): {
  entries: CapturedEntry[];
  coverage: RequiredClass[];
  missing: RequiredClass[];
} {
  const wanted = new Set<RequiredClass>(requiredClasses);
  const byClass = new Map<RequiredClass, CapturedEntry>();
  for (const path of files) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      for (const klass of classify(entry)) {
        if (wanted.has(klass) && !byClass.has(klass)) byClass.set(klass, { path, entry });
      }
      if ([...wanted].every((klass) => byClass.has(klass) || klass === "redacted_thinking")) {
        // redacted_thinking is allowed to be absent when no scanned JSONL entry contains it.
        break;
      }
    }
  }

  const unique = new Map<string, CapturedEntry>();
  const coverage: RequiredClass[] = [];
  const missing: RequiredClass[] = [];
  for (const klass of requiredClasses) {
    const hit = byClass.get(klass);
    if (hit) {
      coverage.push(klass);
      unique.set(`${hit.path}:${hit.entry.id ?? JSON.stringify(hit.entry).slice(0, 80)}`, hit);
    } else {
      missing.push(klass);
    }
  }
  return { entries: [...unique.values()], coverage, missing };
}

function classify(entry: any): RequiredClass[] {
  const out: RequiredClass[] = [];
  if (entry?.type === "custom_message") out.push("custom_message");
  if (entry?.type === "compaction") out.push("compaction");
  const message = entry?.type === "message" ? entry.message : undefined;
  if (!message) return out;
  if (typeof message.responseId === "string" && message.responseId.length > 0) out.push("response_id_mid");
  if (message.responseId === undefined && typeof message.timestamp === "number") out.push("timestamp_fallback_mid");
  if (message.role === "assistant" && message.stopReason === "aborted" && Array.isArray(message.content) && message.content.length === 0) {
    out.push("aborted_assistant");
  }
  if (message.role === "toolResult") {
    out.push("tool_result");
    if (message.details !== undefined) out.push("tool_result_details");
  }
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.textSignature === "string") out.push("text_signature");
    if (part.type === "thinking" && typeof part.thinkingSignature === "string") out.push("thinking_signature");
    if (part.type === "thinking" && part.redacted === true) out.push("redacted_thinking");
    if (part.type === "image") out.push("image");
    if (part.type === "toolCall" && typeof part.id === "string" && part.id.includes("|")) out.push("tool_call_split_pipe");
    if (part.type === "toolCall" && typeof part.thoughtSignature === "string") out.push("thought_signature");
  }
  return out;
}

function sanitizeEntry(entry: any): unknown {
  return sanitize(entry, []);
}

function sanitize(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) return value.map((item, index) => sanitize(item, [...path, String(index)]));
  if (value === null || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (typeof child === "string") output[key] = sanitizeString(key, child);
    else output[key] = sanitize(child, [...path, key]);
  }
  return output;
}

function sanitizeString(key: string, text: string): string {
  if (text.length === 0) return text;
  if (new Set(["text", "thinking", "summary", "content", "errorMessage"]).has(key)) {
    return sameLength(text, key);
  }
  if (key === "data") return sameLength(text, "base64");
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
    throw new Error(`Pi golden neither covers nor records missing classes: ${unresolved.join(", ")}`);
  }
  const cases = golden.cases ?? [];
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("Pi golden has no cases");
  for (const testCase of cases) {
    if (!Array.isArray(testCase.entries) || testCase.entries.length === 0) {
      throw new Error(`Pi case ${testCase.name ?? "<unnamed>"} has no entries`);
    }
    for (const entry of testCase.entries) {
      if (typeof entry?.type !== "string") throw new Error("Pi fixture entry lacks type");
      if (entry.type === "message" && (!entry.id || !entry.message?.role)) {
        throw new Error("Pi message fixture lacks session-entry envelope or AgentMessage role");
      }
    }
  }
}
