import { expect, test } from "bun:test";
import { getThinkingBindingRecoveryTarget } from "../../features/magic-context/storage-meta-persisted";
import { LATEST_THINKING_RESTORE } from "../../hooks/magic-context/latest-thinking-recovery";
import type { SessionContext } from "./types";
import { oc2ContextFixture } from "./__tests__/oc2-context.fixture";

// Claude 5.1 and later models bind every signed thinking block to the `system`
// prompt, the `tools` array and the messages sent before it. Anthropic's edit
// table lists "Add, remove, rename, or edit a tool in `tools`" as invalidating
// those blocks, and Claude Fable 5.2 returns a 400 for an invalid block on
// every account. A request whose tool list changed therefore has to go out
// without the thinking earlier requests served.
//
// These tests drive the real OpenCode 2 context hook. The kept block belongs to
// a completed earlier turn, so no signed-thinking hold is involved: the pass
// after the tool change is an ordinary request of a new turn.

const THINKING = "SIGNED_AGAINST_THE_FIRST_TOOL_LIST";

type Tools = SessionContext["tools"];
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

/**
 * Serve a completed turn's signed thinking across two requests with the same
 * tools, apply `change` to every later request's tools, and serve one more.
 * With `rejection`, the host then reports that request's 400 as a
 * `session.error` and the user sends one more prompt.
 */
async function serveAcrossToolChange(
    seed: number,
    change: (tools: Tools) => void,
    rejection?: { error: unknown },
) {
    const events = eventBus();
    const f = await oc2ContextFixture(seed, {
        area: "fable-5-2-tool-binding",
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
        const afterChange = (draft: SessionContext) => {
            withThinking(draft);
            change(draft.tools);
        };
        f.user("Next task.", 1000);
        const kept = await f.pass(withThinking);
        f.respond();
        f.user("Another task.", 1000);
        const unchanged = await f.pass(withThinking);
        f.respond();
        f.user("A task after the tool list changed.", 1000);
        const changed = await f.pass(afterChange);
        let retried: string | undefined;
        if (rejection) {
            await events.emit({
                type: "session.error",
                data: { sessionID: f.session, error: rejection.error },
            });
            f.user("Please continue.", 1000);
            retried = (await f.pass(afterChange)).bytes;
        }
        return {
            kept: kept.bytes,
            unchanged: unchanged.bytes,
            changed: changed.bytes,
            retried,
        };
    } finally {
        await f.cleanup();
    }
}

test("OpenCode 2, claude-fable-5-2: a tool added mid-session strips the kept signed thinking", async () => {
    const served = await serveAcrossToolChange(52001, (tools) => {
        tools.mcp_search = {
            description: "Search the connected MCP server",
            input: { type: "object", properties: { query: { type: "string" } } },
        };
    });
    expect(served.kept).toContain(THINKING);
    expect(served.unchanged).toContain(THINKING);
    expect(served.changed).not.toContain(THINKING);
}, 60000);

test("OpenCode 2, claude-fable-5-2: a changed tool description strips the kept signed thinking", async () => {
    const served = await serveAcrossToolChange(52002, (tools) => {
        tools.read!.description = "Read a file from the workspace";
    });
    expect(served.kept).toContain(THINKING);
    expect(served.unchanged).toContain(THINKING);
    expect(served.changed).not.toContain(THINKING);
}, 60000);

// Known gap: the OpenCode 2 tool identity hashes names and descriptions only
// (request-tool-definitions.ts), so a request whose only change is a tool's
// input schema keeps the signed thinking, and Claude Fable 5.2 rejects it.
// Remove `.failing` when a schema change strips that thinking.
test.failing("OpenCode 2, claude-fable-5-2: a schema-only tool change strips the kept signed thinking", async () => {
    const served = await serveAcrossToolChange(52003, (tools) => {
        tools.read!.input = {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
        };
    });
    expect(served.kept).toContain(THINKING);
    expect(served.unchanged).toContain(THINKING);
    expect(served.changed).not.toContain(THINKING);
}, 60000);

// Control for the recovery case below: a host `session.error` reaches the
// OpenCode 2 recovery arm, which recognises the latest-turn thinking error.
test("OpenCode 2, claude-fable-5-2: a session.error with the latest-turn thinking error arms its restore", async () => {
    const events = eventBus();
    const f = await oc2ContextFixture(52005, {
        area: "fable-5-2-tool-binding",
        instructions: false,
        temporal: false,
        cacheTtl: "never",
        provider: "anthropic",
        model: "claude-fable-5-2",
        eventStream: events.stream,
    });
    try {
        await f.pass();
        expect(getThinkingBindingRecoveryTarget(f.db, f.session)).toBeNull();
        await events.emit({
            type: "session.error",
            data: {
                sessionID: f.session,
                error: {
                    name: "APIError",
                    data: {
                        message:
                            "messages.3.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
                        statusCode: 400,
                        isRetryable: false,
                    },
                },
            },
        });
        expect(getThinkingBindingRecoveryTarget(f.db, f.session)).toStartWith(
            LATEST_THINKING_RESTORE,
        );
    } finally {
        await f.cleanup();
    }
}, 60000);

// Known gap: OpenCode 2's event loop arms only the latest-turn thinking
// restore (armLatestThinkingRecoveryFromError; the control above shows that
// path receives host errors). The binding 400 ("The block is bound to a
// different conversation") is recognised only by the OpenCode 1 event
// handler, so on OpenCode 2 the next prompt resends the same invalid block.
// Remove `.failing` when that prompt goes out without it.
test.failing("OpenCode 2, claude-fable-5-2: the next prompt after a binding 400 goes out without the rejected thinking", async () => {
    const served = await serveAcrossToolChange(
        52004,
        (tools) => {
            tools.read!.input = {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            };
        },
        {
            error: {
                name: "APIError",
                data: {
                    message:
                        'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header.',
                    statusCode: 400,
                    isRetryable: false,
                },
            },
        },
    );
    expect(served.changed).toContain(THINKING);
    expect(served.retried).toBeDefined();
    expect(served.retried).not.toContain(THINKING);
}, 60000);
