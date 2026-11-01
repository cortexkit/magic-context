#!/usr/bin/env bun
import "./quiet-live-log";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
function sourceFixture(): string {
  const sourceArg = process.argv.indexOf("--source");
  if (sourceArg !== -1) {
    const path = process.argv[sourceArg + 1];
    if (!path || path.startsWith("--")) throw new Error("--source requires a fixture path");
    return resolve(repoRoot, path);
  }
  const relative = resolve(repoRoot, "../llm-runner/crates/llmr-ck/tests/fixtures/ck_wire_golden.json");
  if (existsSync(relative)) return relative;
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const mainRepo = dirname(commonDir);
  const fromMainRepo = resolve(mainRepo, "../llm-runner/crates/llmr-ck/tests/fixtures/ck_wire_golden.json");
  if (existsSync(fromMainRepo)) return fromMainRepo;
  return relative;
}

const source = sourceFixture();
const vendored = resolve(repoRoot, "crates/mc-module/testdata/ck_wire_golden.json");
const projectionOut = resolve(repoRoot, "crates/mc-module/testdata/ingress-projection-golden.json");
const check = process.argv.includes("--check");

const sourceBytes = readFileSync(source);
const messages = JSON.parse(sourceBytes.toString("utf8"));


function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function blockId(mid: string, index: number): string {
  return `${mid}#${index}`;
}

function kindTag(block: any): string {
  return block.kind.type;
}

function outputKind(block: any): string | undefined {
  return block.kind.type === "tool_result" ? block.kind.output.kind.type : undefined;
}

function filePath(input: any): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  for (const key of ["filePath", "file_path", "path"] as const) {
    if (typeof input[key] === "string") return input[key];
  }
  return undefined;
}

function adjacentToolCall(mid: string, index: number, content: any[]): string | undefined {
  if (index > 0 && content[index - 1]?.kind?.type === "tool_call") return blockId(mid, index - 1);
  if (index + 1 < content.length && content[index + 1]?.kind?.type === "tool_call") return blockId(mid, index + 1);
  return undefined;
}

function project(messages: any[]): any[] {
  const pending = new Map<string, string[]>();
  const out: any[] = [];
  messages.forEach((ck, messageIndex) => {
    const mid = `m${messageIndex}`;
    const ordinal = messageIndex + 1;
    if (ck.role === "assistant") {
      pending.clear();
      ck.content.forEach((block: any, index: number) => {
        if (block.kind.type === "tool_call") {
          const q = pending.get(block.kind.id) ?? [];
          q.push(blockId(mid, index));
          pending.set(block.kind.id, q);
        }
      });
    } else if (ck.role !== "tool") {
      pending.clear();
    }

    ck.content.forEach((block: any, index: number) => {
      const kind = block.kind;
      let arc_id: string | undefined;
      if (ck.role === "assistant" && kind.type === "tool_call") {
        arc_id = blockId(mid, index);
      } else if (kind.type === "tool_result") {
        const q = pending.get(kind.id) ?? [];
        arc_id = q.shift();
        if (!arc_id) throw new Error(`unpaired tool_result ${kind.id}`);
      } else if (ck.role === "assistant" && (kind.type === "reasoning" || kind.type === "redacted_reasoning")) {
        arc_id = adjacentToolCall(mid, index, ck.content);
      }

      const row: any = {
        id: blockId(mid, index),
        mid,
        block_index: index,
        ordinal,
        role: ck.role,
        kind_tag: kind.type,
        provider_executed: Boolean(kind.provider_executed),
        bytes: stableStringify(block),
        synthetic: Boolean(ck.meta?.synthetic),
      };
      if (kind.type === "tool_call") {
        row.name = kind.name;
        const p = filePath(kind.input);
        if (p !== undefined) row.file_path = p;
        row.tool_input = kind.input;
        row.tool_call_id = kind.id;
      }
      if (kind.type === "tool_result") {
        row.tool_call_id = kind.id;
        row.output_kind = outputKind(block);
      }
      if (arc_id !== undefined) row.arc_id = arc_id;
      out.push(row);
    });
  });
  return out;
}

const projection = Buffer.from(`${JSON.stringify(project(messages), null, 2)}\n`, "utf8");

if (check) {
  const vendoredBytes = readFileSync(vendored);
  if (!vendoredBytes.equals(sourceBytes)) {
    throw new Error(`${vendored} drifted from ${source}`);
  }
  const existingProjection = readFileSync(projectionOut);
  if (!existingProjection.equals(projection)) {
    throw new Error(`${projectionOut} is stale; run ${process.argv[1]}`);
  }
} else {
  writeFileSync(vendored, sourceBytes);
  writeFileSync(projectionOut, projection);
}
