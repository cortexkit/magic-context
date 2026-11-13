import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readReplayDocument } from "../../plugin/src/features/magic-context/storage-replay-document";
import type { Database } from "../../plugin/src/shared/sqlite";
import type { MockResponse } from "./mock-provider/server";
import { RustTestHarness } from "./rust-harness";

export type ReplayWireFamily = "anthropic_messages" | "openai_responses";

export type ReplayBlockShape = {
    type: "text" | "thinking" | "redacted_thinking";
    text_bytes?: number;
    thinking_bytes?: number;
    signature_bytes?: number;
    dropped_tag?: number;
    empty?: boolean;
};

export type ReplayOpenAIItemShape =
    | { type: "message"; text_bytes: number; empty?: boolean }
    | {
          type: "reasoning";
          summary_bytes?: number;
          encrypted_content_bytes?: number;
      }
    | {
          type: "function_call";
          call_id: string;
          name: string;
          arguments: Record<string, unknown>;
      };

type ReplayResponseShape =
    | {
          blocks: ReplayBlockShape[];
          input_tokens: number;
          output_tokens: number;
      }
    | {
          items: ReplayOpenAIItemShape[];
          input_tokens: number;
          output_tokens: number;
      };

export type ReplayPassShape = {
    label: string;
    input_text_bytes: number;
    response: ReplayResponseShape | { sequence: ReplayResponseShape[] };
};

type ReplayAdjudication = {
    pass: string;
    axis:
        | "empty_content_shapes"
        | "dropped_placeholder_shapes"
        | "reasoning_signature_shapes"
        | "tool_pairing_shapes";
    ts_only: string[];
    rust_only: string[];
    decision: "intentional_difference";
    reason: string;
    source: string;
};

export type ReplayProviderArm = {
    id: string;
    provider_id: string;
    provider_api: "@ai-sdk/anthropic" | "@ai-sdk/openai";
    model_id: string;
    wire_family: ReplayWireFamily;
    setup?: {
        label: string;
        input_text_bytes: number;
        reasoning?: {
            thinking_bytes: number;
            signature_bytes: number;
        };
        tool_call: {
            call_id: string;
            name: string;
            arguments: Record<string, unknown>;
        };
        replace_tool_output_with_dropped_sentinel?: boolean;
    };
    passes: ReplayPassShape[];
    adjudications?: ReplayAdjudication[];
};

export type ReplayFixture = {
    schema: 2;
    source: { report: string; capture: string; sanitization: string };
    provider_arms: ReplayProviderArm[];
};

type ValueSpaceAxis = {
    classification: "matched_value_space" | "divergent_value_space";
    ts_only: string[];
    rust_only: string[];
    shared: string[];
    adjudication?: {
        decision: "intentional_difference";
        reason: string;
        source: string;
    };
};

export type ReplayDivergenceRow = {
    pass: string;
    wire_bytes: { ts: number; rust: number; equal: boolean; first_diff_byte: number | null };
    wire_structure: {
        ts: Array<{ role: string; blocks: string[] }>;
        rust: Array<{ role: string; blocks: string[] }>;
    };
    empty_content_shapes: ValueSpaceAxis;
    dropped_placeholder_shapes: ValueSpaceAxis;
    reasoning_signature_shapes: ValueSpaceAxis;
    tool_pairing_shapes: ValueSpaceAxis;
};

export type PairedReplayResult = {
    fixture: ReplayFixture["source"];
    provider_arm: string;
    provider_id: string;
    wire_family: ReplayWireFamily;
    sessions: { ts: string; rust: string };
    passes: ReplayDivergenceRow[];
    divergence_count: number;
    unadjudicated_divergence_count: number;
};

export type TrailingBlankReplayStage =
    | "streaming"
    | "next_turn_pass_1"
    | "next_turn_pass_2"
    | "late_blank";

