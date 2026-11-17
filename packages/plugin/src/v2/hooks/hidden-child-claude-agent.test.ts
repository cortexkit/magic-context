import { describe, expect, it } from "bun:test";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { CLAUDE_AGENT_PROVIDER_ID, claudeAgentInstructionsText } from "./claude-agent-instructions";
import { type HiddenChildAttempt, HiddenChildHook } from "./hidden-child";
import type { SessionContext } from "./types";

/**
 * OpenCode 2.3's Claude Agent provider builds its system prompt before Magic
 * Context's hook shapes a hidden run, so the run's system text never reaches
 * the model there. On that provider the task instructions travel at the start
 * of the run's first user message instead; every other provider keeps the
 * request exactly as before.
 */

const MARKER =
    "mc:hidden:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
const SYSTEM =
    'You classify memories.\n\nOUTPUT CONTRACT: emit <classify><memory id="N" importance="75" scope="project" shareable="true"/></classify>';
const PROMPT = "Classify these memories.";
const FRAME = `Instructions for this task:\n\n<instructions>\n${SYSTEM}\n</instructions>`;

function attempt(identity: Partial<HiddenChildAttempt["identity"]> = {}): HiddenChildAttempt {
    return {
        childSessionId: "ses-child",
        identity: {
            parentSessionId: "ses-parent",
            directory: "/tmp",
            agent: DREAMER_AGENT,
            kind: "dreamer-task",
            system: SYSTEM,
            timeoutMs: 1000,
            ...identity,
        },
        request: { body: { parts: [{ type: "text", text: PROMPT }] } },
        shaped: false,
    };
}

function draft(
    providerID: string,
    messages: SessionContext["messages"],
    agent = DREAMER_AGENT,
): SessionContext {
    return {
        sessionID: "ses-child",
        model: { providerID, id: "haiku" },
        agent,
        messages,
        system: [{ type: "text", text: "OpenCode's own prompt" }],
        tools: {},
        options: { maxTokens: 32000 },
    } as SessionContext;
}

const markerMessage = { role: "user", content: [{ type: "text", text: MARKER }] };
/** What the host holds on a run's second step: its marker, then one tool round trip. */
const toolRoundTrip = [
    {
        role: "assistant",
        content: [{ type: "tool-call", id: "call-1", name: "ctx_memory", input: {} }],
    },
    {
        role: "tool",
        content: [{ type: "tool-result", id: "call-1", result: { type: "text", value: "ok" } }],
    },
] as unknown as SessionContext["messages"];

function firstStep(providerID: string, run = attempt()) {
    const hook = new HiddenChildHook(() => {});
    hook.registerAttempt(MARKER, run);
    const step = draft(
        providerID,
        [markerMessage] as SessionContext["messages"],
        run.identity.kind === "historian" ? "historian" : DREAMER_AGENT,
    );
    expect(hook.apply(step)).toBe(true);
    return { hook, step };
}

describe("hidden runs on the Claude Agent provider", () => {
    it("lead the first user message with the task's system text in the instructions frame", () => {
        const { step } = firstStep(CLAUDE_AGENT_PROVIDER_ID);
        expect(claudeAgentInstructionsText(SYSTEM)).toBe(FRAME);
        expect(step.messages).toEqual([
            {
                role: "user",
                content: [
                    { type: "text", text: FRAME },
                    { type: "text", text: PROMPT },
                ],
            },
        ]);
        // The system part is written as on every other provider.
        expect(step.system).toEqual([{ type: "text", text: SYSTEM }]);
    });

    it("send the identical leading part on the second step of a tool loop", () => {
        const { hook, step } = firstStep(CLAUDE_AGENT_PROVIDER_ID);
        const first = JSON.stringify(step.messages[0]);
        const second = draft(CLAUDE_AGENT_PROVIDER_ID, [
            markerMessage,
            ...toolRoundTrip,
        ] as SessionContext["messages"]);
        expect(hook.apply(second)).toBe(true);
        expect(second.messages).toHaveLength(3);
        expect(JSON.stringify(second.messages[0])).toBe(first);
        expect(second.messages.slice(1)).toEqual(toolRoundTrip);
    });

    it("carry the historian's system text the same way", () => {
        const { step } = firstStep(
            CLAUDE_AGENT_PROVIDER_ID,
            attempt({ agent: "historian", kind: "historian" }),
        );
        expect(step.messages[0]?.content).toEqual([
            { type: "text", text: FRAME },
            { type: "text", text: PROMPT },
        ]);
    });

    it("keep the frame when the host compacted the marker into a checkpoint", () => {
        const hook = new HiddenChildHook(() => {});
        hook.registerAttempt(MARKER, attempt());
        const checkpoint = [
            "<conversation-checkpoint>",
            "The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.",
            "",
            `<summary>\n${MARKER}\n</summary>`,
            "</conversation-checkpoint>",
        ].join("\n");
        const step = draft(CLAUDE_AGENT_PROVIDER_ID, [
            { role: "user", content: [{ type: "text", text: checkpoint }] },
        ] as SessionContext["messages"]);
        expect(hook.apply(step)).toBe(true);
        expect(step.messages[0]?.content).toEqual([
            { type: "text", text: FRAME },
            { type: "text", text: PROMPT },
        ]);
    });
});

describe("hidden runs on every other provider", () => {
    for (const providerID of ["anthropic", "openai", "opencode", "claude-agent-proxy"]) {
        it(`send the registered prompt alone on ${providerID}`, () => {
            const { hook, step } = firstStep(providerID);
            expect(step.messages).toEqual([
                { role: "user", content: [{ type: "text", text: PROMPT }] },
            ]);
            const second = draft(providerID, [
                markerMessage,
                ...toolRoundTrip,
            ] as SessionContext["messages"]);
            hook.apply(second);
            expect(second.messages[0]).toEqual({
                role: "user",
                content: [{ type: "text", text: PROMPT }],
            });
            expect(JSON.stringify(step.messages).includes("<instructions>")).toBe(false);
        });
    }
});
