import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { writeJsonAtomically } from "../../src/write-json-atomically";
import { join } from "node:path";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { getDataDir } from "../../../plugin/src/shared/data-path";
import { createV2HiddenCompletionExecutor } from "../../../plugin/src/v2/hidden-completion";
import {
    HiddenChildHook,
    registerHiddenChildAgents,
} from "../../../plugin/src/v2/hooks/hidden-child";
import { nativeSessionRemove } from "../../../plugin/src/v2/hidden-child-native";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";

interface Command {
    seq: number;
    parentSessionID: string;
}

/**
 * Drives the shipped OpenCode 2 hidden executor and child hook inside a real host, one historian
 * run per command file, and records every context-hook call so the test can see a late drain of a
 * hidden child after its run ended.
 */
export default {
    id: "mc-hidden-child-two-directories-proof",
    async setup(context: any) {
        const dir = context.location.directory;
        const commandPath = join(dir, "hidden-child-command.json");
        const callsPath = join(dir, "context-calls.jsonl");
        const db = openDatabase();
        if (!db) throw new Error("Hidden-child proof database did not open");
        const hook = new HiddenChildHook();
        await registerHiddenChildAgents(context.agent);
        await context.session.hook("context", async (draft: any) => {
            const record: Record<string, unknown> = {
                at: Date.now(),
                sessionID: draft.sessionID,
                owned: hook.owns(draft.sessionID),
            };
            try {
                // The same call the shipped context hook makes first on every pass.
                const handled = hook.apply(draft);
                record.outcome = handled ? "handled" : "not-hidden";
            } catch (error) {
                record.outcome = "threw";
                record.error = error instanceof Error ? error.message : String(error);
                record.code = (error as { code?: unknown }).code;
                throw error;
            } finally {
                appendFileSync(callsPath, `${JSON.stringify(record)}\n`);
            }
        });
        let agentsReady: Promise<void> | undefined;
        const executor = await createV2HiddenCompletionExecutor(
            { ...context.session, removeSession: nativeSessionRemove(context.session) },
            {
                db,
                projectIdentity: "shared-worktree-project",
                directory: dir,
                hook,
                ensureAgent: () => (agentsReady ??= context.agent.reload()),
                openReader: () =>
                    new V2StoreReader(
                        gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
                    ),
                generation: "terminal-failure-proof",
            },
        );
        writeFileSync(join(dir, "hidden-child-ready"), "ready\n");

        const run = async (command: Command) => {
            let handle: Awaited<ReturnType<typeof executor.open>> | null = null;
            let settled = false;
            const startedAt = Date.now();
            try {
                handle = await executor.open({
                    parentSessionId: command.parentSessionID,
                    agent: "historian",
                    kind: "historian",
                    system: `TERMINAL_HISTORIAN_SYSTEM_${command.seq}`,
                    model: "openai/mock-model-cheap",
                    configuredModels: ["openai/mock-model-cheap"],
                    timeoutMs: 20_000,
                    title: "ignored shared title",
                    directory: dir,
                });
                await executor.attempt(handle, {
                    path: { id: handle.id },
                    body: {
                        model: { providerID: "openai", modelID: "mock-model-cheap" },
                        parts: [
                            {
                                type: "text",
                                text: `TERMINAL_HISTORIAN_CHUNK_${command.seq}`,
                                synthetic: true,
                            },
                        ],
                    },
                });
                const completion = await executor.collect(handle, 50);
                settled = true;
                return { ok: true, childID: handle.id, completion, startedAt };
            } catch (error) {
                return {
                    ok: false,
                    childID: handle?.id ?? null,
                    error: error instanceof Error ? error.message : String(error),
                    startedAt,
                };
            } finally {
                await executor.close(handle, {
                    promptSettled: settled,
                    privacySensitive: false,
                    context: "terminal-failure-proof",
                    log() {},
                });
            }
        };

        void (async () => {
            for (;;) {
                if (!existsSync(commandPath)) {
                    await Bun.sleep(20);
                    continue;
                }
                const command = JSON.parse(readFileSync(commandPath, "utf8")) as Command;
                unlinkSync(commandPath);
                const result = await run(command);
                writeJsonAtomically(
                    join(dir, `hidden-child-result-${command.seq}.json`),
                    { ...result, finishedAt: Date.now() },
                );
            }
        })();
    },
};