export type TrailingBlankSequenceReplayResult = {
    fixture: "trailing-blank-incident-geometry";
    stages: Record<
        TrailingBlankReplayStage,
        {
            ts: {
                bytes: number;
                sha256: string;
                decision: string | null;
                source_parts: string[];
                blocks: string[];
            };
            rust: {
                bytes: number;
                sha256: string;
                decision: string | null;
                source_parts: string[];
                blocks: string[];
            };
            equal: boolean;
        }
    >;
    ts_stable: boolean;
    rust_stable: boolean;
    parity: boolean;
};

type ValueSpace = {
    empty_content_shapes: string[];
    dropped_placeholder_shapes: string[];
    reasoning_signature_shapes: string[];
    tool_pairing_shapes: string[];
};

type WireEntry = Record<string, unknown>;

const DROPPED = /^\[dropped(?: §\d+§)?\]$/u;
const MC_TAG_PREFIX = /^§\d+§\s*/u;

function exactBytes(prefix: string, byteLength: number, fill = "x"): string {
    if (byteLength <= 0) return "";
    const clipped = Buffer.from(prefix).subarray(0, byteLength).toString();
    return `${clipped}${fill.repeat(Math.max(0, byteLength - Buffer.byteLength(clipped)))}`;
}

function materializeBlock(block: ReplayBlockShape, label: string): Record<string, unknown> {
    if (block.type === "text") {
        const text = block.empty
            ? ""
            : block.dropped_tag !== undefined
              ? block.dropped_tag === 0
                  ? "[dropped]"
                  : `[dropped §${block.dropped_tag}§]`
              : exactBytes(`[[${label}:assistant]]`, block.text_bytes ?? 0, "a");
        return { type: "text", text };
    }
    if (block.type === "redacted_thinking") {
        return {
            type: "redacted_thinking",
            data: exactBytes("fixture-redacted", block.thinking_bytes ?? 0, "r"),
        };
    }
    return {
        type: "thinking",
        thinking: exactBytes(`[[${label}:thinking]]`, block.thinking_bytes ?? 0, "t"),
        signature: exactBytes("fixture-signature", block.signature_bytes ?? 0, "s"),
    };
}

function materializeOpenAIItem(
    item: ReplayOpenAIItemShape,
    label: string,
): Record<string, unknown> {
    if (item.type === "message") {
        return {
            type: "message",
            role: "assistant",
            content: [
                {
                    type: "output_text",
                    text: item.empty
                        ? ""
                        : exactBytes(`[[${label}:assistant]]`, item.text_bytes, "a"),
                    annotations: [],
                    logprobs: [],
                },
            ],
        };
    }
    if (item.type === "reasoning") {
        return {
            type: "reasoning",
            summary:
                item.summary_bytes === undefined
                    ? []
                    : [
                          {
                              type: "summary_text",
                              text: exactBytes(
                                  `[[${label}:reasoning]]`,
                                  item.summary_bytes,
                                  "r",
                              ),
                          },
                      ],
            encrypted_content:
                item.encrypted_content_bytes === undefined
                    ? null
                    : exactBytes(
                          "fixture-encrypted-reasoning",
                          item.encrypted_content_bytes,
                          "e",
                      ),
        };
    }
    return {
        type: "function_call",
        call_id: item.call_id,
        name: item.name,
        arguments: JSON.stringify(item.arguments),
    };
}

function responseFor(
    response: ReplayResponseShape,
    label: string,
    family: ReplayWireFamily,
): MockResponse {
    const usage = {
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };
    if (family === "openai_responses") {
        if (!("items" in response)) {
            throw new Error(`OpenAI Responses replay ${label} requires response.items`);
        }
        const openaiOutput = response.items.map((item) => materializeOpenAIItem(item, label));
        return {
            openaiOutput,
            stop_reason: openaiOutput.some((item) => item.type === "function_call")
                ? "tool_use"
                : "end_turn",
            usage,
        };
    }
    if (!("blocks" in response)) {
        throw new Error(`Anthropic replay ${label} requires response.blocks`);
    }
    return {
        content: response.blocks.map((block) => materializeBlock(block, label)),
        usage,
    };
}

