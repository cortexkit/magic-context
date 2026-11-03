/**
 * Independent review of memory slice S6 (historian turn two), commit dafaede1:
 * the OpenCode 2 carrier. Report: .cortexkit/internal-docs/investigations/reports/memory-s6-review.md.
 *
 * Part of the normal suite. Both tests drive the production OpenCode 2
 * hidden-completion executor and hidden-child context hook over a fake host whose
 * drafts carry the child's whole history, as the real host's do. They failed at
 * dafaede1 (findings P1-1 and P1-2).
 */
import { describe, expect, test } from "bun:test";
import {
    CHECK_SYSTEM_PROMPTS,
    type CheckRequest,
} from "../../features/magic-context/memory/lifecycle-gates";
import { lifecycleTextHash } from "../../features/magic-context/memory/lifecycle-text";
import {
    closeTurnTwoChild,
    registerTurnTwoChild,
} from "../../features/magic-context/memory/turn-two-children";
import identityVectors from "../../features/magic-context/memory/turn-two-identity-vectors.json";
import { lifecycleToolHash } from "../../features/magic-context/memory/turn-two-profile";
import { Database } from "../../shared/sqlite";
import type { HiddenChildRows } from "../../v2/hidden-child-record";
import { createV2HiddenCompletionExecutor, type HiddenChildHost } from "../../v2/hidden-completion";
import { HIDDEN_HISTORIAN_AGENT, HiddenChildHook } from "../../v2/hooks/hidden-child";
import type { SessionContext } from "../../v2/hooks/types";
import type { StoreRow } from "../../v2/store-reader";
import type { HiddenRunHandle, RetainedHistorianChild } from "./compartment-runner-types";
import {
    createOpenCodeTurnTwoCarrier,
    createOpenCodeTurnTwoRecovery,
} from "./historian-turn-two-carrier";

const FORMAT =
    "Return exactly one JSON object with result.step and result.xml or result.decisions.\n";
const TURN_ONE_PROMPT = `${FORMAT}TURN-ONE-PROMPT: summarize messages 1-40`;
const TURN_ONE_REPLY =
    ' \n{ "result": { "xml": "<compartments>TURN-ONE-REPLY</compartments>", "step": "turn_one" } }\n';
const SYSTEM = `historian system prompt\n${FORMAT}`;

