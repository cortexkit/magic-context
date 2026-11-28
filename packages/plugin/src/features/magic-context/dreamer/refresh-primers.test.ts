import { expect, test } from "bun:test";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import type { PluginContext } from "../../../plugin/types";
import { Database } from "../../../shared/sqlite";
import { toolLoopMessages } from "../../../v2/hidden-completion";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { createPrimer, getActivePrimers, insertPrimerCandidates } from "../storage-primers";
import { acquireLeaseWithAcquisition } from "./lease";
import { refreshPrimers } from "./refresh-primers";

const project = "git:primer-evidence";
const oldAnswer = "Use the old cache.";
const newAnswer = "The cache is in src/cache.ts.";
const text = JSON.stringify({ answer: newAnswer });
const image = { type: "image", data: "eA==", mimeType: "image/png" };
type Outcome = "failed" | "pending" | "image-only";

async function checkRefresh(
    carrier:
        | { client: PluginContext["client"] }
        | { hiddenCompletionExecutor: HiddenCompletionExecutor },
    expected: string,
) {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        const now = Date.now();
        const question = "Where is the cache?";
        const sourceCandidateIds = insertPrimerCandidates(db, [
            {
                projectPath: project,
                harness: "opencode",
                sessionId: "origin",
                question,
                sourceCompartmentStart: 1,
                sourceCompartmentEnd: 1,
                sourceStartMessageId: "origin-message",
                sourceEndMessageId: "origin-message",
                sourceMessageTime: now,
            },
        ]);
        createPrimer(db, {
            projectPath: project,
            question,
            answer: oldAnswer,
            totalSupport: 1,
            lastObservedAt: now,
            sourceCandidateIds,
        });
        const leaseAcquisition = acquireLeaseWithAcquisition(db, "holder", "primer-lease");
        if (!leaseAcquisition) throw new Error("Could not acquire primer fixture lease");
        await refreshPrimers({
            ...carrier,
            db,
            projectIdentity: project,
            sessionDirectory: "/fixture",
            parentSessionId: undefined,
            holderId: "holder",
            leaseKey: "primer-lease",
            leaseAcquisition,
            deadline: now + 60_000,
            rawProviderFactory: () => ({
                readMessages: () => [
                    {
                        id: "origin-message",
                        role: "user",
                        ordinal: 1,
                        parts: [{ type: "text", text: question }],
                    },
                ],
            }),
        });
        expect(getActivePrimers(db, project)[0]?.answer).toBe(expected);
    } finally {
        db.close();
    }
}

test.each<Outcome>([
    "failed",
    "pending",
    "image-only",
])("OpenCode 1: refresh after a %s read", async (outcome) => {
    const input = { filePath: "/fixture/cache.png" };
    const state =
        outcome === "image-only"
            ? {
                  status: "completed",
                  input,
                  output: "",
                  attachments: [
                      { type: "file", mime: "image/png", url: "data:image/png;base64,eA==" },
                  ],
              }
            : outcome === "failed"
              ? { status: "error", input, error: "File not found" }
              : { status: "running", input };
    const client = {
        backgroundSessionsAreHidden: true,
        session: {
            create: async () => ({ data: { id: "primer-child" } }),
            prompt: async () => ({ data: {} }),
            messages: async () => ({
                data: [
                    {
                        info: { role: "assistant", finish: "stop" },
                        parts: [
                            { type: "tool", tool: "read", callID: "read-1", state },
                            { type: "text", text },
                        ],
                    },
                ],
            }),
            delete: async () => ({}),
        },
    } as unknown as PluginContext["client"];
    await checkRefresh({ client }, outcome === "image-only" ? newAnswer : oldAnswer);
});

test.each<Outcome>([
    "failed",
    "pending",
    "image-only",
])("OpenCode 2: refresh after a %s read", async (outcome) => {
    const observedMessages = [
        {
            role: "assistant",
            content: [
                {
                    type: "tool-call",
                    id: "read-1",
                    name: "read",
                    input: { filePath: "/fixture/cache.png" },
                },
            ],
        },
        ...(outcome === "pending"
            ? []
            : [
                  {
                      role: "tool",
                      content: [
                          {
                              type: "tool-result",
                              id: "read-1",
                              ...(outcome === "failed"
                                  ? {
                                        resultType: "error",
                                        result: { error: "Permission refused", content: [] },
                                    }
                                  : { result: { type: "content", value: [image] } }),
                          },
                      ],
                  },
              ]),
    ];
    await checkRefresh(
        {
            hiddenCompletionExecutor: {
                capabilities: { tools: true, harness: "opencode" },
                open: async () => ({ id: "primer-child" }),
                attempt: async () => {},
                collect: async () => ({
                    text,
                    lengthCapped: false,
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    messages: toolLoopMessages({ observedMessages } as Parameters<
                        typeof toolLoopMessages
                    >[0]),
                }),
                close: async () => {},
            },
        },
        outcome === "image-only" ? newAnswer : oldAnswer,
    );
});