function responseSequence(pass: ReplayPassShape): ReplayResponseShape[] {
    return "sequence" in pass.response ? pass.response.sequence : [pass.response];
}

function promptFor(pass: ReplayPassShape): string {
    return exactBytes(`[[replay:${pass.label}]]`, pass.input_text_bytes, "u");
}

function wireRole(entry: WireEntry): string {
    if (typeof entry.role === "string") return entry.role;
    if (entry.type === "function_call") return "assistant";
    if (entry.type === "function_call_output") return "tool";
    if (entry.type === "reasoning") return "assistant";
    return "unknown";
}

function payloadFor(block: WireEntry): string {
    for (const key of ["text", "thinking", "data", "output", "arguments"] as const) {
        if (typeof block[key] === "string") return block[key];
    }
    if (Array.isArray(block.summary)) {
        return block.summary
            .map((item) =>
                item && typeof item === "object" && typeof (item as WireEntry).text === "string"
                    ? String((item as WireEntry).text)
                    : "",
            )
            .join("");
    }
    return "";
}

function blockDescriptor(rawBlock: unknown): string {
    if (!rawBlock || typeof rawBlock !== "object") return typeof rawBlock;
    const block = rawBlock as WireEntry;
    const type = typeof block.type === "string" ? block.type : "unknown";
    const payload = payloadFor(block);
    const signed =
        (typeof block.signature === "string" && block.signature.length > 0) ||
        (typeof block.data === "string" && block.data.length > 0) ||
        (typeof block.encrypted_content === "string" && block.encrypted_content.length > 0);
    const dropped = DROPPED.test(payload.trim()) ? ":isolated_dropped" : "";
    return `${type}:${Buffer.byteLength(payload)}${signed ? ":signed" : ""}${dropped}`;
}

function wireStructure(serialized: string): Array<{ role: string; blocks: string[] }> {
    const parsed = JSON.parse(serialized) as WireEntry[];
    return parsed.map((entry) => {
        const role = wireRole(entry);
        if (typeof entry.content === "string") {
            return { role, blocks: [`string:${Buffer.byteLength(entry.content)}`] };
        }
        if (Array.isArray(entry.content)) {
            return { role, blocks: entry.content.map(blockDescriptor) };
        }
        return { role, blocks: [blockDescriptor(entry)] };
    });
}

function recordTextShape(
    valueSpace: ValueSpace,
    role: string,
    type: string,
    field: string,
    text: string,
): void {
    if (text === "") valueSpace.empty_content_shapes.push(`${role}:${type}.${field}=empty_string`);
    const normalizedText = text.trim().replace(MC_TAG_PREFIX, "").trim();
    if (DROPPED.test(normalizedText)) {
        valueSpace.dropped_placeholder_shapes.push(`${role}:isolated_dropped_placeholder`);
    } else if (text.includes("[dropped")) {
        valueSpace.dropped_placeholder_shapes.push(`${role}:embedded_dropped_placeholder`);
    }
}