async function oc2(
    toolCallOnTurnTwo = false,
    tools: SessionContext["tools"] = {},
    providerID = "mock",
    observeTools = true,
) {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hook = new HiddenChildHook();
    if (!observeTools) {
        const register = hook.registerAttempt.bind(hook);
        hook.registerAttempt = (marker, attempt) => {
            // Simulate a transport without the optional observation slot, not a different request.
            Object.defineProperty(attempt, "observedToolSurface", {
                get: () => undefined,
                set: () => {},
            });
            register(marker, attempt);
        };
    }
    let seq = 0;
    const assistants = new Map<string, StoreRow<"assistant">[]>();
    const rows: HiddenChildRows = {
        latestSequence: (id) => assistants.get(id)?.at(-1)?.seq ?? -1,
        latestAssistant: (id) => assistants.get(id)?.at(-1),
        latestIdle: () => undefined,
    };
    // Every child keeps its conversation, and each draft the host builds carries it.
    const history = new Map<string, SessionContext["messages"]>();
    const shaped: SessionContext[] = [];
    let next = 0;
    const host = {
        async create() {
            return { id: `oc2-child-${++next}` };
        },
        async get() {
            return { model: { providerID: "mock", id: "cheap" } };
        },
        async switchModel() {},
        async prompt(input: { sessionID: string; text: string }) {
            const prior = history.get(input.sessionID) ?? [];
            const draft: SessionContext = {
                sessionID: input.sessionID,
                model: { providerID, id: "cheap" },
                agent: HIDDEN_HISTORIAN_AGENT,
                system: [{ type: "text", text: "host system" }],
                tools: { ...tools },
                options: {},
                messages: [
                    ...prior,
                    { role: "user", content: [{ type: "text", text: input.text }] },
                ],
            };
            hook.apply(draft);
            shaped.push(structuredClone(draft));
            const sent = JSON.stringify(draft.messages);
            const text = sent.includes("Operands:")
                ? JSON.stringify({ verdicts: [] })
                : sent.includes("Turn two")
                  ? JSON.stringify({ decisions: [] })
                  : TURN_ONE_REPLY;
            history.set(input.sessionID, [
                ...prior,
                { role: "user", content: [{ type: "text", text: input.text }] },
                { role: "assistant", content: [{ type: "text", text }] },
            ]);
            const row = {
                id: `m-${++seq}`,
                session_id: input.sessionID,
                type: "assistant",
                seq,
                data: {
                    content: [
                        ...(toolCallOnTurnTwo && sent.includes("Turn two")
                            ? [{ type: "tool-call", id: "blocked", name: "read", input: {} }]
                            : []),
                        { type: "text", text },
                    ],
                    finish: "stop",
                    model: { providerID: "mock", id: "cheap" },
                    tokens: { input: 1, output: 1 },
                    time: { created: Date.now(), completed: Date.now() },
                },
            } as unknown as StoreRow<"assistant">;
            assistants.set(input.sessionID, [...(assistants.get(input.sessionID) ?? []), row]);
        },
        async wait() {},
        async interrupt() {
            return { interrupted: true };
        },
        async update() {},
        async removeSession() {},
    } as unknown as HiddenChildHost;
    const executor = await createV2HiddenCompletionExecutor(host, {
        db,
        projectIdentity: "/review",
        directory: "/review",
        hook,
        openReader: () => rows,
    });
    // Turn one on a historian child, kept open as the runner does on an enabled lane.
    const handle: HiddenRunHandle = await executor.open({
        parentSessionId: "ses-parent",
        agent: HIDDEN_HISTORIAN_AGENT,
        kind: "historian",
        system: SYSTEM,
        model: "mock/cheap",
        timeoutMs: 2000,
        title: "historian",
        directory: "/review",
    });
    await executor.attempt(handle, {
        path: { id: handle.id },
        body: {
            agent: HIDDEN_HISTORIAN_AGENT,
            system: SYSTEM,
            model: { providerID: "mock", modelID: "cheap" },
            parts: [{ type: "text", text: TURN_ONE_PROMPT, synthetic: true }],
        },
    } as never);
    const turnOne = await executor.collect(handle, 50);
    expect(turnOne.text).toBe(TURN_ONE_REPLY);
    const settle = { promptSettled: true, privacySensitive: false, context: "review", log() {} };
    const child: RetainedHistorianChild = {
        executor,
        handle,
        agent: HIDDEN_HISTORIAN_AGENT,
        system: SYSTEM,
        model: "mock/cheap",
        directory: "/review",
        turnOneText: TURN_ONE_REPLY,
        close: () => executor.close(handle, settle),
    };
    const carrier = createOpenCodeTurnTwoCarrier({
        child,
        parentSessionId: "ses-parent",
        harness: "opencode2",
        carrier: "hidden-completion",
        turnOneText: TURN_ONE_REPLY,
        timeoutMs: 2000,
        formatInstructions: FORMAT,
    });
    return { db, child, carrier, shaped, hook };
}

// Message framing is separate from the stable header, so appending history adds bytes only.
function providerBytes(draft: SessionContext): string {
    return `${JSON.stringify({ system: draft.system, tools: draft.tools, options: draft.options })}\n${draft.messages.map((message) => `${JSON.stringify(message)}\n`).join("")}`;
}

