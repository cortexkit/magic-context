/**
 * DG-1..6 reference generator.
 *
 * The reference side intentionally owns only canonical JSON and wire-visible fields. Rust
 * consumes the exact request fixtures in-process; neither side derives expected bytes from the
 * other. Keep this file dependency-free so regeneration works before the plugin is built.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const generatorVersion = "dg-reference-v4";
const textMessage = (role: string, text: string, id?: string) => ({
  role,
  content: [{ kind: { type: "text", text } }],
  meta: id ? { harness_id: id } : {},
});
const syntheticTextMessage = (role: string, text: string, id: string) => ({
  ...textMessage(role, text, id),
  meta: { harness_id: id, synthetic: true },
});
const userTerminatedReference = (messages: readonly ReturnType<typeof textMessage>[]) => {
  const output = [...messages];
  const userIndex = output.findLastIndex((message) => message.role === "user");
  const trailing = output.slice(userIndex + 1);
  const contentless = trailing.every(
    (message) =>
      message.role === "assistant" &&
      message.content.every(
        (block) => block.kind.type === "text" && block.kind.text.trim().length === 0,
      ),
  );
  if (userIndex >= 0 && contentless) output.push(...output.splice(userIndex, 1));
  return output;
};
const incidentMessages = [
  textMessage("assistant", "leading sibling text", "assistant-sibling"),
  {
    role: "assistant",
    content: [
      {
        kind: {
          type: "opaque",
          source: { source: "opencode" },
          kind: "step-start",
          raw: { type: "step-start", snapshot: "raw-store-step" },
        },
      },
      { kind: { type: "reasoning", text: "merged reasoning", signature: "sig" } },
      {
        kind: {
          type: "tool_call",
          id: "call-incident",
          name: "TERMINAL",
          input: { command: "pwd" },
          provider_executed: false,
        },
      },
      {
        kind: {
          type: "opaque",
          source: { source: "opencode" },
          kind: "step-finish",
          raw: { type: "step-finish", reason: "tool-calls" },
        },
      },
    ],
    meta: { harness_id: "assistant-target" },
  },
] as const;
const trailingBlankKeepReference = (messages: typeof incidentMessages) => {
  const output = structuredClone(messages) as unknown as Array<{
    content: Array<{ kind: { type: string; text?: string } }>;
    meta?: { harness_id?: string };
  }>;
  const target = output.find((message) => message.meta?.harness_id === "assistant-target");
  if (!target) throw new Error("incident target is missing");
  let trailingCount = 0;
  while (
    trailingCount < target.content.length &&
    target.content[target.content.length - trailingCount - 1]?.kind.type === "text" &&
    target.content[target.content.length - trailingCount - 1]?.kind.text?.trim() === ""
  ) {
    trailingCount += 1;
  }
  // A keep normalizes a supplied suffix to one canonical blank, but an absent suffix is untouched.
  if (trailingCount > 0) {
    target.content.splice(target.content.length - trailingCount, trailingCount, {
      kind: { type: "text", text: "" },
    });
  }
  return output;
};
const scenarios = [
  {
    id: "DG-1-bust-veto",
    family: "postprocess-gates",
    input: { session_id: "dg-session", markers: ["bust", "veto"], messages: [textMessage("user", "stable input")] },
    output: { status: "ok", action: "passthrough", decision: "defer" },
  },
  {
    id: "DG-2-marker-representation",
    family: "marker-representation",
    input: { session_id: "dg-session", markers: ["<system-reminder>", "[dropped 2]"], messages: [textMessage("assistant", "kept tail")] },
    output: { status: "ok", action: "passthrough", decision: "replay" },
  },
  {
    id: "DG-3-escalation-band",
    family: "escalation-bands",
    input: { session_id: "dg-session", markers: ["band-275", "band-276"], messages: [textMessage("tool", "bounded output")] },
    output: { status: "ok", action: "passthrough", decision: "materialize" },
  },
  {
    id: "DG-4-contentless-assistant-tail",
    family: "user-terminated-tail",
    input: {
      session_id: "dg-assistant-tail",
      markers: ["assistant-prefill", "contentless"],
      messages: [textMessage("user", "retry prompt", "prompt"), textMessage("assistant", " \n", "dead-shell")],
    },
    output: { status: "ok", action: "passthrough", decision: "reanchor-user" },
  },
  {
    id: "DG-5-newest-synthetic-live-prompt",
    family: "newest-synthetic-user",
    input: {
      session_id: "dg-notice-triggered",
      markers: ["synthetic-user", "live-prompt"],
      messages: [
        textMessage("user", "original prompt", "prompt"),
        textMessage("assistant", "completed answer", "answer"),
        syntheticTextMessage(
          "user",
          "<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>",
          "notice",
        ),
      ],
    },
    output: { status: "ok", action: "passthrough", decision: "preserve-live-prompt" },
  },
  {
    id: "DG-6-trailing-blank-keep-zero-source",
    family: "trailing-blank-keep-zero-source",
    input: {
      session_id: "dg-trailing-blank-incident",
      markers: ["merged-composite", "frozen-keep", "zero-source-trailing"],
      frozen_decision: { message_id: "assistant-target", decision: "keep" },
      messages: incidentMessages,
    },
    output: { status: "ok", action: "passthrough", decision: "keep-no-manufacture" },
    referenceWire: trailingBlankKeepReference(incidentMessages),
  },
] as const;

const canonical = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const inputHash = createHash("sha256").update(canonical(scenarios.map(({ id, family, input }) => ({ id, family, input })))).digest("hex");
const golden = {
  schema: 1,
  provenance: {
    generator: "crates/mc-module/gen/gen-differential-golden.ts",
    generator_version: generatorVersion,
    input_sha256: inputHash,
  },
  cases: scenarios.map((scenario) => {
    const { id, family, input, output } = scenario;
    return {
      id,
      family,
      input,
      // Store both gate results (`status`, `action`, and `decision`) and the messages exposed on the wire.
      expected: {
        ...output,
        wire:
          "referenceWire" in scenario
            ? scenario.referenceWire
            : family === "user-terminated-tail"
              ? userTerminatedReference(input.messages as ReturnType<typeof textMessage>[])
              : input.messages,
      },
    };
  }),
};

const outPath = join(dirname(import.meta.path), "../testdata/differential-golden.json");
await Bun.write(outPath, canonical(golden));
console.log(`wrote ${outPath} (${golden.cases.length} DG cases, input ${inputHash})`);