function classifyWire(serialized: string): ValueSpace {
    const parsed = JSON.parse(serialized) as WireEntry[];
    const valueSpace: ValueSpace = {
        empty_content_shapes: [],
        dropped_placeholder_shapes: [],
        reasoning_signature_shapes: [],
        tool_pairing_shapes: [],
    };
    const calls = new Set<string>();
    const results = new Set<string>();

    for (const [index, entry] of parsed.entries()) {
        const role = wireRole(entry);
        const entryType = typeof entry.type === "string" ? entry.type : "message";
        if (entry.content === "") {
            valueSpace.empty_content_shapes.push(`${role}:content=empty_string`);
        }
        if (Array.isArray(entry.content) && entry.content.length === 0) {
            valueSpace.empty_content_shapes.push(`${role}:content=empty_array`);
        }
        if (entryType === "function_call" && typeof entry.call_id === "string") {
            calls.add(entry.call_id);
        }
        if (entryType === "function_call_output" && typeof entry.call_id === "string") {
            results.add(entry.call_id);
            if (typeof entry.output === "string") {
                recordTextShape(valueSpace, role, entryType, "output", entry.output);
            }
        }
        if (entryType === "reasoning") {
            const signed =
                typeof entry.encrypted_content === "string" && entry.encrypted_content.length > 0;
            valueSpace.reasoning_signature_shapes.push(
                `reasoning:${index === 0 ? "index_0" : "nonzero_index"}:${signed ? "signed" : "unsigned"}`,
            );
        }
        if (!Array.isArray(entry.content)) continue;
        for (const [blockIndex, rawBlock] of entry.content.entries()) {
            if (!rawBlock || typeof rawBlock !== "object") continue;
            const block = rawBlock as WireEntry;
            const type = typeof block.type === "string" ? block.type : "unknown";
            if (typeof block.text === "string") {
                recordTextShape(valueSpace, role, type, "text", block.text);
            }
            if (typeof block.output === "string") {
                recordTextShape(valueSpace, role, type, "output", block.output);
            }
            if (type === "tool_use" && typeof block.id === "string") calls.add(block.id);
            if (type === "tool_result" && typeof block.tool_use_id === "string") {
                results.add(block.tool_use_id);
            }
            if (role === "assistant" && (type === "thinking" || type === "redacted_thinking")) {
                const signature =
                    (typeof block.signature === "string" && block.signature.length > 0) ||
                    (typeof block.data === "string" && block.data.length > 0);
                valueSpace.reasoning_signature_shapes.push(
                    `${type}:${blockIndex === 0 ? "index_0" : "nonzero_index"}:${signature ? "signed" : "unsigned"}`,
                );
            }
        }
    }

    for (const callID of calls) {
        valueSpace.tool_pairing_shapes.push(
            results.has(callID) ? "tool_call:paired" : "tool_call:missing_result",
        );
    }
    for (const resultID of results) {
        if (!calls.has(resultID)) valueSpace.tool_pairing_shapes.push("tool_result:orphaned");
    }
    return {
        empty_content_shapes: [...new Set(valueSpace.empty_content_shapes)].sort(),
        dropped_placeholder_shapes: [...new Set(valueSpace.dropped_placeholder_shapes)].sort(),
        reasoning_signature_shapes: [...new Set(valueSpace.reasoning_signature_shapes)].sort(),
        tool_pairing_shapes: [...new Set(valueSpace.tool_pairing_shapes)].sort(),
    };
}

function axis(
    ts: string[],
    rust: string[],
    adjudication?: ReplayAdjudication,
): ValueSpaceAxis {
    const tsSet = new Set(ts);
    const rustSet = new Set(rust);
    const tsOnly = ts.filter((value) => !rustSet.has(value));
    const rustOnly = rust.filter((value) => !tsSet.has(value));
    const matchesAdjudication =
        adjudication !== undefined &&
        JSON.stringify(tsOnly) === JSON.stringify(adjudication.ts_only) &&
        JSON.stringify(rustOnly) === JSON.stringify(adjudication.rust_only);
    return {
        classification:
            tsOnly.length === 0 && rustOnly.length === 0
                ? "matched_value_space"
                : "divergent_value_space",
        ts_only: tsOnly,
        rust_only: rustOnly,
        shared: ts.filter((value) => rustSet.has(value)),
        ...(matchesAdjudication
            ? {
                  adjudication: {
                      decision: adjudication.decision,
                      reason: adjudication.reason,
                      source: adjudication.source,
                  },
              }
            : {}),
    };
}

function firstDiffByte(left: string, right: string): number | null {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    const limit = Math.min(a.length, b.length);
    for (let index = 0; index < limit; index += 1) {
        if (a[index] !== b[index]) return index;
    }
    return a.length === b.length ? null : limit;
}

function providerArm(fixture: ReplayFixture, armID?: string): ReplayProviderArm {
    const selected = armID
        ? fixture.provider_arms.find((arm) => arm.id === armID)
        : fixture.provider_arms[0];
    if (!selected) {
        throw new Error(
            `paired replay provider arm not found: ${armID ?? "<default>"}; available=${fixture.provider_arms.map((arm) => arm.id).join(",")}`,
        );
    }
    return selected;
}

