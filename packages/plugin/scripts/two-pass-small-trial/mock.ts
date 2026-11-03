import { buildCompartmentAgentPrompt } from "../../src/hooks/magic-context/compartment-prompt";
import { hash, type ReplayCase } from "../two-pass-live-replay/artifact-schema";
import type { Request } from "./provider";

export function mockCases(ids: number[]): ReplayCase[] {
    return ids.map((id) => ({
        id,
        source: { recording: `mock/${id}.json`, sha256: "mock", sessionId: `mock-session-${id}` },
        userPrompt: buildCompartmentAgentPrompt({
            seedExamples: "",
            sessionReferences: "",
            projectMemory: "",
            inputSource:
                "Messages 1-2:\n\n[1] U: Always serialize DeepSeek requests.\n[2] A: Understood.",
            memoryEnabled: true,
        }),
        blocks: [
            {
                role: "user",
                startOrdinal: 1,
                endOrdinal: 1,
                parts: ["Always serialize DeepSeek requests."],
            },
            { role: "assistant", startOrdinal: 2, endOrdinal: 2, parts: ["Understood."] },
        ],
        lines: [
            { ordinal: 1, messageId: `mock-message-${id}` },
            { ordinal: 2, messageId: `mock-ack-${id}` },
        ],
        memories: [],
        recordedOutput: "",
        inventory: {
            value: [
                {
                    id: `${id}:1`,
                    family: "safety",
                    text: "Always serialize DeepSeek requests.",
                    anchor: { startOrdinal: 1, endOrdinal: 1 },
                },
            ],
            producer: "mock",
            sha256: hash([]),
            reviewers: [{ kind: "human", name: "synthetic fixture" }],
        },
    }));
}
export function mockReply(body: Request) {
    const second = body.messages.length === 4;
    const content = second
        ? JSON.stringify({
              result: {
                  step: "turn_two",
                  decisions: [
                      {
                          fact_id: 1,
                          action: "new",
                          check: "Stated by the user in message 1.",
                      },
                  ],
                  scores: [],
              },
          })
        : JSON.stringify({
              result: {
                  step: "turn_one",
                  xml: '<compartment start="1" end="2" title="DeepSeek pacing" episode_type="decision" importance="60"><p1>Always serialize DeepSeek requests.</p1><p2>Serialize DeepSeek requests.</p2><p3>Serialize requests.</p3><p4>DeepSeek pacing</p4></compartment>\n<facts><CONSTRAINTS>\n* [at_compartment=1 messages=1] Always serialize DeepSeek requests.\n</CONSTRAINTS></facts>\n<unprocessed_from>3</unprocessed_from>',
              },
          });
    return {
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
        usage: {
            prompt_tokens: second ? 200 : 100,
            prompt_cache_hit_tokens: second ? 150 : 0,
            prompt_cache_miss_tokens: second ? 50 : 100,
            completion_tokens: second ? 30 : 20,
            total_tokens: second ? 230 : 120,
        },
    };
}
export function mockServer(
    input: { statuses?: number[]; retryAfter?: string; body?: string; delayMs?: number } = {},
) {
    const requests: Request[] = [];
    let active = 0,
        maxActive = 0;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
            active++;
            maxActive = Math.max(maxActive, active);
            try {
                if (new URL(req.url).pathname !== "/chat/completions" || req.method !== "POST")
                    return new Response("not found", { status: 404 });
                const body = (await req.json()) as Request;
                requests.push(body);
                if (input.delayMs) await Bun.sleep(input.delayMs);
                const status = input.statuses?.[requests.length - 1] ?? 200;
                return new Response(
                    status === 200
                        ? JSON.stringify(mockReply(body))
                        : (input.body ??
                              JSON.stringify({
                                  error: {
                                      message:
                                          status === 402 ? "Insufficient Balance" : "rate limited",
                                  },
                              })),
                    {
                        status,
                        headers: {
                            "content-type": "application/json",
                            "retry-after": input.retryAfter ?? "0",
                        },
                    },
                );
            } finally {
                active--;
            }
        },
    });
    return {
        url: `http://127.0.0.1:${server.port}/chat/completions`,
        requests,
        get maxActive() {
            return maxActive;
        },
        stop: () => server.stop(true),
    };
}