describe("S6 review witnesses: OpenCode 2 carrier (failed at dafaede1)", () => {
    test("observing tool metadata changes neither hidden-child nor main-session request bytes", async () => {
        const observed = await oc2();
        const legacy = await oc2(false, {}, "mock", false);
        try {
            const observedReply = await observed.carrier.send("Turn two", "metadata-stage");
            const legacyReply = await legacy.carrier.send("Turn two", "metadata-stage");
            expect(observedReply.profile?.toolHash).toBe(lifecycleToolHash([]));
            expect(legacyReply.profile?.toolHash).toBeNull();
            expect(observed.shaped.map(providerBytes)).toEqual(legacy.shaped.map(providerBytes));
            const main: SessionContext = {
                sessionID: "main",
                agent: "build",
                model: { providerID: "mock", id: "cheap" },
                system: [{ type: "text", text: "main system" }],
                tools: {},
                options: {},
                messages: [{ role: "user", content: [{ type: "text", text: "main prompt" }] }],
            };
            const bytes = JSON.stringify(main);
            expect(legacy.hook.apply(main)).toBe(false);
            expect(JSON.stringify(main)).toBe(bytes);
            expect(observed.hook.apply(main)).toBe(false);
            expect(JSON.stringify(main)).toBe(bytes);
        } finally {
            await observed.child.close();
            observed.db.close();
            await legacy.child.close();
            legacy.db.close();
        }
    });
    test("OpenCode 2 provider bytes extend the prefix including format instructions and the raw wrapped reply", async () => {
        const { db, child, carrier, shaped, hook } = await oc2();
        try {
            const first = providerBytes(shaped[0]!);
            const main: SessionContext = {
                sessionID: "main",
                agent: "build",
                model: { providerID: "mock", id: "cheap" },
                system: [{ type: "text", text: "main system" }],
                tools: {},
                options: {},
                messages: [{ role: "user", content: [{ type: "text", text: "main prompt" }] }],
            };
            const mainBefore = JSON.stringify(main);
            expect(hook.apply(main)).toBe(false);
            expect(JSON.stringify(main)).toBe(mainBefore);
            expect(shaped[0]).toMatchObject({
                system: [{ type: "text", text: SYSTEM }],
                tools: {},
                options: {},
                messages: [{ role: "user", content: [{ type: "text", text: TURN_ONE_PROMPT }] }],
            });
            expect(Object.keys(shaped[0]!)).not.toContain("observedToolSurface");
            await carrier.send(`${FORMAT}Turn two: reconcile.`, "prefix-stage");
            const second = shaped[1]!;
            expect(providerBytes(second).startsWith(first)).toBe(true);
            expect(second.system).toEqual(shaped[0]!.system);
            expect(second.tools).toEqual(shaped[0]!.tools);
            expect(second.options).toEqual(shaped[0]!.options);
            expect(second.messages[1]).toEqual({
                role: "assistant",
                content: [{ type: "text", text: TURN_ONE_REPLY }],
            });
            expect(JSON.stringify(second.messages)).toContain(JSON.stringify(FORMAT).slice(1, -1));
            expect(second.messages).toHaveLength(3);
        } finally {
            await child.close();
            db.close();
        }
    });

    test("OpenCode 2 hashes the observed tool surface, not host-only definition text", async () => {
        const profiles: Array<string | null | undefined> = [];
        for (const tools of [
            { read: { description: "host definition A" } },
            { read: { description: "host definition B" } },
            {},
        ]) {
            const { db, child, carrier, shaped } = await oc2(
                false,
                tools as SessionContext["tools"],
                "opencode",
            );
            try {
                const reply = await carrier.send("Turn two", "tools-stage");
                profiles.push(reply.profile?.toolHash);
                expect(reply.profile?.toolHash).toBe(
                    lifecycleToolHash(Object.keys(shaped[1]!.tools)),
                );
                const check = await carrier.check({
                    key: "tool-check",
                    kind: "support",
                    system: "check system",
                    systemHash: lifecycleTextHash("check system"),
                    operands: [],
                    pairs: [],
                    input: "evidence",
                });
                expect(check.profile.toolHash).toBe(reply.profile?.toolHash);
            } finally {
                await child.close();
                db.close();
            }
        }
        const read = identityVectors.toolHashes.find((vector) => vector.lane === "opencode-2")!;
        expect(profiles[0]).toBe(read.sha256);
        expect(profiles[1]).toBe(profiles[0]);
        expect(profiles[2]).toBe(lifecycleToolHash([]));
        expect(profiles[2]).not.toBe(profiles[0]);
    });
    test("OpenCode 2 marks a blocked call beside valid text and retains no contaminated exchange", async () => {
        const { db, child, carrier, shaped } = await oc2(true);
        try {
            expect(await carrier.send("Turn two attack", "stage")).toMatchObject({
                toolActivity: true,
            });
            await carrier.send("Turn two retry", "next-stage");
            expect(JSON.stringify(shaped[2]!.messages)).not.toContain("Turn two attack");
            expect(JSON.stringify(shaped[2]!.messages)).not.toContain("tool-call");
        } finally {
            await child.close();
            db.close();
        }
    });
    test("review witness: on OpenCode 2 a narrow check can start while turn one's child is retained", async () => {
        const { db, child, carrier } = await oc2();
        const system = CHECK_SYSTEM_PROMPTS["kept-clause"];
        const request: CheckRequest = {
            key: "review-check",
            system,
            systemHash: lifecycleTextHash(system),
            kind: "kept-clause",
            operands: [{ id: "[1,1,1]", text: "Keep rule." }],
            pairs: [],
            input: "[42] user: New rule.",
        };
        const pending = carrier.check(request).then(
            () => "settled",
            () => "settled",
        );
        const outcome = await Promise.race([
            pending,
            new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 1500)),
        ]);
        // Release the retained child so the queued check can finish and the test exits.
        await child.close();
        await pending;
        db.close();
        // At dafaede1 the check child's open() waits for the executor's "historian"
        // role, which turn one's retained child holds until turn two returns: the
        // first check of an edit never starts.
        expect(outcome).toBe("settled");
    }, 10_000);

    test("review witness: on OpenCode 2 the turn-two request carries turn one's prompt and reply", async () => {
        const { db, child, carrier, shaped } = await oc2();
        try {
            const reply = await carrier.send("Turn two: reconcile each candidate fact.", "stage");
            expect(reply.text).toBe(JSON.stringify({ decisions: [] }));
            const sent = JSON.stringify(shaped.at(-1)?.messages ?? []);
            expect(sent).toContain("Turn two: reconcile");
            // The spec appends turn two to the same conversation, after turn one's
            // prompt and reply. At dafaede1 the hidden-child hook replaces the
            // child's history with the new prompt alone.
            expect(sent).toContain(JSON.stringify(TURN_ONE_PROMPT).slice(1, -1));
            expect(sent).toContain("TURN-ONE-REPLY");
        } finally {
            await child.close();
            db.close();
        }
    }, 10_000);

    test("OpenCode 2 reconstructed requests have stable tools and no provider enforcement", async () => {
        const { db, child, carrier, shaped } = await oc2();
        registerTurnTwoChild({
            childSessionId: carrier.childSessionId!,
            parentSessionId: "ses-parent",
            harness: "opencode2",
            handle: child.handle,
            active: false,
            close: child.close,
        });
        try {
            await carrier.send("Turn two: reconcile facts", "stage");
            expect(shaped).toHaveLength(2);
            const serialized = shaped.map((request) => JSON.stringify(request));
            for (const bytes of serialized) {
                for (const key of [
                    "response_schema",
                    "responseSchema",
                    "response_format",
                    "tool_choice",
                    "toolChoice",
                    "StructuredOutput",
                    "capture",
                ])
                    expect(bytes).not.toContain(key);
            }
            expect(JSON.stringify(shaped[1]!.tools)).toBe(JSON.stringify(shaped[0]!.tools));
            const resolve = createOpenCodeTurnTwoRecovery({
                executor: child.executor,
                carrier: "hidden-completion",
                harness: "opencode2",
                directory: "/review",
                timeoutMs: 2000,
                now: () => 10_000,
            });
            const recovered = resolve({
                stageKey: "stage",
                projectPath: "/review",
                publicationId: "pub",
                runAttempt: 1,
                sessionId: "ses-parent",
                harness: "opencode2",
                carrier: "hidden-completion",
                childSessionId: child.handle.id,
                startedAt: 0,
                baseline: lifecycleTextHash(TURN_ONE_REPLY),
                historianSystemHash: lifecycleTextHash(SYSTEM),
                variant: null,
            });
            if (!recovered || recovered === "busy") throw new Error("expected recovery");
            expect((await recovered.reattach()).kind).toBe("reply");
            expect(shaped.map((request) => JSON.stringify(request))).toEqual(serialized);
        } finally {
            await closeTurnTwoChild(carrier.childSessionId!);
            db.close();
        }
    }, 10_000);
});