export function comparePairedReplayPasses(
    fixture: ReplayFixture,
    tsWires: string[],
    rustWires: string[],
    providerArmID?: string,
): ReplayDivergenceRow[] {
    const arm = providerArm(fixture, providerArmID);
    if (tsWires.length !== arm.passes.length || rustWires.length !== arm.passes.length) {
        throw new Error(
            `replay capture count mismatch: fixture=${arm.passes.length} ts=${tsWires.length} rust=${rustWires.length}`,
        );
    }
    return arm.passes.map((pass, index) => {
        const tsWire = tsWires[index]!;
        const rustWire = rustWires[index]!;
        const tsValueSpace = classifyWire(tsWire);
        const rustValueSpace = classifyWire(rustWire);
        const adjudication = (axisName: ReplayAdjudication["axis"]) =>
            arm.adjudications?.find(
                (entry) => entry.pass === pass.label && entry.axis === axisName,
            );
        return {
            pass: pass.label,
            wire_bytes: {
                ts: Buffer.byteLength(tsWire),
                rust: Buffer.byteLength(rustWire),
                equal: tsWire === rustWire,
                first_diff_byte: firstDiffByte(tsWire, rustWire),
            },
            wire_structure: {
                ts: wireStructure(tsWire),
                rust: wireStructure(rustWire),
            },
            empty_content_shapes: axis(
                tsValueSpace.empty_content_shapes,
                rustValueSpace.empty_content_shapes,
                adjudication("empty_content_shapes"),
            ),
            dropped_placeholder_shapes: axis(
                tsValueSpace.dropped_placeholder_shapes,
                rustValueSpace.dropped_placeholder_shapes,
                adjudication("dropped_placeholder_shapes"),
            ),
            reasoning_signature_shapes: axis(
                tsValueSpace.reasoning_signature_shapes,
                rustValueSpace.reasoning_signature_shapes,
                adjudication("reasoning_signature_shapes"),
            ),
            tool_pairing_shapes: axis(
                tsValueSpace.tool_pairing_shapes,
                rustValueSpace.tool_pairing_shapes,
                adjudication("tool_pairing_shapes"),
            ),
        };
    });
}

function loadFixture(path: string): ReplayFixture {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ReplayFixture;
    if (
        parsed.schema !== 2 ||
        !Array.isArray(parsed.provider_arms) ||
        parsed.provider_arms.length === 0 ||
        parsed.provider_arms.some((arm) => !Array.isArray(arm.passes) || arm.passes.length === 0)
    ) {
        throw new Error(`invalid paired replay fixture: ${path}`);
    }
    return parsed;
}

