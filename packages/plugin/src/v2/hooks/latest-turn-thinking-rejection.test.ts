import { expect, test } from "bun:test";
import { getThinkingBindingRecoveryTarget } from "../../features/magic-context/storage-meta-persisted";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";
import type { SessionContext } from "./types";

// OpenCode 2 reports a provider failure on its event stream, as a failed step
// and as a session error. A refusal of the latest assistant turn's thinking
// arms the latest-turn recovery from either, and the next prompt goes out with
// that turn's thinking removed, even though a new user message followed the
// turn: the provider checks the last assistant turn regardless.

const THINKING = "SIGNED_BY_TWO_MODELS";
const LATEST_TURN_ERROR = {
    name: "APIError",
    data: {
        message:
            "messages.89.content.10: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
        statusCode: 400,
        isRetryable: false,
    },
};

type HostEvent = { type: string; data: Record<string, unknown> };

/** A host event stream the test feeds; `emit` resolves once the hook took the event. */
function eventBus() {
    const queue: Array<{ event: HostEvent; handled: () => void }> = [];
    let wake: (() => void) | undefined;
    return {
        emit(event: HostEvent) {
            return new Promise<void>((handled) => {
                queue.push({ event, handled });
                wake?.();
            });
        },
        async *stream({ signal }: { signal: AbortSignal }) {
            while (!signal.aborted) {
                const next = queue.shift();
                if (next) {
                    yield next.event;
                    next.handled();
                    continue;
                }
                await new Promise<void>((resolve) => {
                    wake = () => resolve();
                    signal.addEventListener("abort", wake, { once: true });
                });
                if (wake) signal.removeEventListener("abort", wake);
                wake = undefined;
            }
        },
    };
}

for (const source of ["session.step.failed", "session.error"] as const) {
    test(`OpenCode 2: a ${source} refusing the latest turn's thinking removes it from the retry`, async () => {
        const events = eventBus();
        const f = await oc2ContextFixture(source === "session.error" ? 52101 : 52102, {
            area: "latest-turn-thinking-rejection",
            instructions: false,
            temporal: false,
            cacheTtl: "never",
            provider: "anthropic",
            model: "claude-fable-5-2",
            eventStream: events.stream,
        });
        try {
            await f.pass();
            f.respond();
            const signedID = f.rows.at(-1)!.id;
            // The fixture rebuilds each draft from its stored rows, so the signed
            // block is put back on every request, as the host would replay it.
            const withThinking = (draft: SessionContext) => {
                draft.messages
                    .find((message) => message.id === signedID)!
                    .content.unshift({
                        type: "reasoning",
                        text: THINKING,
                        native: { anthropic: { signature: "signed-block" } },
                    });
            };
            f.user("Next task.", 1000);
            const rejected = await f.pass(withThinking);
            expect(rejected.bytes).toContain(THINKING);
            await events.emit({
                type: source,
                data: { sessionID: f.session, error: LATEST_TURN_ERROR },
            });
            expect(getThinkingBindingRecoveryTarget(f.db, f.session) ?? "").toStartWith(
                "latest_thinking_original_turn:",
            );
            // OpenCode 2 hands the failed reply over as an empty row before the retry.
            f.user("Please continue.", 1000);
            const withFailedRow = (draft: SessionContext) => {
                withThinking(draft);
                draft.messages.splice(draft.messages.length - 1, 0, {
                    id: "failed-step",
                    role: "assistant",
                    content: [],
                    finish: "error",
                });
            };
            const retried = await f.pass(withFailedRow);
            expect(retried.bytes).not.toContain(THINKING);
            expect(
                retried.logs.some((line) => line.includes("removed thinking from the bound turn")),
            ).toBe(true);
            // The next pass replays the removal byte for byte.
            expect((await f.pass(withFailedRow)).bytes).toBe(retried.bytes);
        } finally {
            await f.cleanup();
        }
    }, 60000);
}
