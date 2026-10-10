import { expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { getMemoryById, insertMemory } from "../memory";
import { proposeMemoryMutation } from "../memory/lifecycle-applier";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { getDreamRuns } from "./storage-dream-runs";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";

for (const transport of ["session", "hidden"] as const) {
    for (const outcome of [
        "proposal",
        "authority refusal",
        "tool error",
        "lookalike error",
    ] as const) {
        test(`curate ${transport}: ${outcome === "proposal" ? "completes a durable proposal without claiming an applied edit" : `rejects ${outcome} as an incomplete memory operation`}`, async () => {
            const db = new Database(":memory:");
            initializeDatabase(db);
            runMigrations(db);
            const project = `/repo/curate-proposal-${transport}-${outcome}`;
            const memory = insertMemory(db, {
                projectPath: project,
                category: "ARCHITECTURE",
                content: "The registry owns startup ordering.",
            });
            const before = JSON.stringify(getMemoryById(db, memory.id));
            const content = "The registry owns startup ordering; proposed clarification.";
            const messages = () => {
                const output =
                    outcome === "proposal"
                        ? `${
                              proposeMemoryMutation(db, {
                                  projectPath: project,
                                  sourceSessionId: "curate-child",
                                  key: "curate-proposal",
                                  writer: "curate",
                                  operation: "update",
                                  targetIds: [memory.id],
                                  proposal: { content },
                              }).reason
                          }: update retained as a pending proposal; memory is unchanged.`
                        : outcome === "authority refusal"
                          ? "Error: MODULE_MEMORY_AUTHORITY; the memory writer is owned by the module."
                          : "Error: MEMORY_PENDING_PROPOSAL was not recorded.";
                return [
                    {
                        info: { role: "assistant", finish: "stop" },
                        parts: [
                            {
                                type: "tool",
                                tool: "ctx_memory",
                                callID: "curate-update",
                                state:
                                    outcome === "tool error"
                                        ? {
                                              status: "error",
                                              input: { action: "update" },
                                              error: "authority refused",
                                          }
                                        : {
                                              status: "completed",
                                              input: { action: "update" },
                                              output,
                                          },
                            },
                            { type: "text", text: "Finished reviewing the memory." },
                        ],
                    },
                ];
            };
            const client = {
                session: {
                    list: async () => ({ data: [{ id: "parent", title: "ordinary session" }] }),
                    create: async () => ({ data: { id: "curate-child" } }),
                    prompt: async () => ({}),
                    messages: async () => ({ data: messages() }),
                    delete: async () => ({}),
                },
            };
            const hidden = {
                capabilities: { tools: true, harness: "opencode2" },
                open: async () => ({ id: "curate-run", childSessionId: "curate-child" }),
                attempt: async () => {},
                collect: async () => ({
                    text: "Finished reviewing the memory.",
                    messages: messages(),
                    lengthCapped: false,
                    usage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                    },
                }),
                close: async () => {},
            };
            try {
                const executor = createDreamTaskExecutor({
                    client: client as never,
                    ...(transport === "hidden"
                        ? { hiddenCompletionExecutor: hidden as never }
                        : {}),
                    sessionDirectory: project,
                    openOpenCodeDb: () => null,
                });
                const result = await executor(
                    { task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 20 },
                    {
                        db,
                        projectIdentity: project,
                        holderId: "curate-holder",
                        leaseKey: leaseKeyFor("curate", project),
                    },
                );
                expect(JSON.stringify(getMemoryById(db, memory.id))).toBe(before);
                const proposals = db
                    .prepare("SELECT proposal_json FROM memory_tool_proposals")
                    .all() as { proposal_json: string }[];
                const recorded = JSON.parse(getDreamRuns(db, project)[0]!.tasks_json)[0];
                if (outcome === "proposal") {
                    expect(result.status).toBe("completed");
                    expect(recorded.status).toBe("completed");
                    expect(recorded.progress).toContain("1 memory operation proposed (update)");
                    expect(recorded.progress).not.toContain("applied");
                    expect(proposals).toHaveLength(1);
                    expect(JSON.parse(proposals[0]!.proposal_json)).toEqual({ content });
                } else {
                    expect(result.status).toBe("failed");
                    expect(recorded.status).toBe("failed");
                    expect(recorded.error).toContain("no completed ctx_memory tool result");
                    expect(proposals).toHaveLength(0);
                }
            } finally {
                db.close();
            }
        });
    }
}