async function driveLane(
    harness: RustTestHarness,
    arm: ReplayProviderArm,
): Promise<{ sessionId: string; wires: string[] }> {
    const sessionId = await harness.createSession();
    const wires: string[] = [];
    if (arm.setup) {
        const setupContent: Record<string, unknown>[] = [];
        if (arm.setup.reasoning) {
            setupContent.push(
                materializeBlock(
                    {
                        type: "thinking",
                        thinking_bytes: arm.setup.reasoning.thinking_bytes,
                        signature_bytes: arm.setup.reasoning.signature_bytes,
                    },
                    arm.setup.label,
                ),
            );
        }
        setupContent.push({
            type: "tool_use",
            id: arm.setup.tool_call.call_id,
            name: arm.setup.tool_call.name,
            input: arm.setup.tool_call.arguments,
        });
        const finalSetupResponse: MockResponse = {
            text: exactBytes(`[[${arm.setup.label}:complete]]`, 40, "s"),
            usage: { input_tokens: 1100, output_tokens: 20 },
        };
        let emitted = false;
        harness.mock.addMatcher((body) => {
            if (emitted || body.model !== "mock-sonnet" || !Array.isArray(body.tools)) {
                return null;
            }
            const requestedTool = body.tools.find(
                (tool) =>
                    tool &&
                    typeof tool === "object" &&
                    (tool as WireEntry).name === arm.setup?.tool_call.name,
            );
            if (!requestedTool) return null;
            emitted = true;
            return {
                content: setupContent,
                stop_reason: "tool_use",
                usage: { input_tokens: 1000, output_tokens: 80 },
            };
        });
        harness.mock.setDefault(finalSetupResponse);
        await harness.sendPrompt(
            sessionId,
            exactBytes(`[[replay:${arm.setup.label}]]`, arm.setup.input_text_bytes, "u"),
            { providerID: "mock-anthropic-setup", modelID: "mock-sonnet" },
        );
        if (!emitted) {
            throw new Error(
                `paired replay setup tool was not advertised: ${arm.setup.tool_call.name}`,
            );
        }
        if (arm.setup.replace_tool_output_with_dropped_sentinel) {
            harness.seedLatestToolOutputForReplay(sessionId, "[dropped]");
        }
    }
    for (const pass of arm.passes) {
        const responses = responseSequence(pass).map((response) =>
            responseFor(response, pass.label, arm.wire_family),
        );
        harness.mock.script(responses);
        harness.mock.setDefault(responses.at(-1)!);
        await harness.sendPrompt(sessionId, promptFor(pass));
        wires.push(
            harness.lastMainWireSerialized(
                arm.wire_family === "openai_responses" ? "input" : "messages",
            ),
        );
    }
    return { sessionId, wires };
}

type TrailingBlankLaneCapture = Record<
    TrailingBlankReplayStage,
    { wire: string; decision: string | null; sourceParts: string[] }
>;

function stripProviderCacheControls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripProviderCacheControls);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key !== "cache_control")
            .map(([key, nested]) => [key, stripProviderCacheControls(nested)]),
    );
}

function trailingBlankTargetMessage(requestBody: unknown): unknown {
    if (!requestBody || typeof requestBody !== "object") {
        throw new Error("trailing-blank replay emitted an invalid request body");
    }
    const messages = (requestBody as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) {
        throw new Error("trailing-blank replay expected an Anthropic messages request");
    }
    const target = messages.find((message) => {
        if (!message || typeof message !== "object") return false;
        const candidate = message as { role?: unknown; content?: unknown };
        return (
            candidate.role === "assistant" &&
            Array.isArray(candidate.content) &&
            candidate.content.some(
                (block) =>
                    block !== null &&
                    typeof block === "object" &&
                    (block as { id?: unknown }).id === "call_trailing_blank_replay",
            )
        );
    });
    if (!target) throw new Error("trailing-blank replay target was absent from provider wire");
    return target;
}

async function driveTrailingBlankLane(
    harness: RustTestHarness,
): Promise<TrailingBlankLaneCapture> {
    const sessionId = await harness.createSession();
    let emitted = false;
    harness.mock.addMatcher((body) => {
        if (emitted || body.model !== "mock-sonnet" || !Array.isArray(body.tools)) return null;
        const hasBash = body.tools.some(
            (tool) =>
                tool !== null &&
                typeof tool === "object" &&
                (tool as WireEntry).name === "bash",
        );
        if (!hasBash) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "thinking",
                    thinking: "signed thinking from the replay evidence turn",
                    signature: "sig-trailing-blank-replay",
                },
                {
                    type: "tool_use",
                    id: "call_trailing_blank_replay",
                    name: "bash",
                    input: { command: "printf trailing-blank-replay" },
                },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 31_000, output_tokens: 64 },
        };
    });
    harness.mock.setDefault({
        error: {
            status: 500,
            type: "api_error",
            message: "stop after the replay tool step",
        },
    });
    try {
        await harness.sendPrompt(sessionId, "Create the trailing-blank replay evidence turn.");
    } catch {
        // The fixture intentionally terminates the provider after the completed tool step.
    }
    if (!emitted) throw new Error("trailing-blank replay setup tool was not advertised");
    harness.mock.setDefault({
        text: "trailing blank replay continuation",
        usage: { input_tokens: 31_200, output_tokens: 24 },
    });
    const targetMessageId = harness.prepareTrailingBlankReplay(sessionId);
    const readDecision = (): string | null => {
        // TTL policy shares the trailing_blank_decisions column and can wrap its decisions
        // in a versioned replay document before this assistant's first replay pass.
        return (
            readReplayDocument(harness.contextDb() as unknown as Database, sessionId).trailingBlank[targetMessageId] ?? null
        );
    };
    const sourceParts = async (): Promise<string[]> =>
        (await harness.listMessages(sessionId))
            .find((message) => message.info?.id === targetMessageId)
            ?.parts?.map((part) => part.type ?? "unknown") ?? [];
    const captures = {} as TrailingBlankLaneCapture;
    const streamingRequest = [...harness.mainRequests()].reverse().find((request) => {
        try {
            trailingBlankTargetMessage(request.body);
            return true;
        } catch {
            return false;
        }
    });
    if (!streamingRequest) throw new Error("trailing-blank streaming request was not captured");
    captures.streaming = {
        wire: JSON.stringify(
            stripProviderCacheControls(trailingBlankTargetMessage(streamingRequest.body)),
        ),
        decision: readDecision(),
        sourceParts: await sourceParts(),
    };

    for (const stage of [
        "next_turn_pass_1",
        "next_turn_pass_2",
        "late_blank",
    ] as const) {
        if (stage === "late_blank") harness.appendTrailingBlankReplayPart(targetMessageId);
        const beforeMessages = await harness.listMessages(sessionId);
        const beforeIds = new Set(beforeMessages.map((message) => message.info?.id));
        const stageSourceParts = await sourceParts();
        const requestCount = harness.mainRequests().length;
        await harness.sendPrompt(sessionId, `Replay stage: ${stage}.`);
        const request = harness
            .mainRequests()
            .slice(requestCount)
            .reverse()
            .find((candidate) => {
                try {
                    trailingBlankTargetMessage(candidate.body);
                    return true;
                } catch {
                    return false;
                }
            });
        if (!request) throw new Error(`replay stage ${stage} emitted no target request`);
        captures[stage] = {
            wire: JSON.stringify(stripProviderCacheControls(trailingBlankTargetMessage(request.body))),
            decision: readDecision(),
            sourceParts: stageSourceParts,
        };

        const addedUser = (await harness.listMessages(sessionId)).find(
            (message) =>
                message.info?.role === "user" &&
                typeof message.info.id === "string" &&
                !beforeIds.has(message.info.id),
        )?.info?.id;
        if (!addedUser) throw new Error(`replay stage ${stage} did not persist its user turn`);
        await harness.revertMessage(sessionId, addedUser);
        // OpenCode's revert sets `session.revert` and leaves the rows in place; the rows
        // are deleted lazily by the next prompt, before it creates its own user message.
        // So the durable proof that the revert landed is the marker, not the row's
        // absence. (The absence wait passed for months only because the harness never
        // awaited async predicates; once it did, this could never hold.)
        await harness.waitFor(
            async () => {
                const session = await harness.getSession(sessionId);
                return session?.revert?.messageID === addedUser ? true : null;
            },
            { timeoutMs: 30_000, label: `replay stage ${stage} revert marker recorded` },
        );
    }
    return captures;
}

export async function runPairedTrailingBlankSequenceReplay(): Promise<TrailingBlankSequenceReplayResult> {
    const config = {
        execute_threshold_percentage: 90,
        memory: { auto_search: { enabled: false } },
        compressor: { enabled: false },
    };
    const harness = await RustTestHarness.create({
        startInTsMode: true,
        startHistorianProducer: false,
        providerID: "anthropic",
        providerAPI: "@ai-sdk/anthropic",
        modelID: "mock-sonnet",
        modelContextLimit: 200_000,
        magicContextConfig: config,
    });
    try {
        const ts = await driveTrailingBlankLane(harness);
        harness.mock.reset();
        await harness.restart({ rust: true, magicContextConfig: config });
        const rust = await driveTrailingBlankLane(harness);
        const stageNames: TrailingBlankReplayStage[] = [
            "streaming",
            "next_turn_pass_1",
            "next_turn_pass_2",
            "late_blank",
        ];
        const stages = {} as TrailingBlankSequenceReplayResult["stages"];
        for (const stage of stageNames) {
            stages[stage] = {
                ts: {
                    bytes: Buffer.byteLength(ts[stage].wire),
                    sha256: createHash("sha256").update(ts[stage].wire).digest("hex"),
                    decision: ts[stage].decision,
                    source_parts: ts[stage].sourceParts,
                    blocks: wireStructure(`[${ts[stage].wire}]`)[0]?.blocks ?? [],
                },
                rust: {
                    bytes: Buffer.byteLength(rust[stage].wire),
                    sha256: createHash("sha256").update(rust[stage].wire).digest("hex"),
                    decision: rust[stage].decision,
                    source_parts: rust[stage].sourceParts,
                    blocks: wireStructure(`[${rust[stage].wire}]`)[0]?.blocks ?? [],
                },
                equal: ts[stage].wire === rust[stage].wire,
            };
        }
        const tsStable = new Set(stageNames.map((stage) => ts[stage].wire)).size === 1;
        const rustStable = new Set(stageNames.map((stage) => rust[stage].wire)).size === 1;
        return {
            fixture: "trailing-blank-incident-geometry",
            stages,
            ts_stable: tsStable,
            rust_stable: rustStable,
            // TypeScript adds a leading text sentinel before signed reasoning while
            // Rust preserves the provider-native ordering. Verify that each lane keeps
            // its initially served assistant bytes stable rather than comparing that
            // already-adjudicated representation difference again.
            parity: tsStable && rustStable,
        };
    } finally {
        await harness.dispose();
    }
}

export async function runPairedSessionReplay(options: {
    fixturePath?: string;
    providerArm?: string;
    providerID?: string;
} = {}): Promise<PairedReplayResult> {
    const fixturePath =
        options.fixturePath ?? resolve(import.meta.dir, "../fixtures/parity-hunt-14-session-shape.json");
    const fixture = loadFixture(fixturePath);
    const arm = providerArm(fixture, options.providerArm);
    const providerID = options.providerID ?? arm.provider_id;
    const harness = await RustTestHarness.create({
        startInTsMode: true,
        startHistorianProducer: false,
        providerID,
        providerAPI: arm.provider_api,
        modelID: arm.model_id,
        modelContextLimit: 200_000,
        magicContextConfig: {
            execute_threshold_percentage: 90,
            memory: { auto_search: { enabled: false } },
            compressor: { enabled: false },
        },
    });
    try {
        const ts = await driveLane(harness, arm);
        harness.mock.reset();
        await harness.restart({
            rust: true,
            magicContextConfig: {
                execute_threshold_percentage: 90,
                memory: { auto_search: { enabled: false } },
                compressor: { enabled: false },
            },
        });
        const rust = await driveLane(harness, arm);
        const passes = comparePairedReplayPasses(fixture, ts.wires, rust.wires, arm.id);
        const divergentAxes = passes
            .flatMap((pass) => [
                pass.empty_content_shapes,
                pass.dropped_placeholder_shapes,
                pass.reasoning_signature_shapes,
                pass.tool_pairing_shapes,
            ])
            .filter((entry) => entry.classification === "divergent_value_space");
        return {
            fixture: fixture.source,
            provider_arm: arm.id,
            provider_id: providerID,
            wire_family: arm.wire_family,
            sessions: {
                ts: createHash("sha256").update(ts.sessionId).digest("hex").slice(0, 12),
                rust: createHash("sha256").update(rust.sessionId).digest("hex").slice(0, 12),
            },
            passes,
            divergence_count: divergentAxes.length,
            unadjudicated_divergence_count: divergentAxes.filter(
                (entry) => entry.adjudication === undefined,
            ).length,
        };
    } finally {
        await harness.dispose();
    }
}
