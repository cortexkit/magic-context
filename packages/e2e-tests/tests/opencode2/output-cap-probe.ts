import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { writeJsonAtomically } from "../../src/write-json-atomically";
import { join } from "node:path";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { getDataDir } from "../../../plugin/src/shared/data-path";
import { nativeSessionRemove } from "../../../plugin/src/v2/hidden-child-native";
import { createV2HiddenCompletionExecutor } from "../../../plugin/src/v2/hidden-completion";
import { HiddenChildHook, registerHiddenChildAgents } from "../../../plugin/src/v2/hooks/hidden-child";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";

interface Command {
    seq: number;
    parentSessionID: string;
    maxOutputTokens?: number;
}

export default {
    id: "mc-hidden-output-cap-proof",
    async setup(context: any) {
        const directory = context.location.directory;
        const commandPath = join(directory, "hidden-child-command.json");
        const db = openDatabase();
        if (!db) throw new Error("Hidden output-cap proof database did not open");
        const hook = new HiddenChildHook();
        await registerHiddenChildAgents(context.agent);
        await context.session.hook("context", (draft: any) => { hook.apply(draft); });
        let agentsReady: Promise<void> | undefined;
        const executor = await createV2HiddenCompletionExecutor(
            { ...context.session, removeSession: nativeSessionRemove(context.session) },
            {
                db, projectIdentity: directory, directory, hook,
                ensureAgent: () => (agentsReady ??= context.agent.reload()),
                openReader: () => new V2StoreReader(gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest")),
            },
        );
        writeFileSync(join(directory, "hidden-child-ready"), "ready\n");
        const run = async (command: Command) => {
            let handle: Awaited<ReturnType<typeof executor.open>> | null = null;
            let settled = false;
            try {
                handle = await executor.open({
                    parentSessionId: command.parentSessionID,
                    agent: "historian", kind: "historian",
                    system: `EXACT_HISTORIAN_SYSTEM_${command.seq}`,
                    model: "openai/mock-model-cheap", configuredModels: ["openai/mock-model-cheap"],
                    timeoutMs: 10000,
                    ...(command.maxOutputTokens === undefined ? {} : { maxOutputTokens: command.maxOutputTokens }),
                    title: "ignored shared title", directory,
                });
                await executor.attempt(handle, { path: { id: handle.id }, body: {
                    model: { providerID: "openai", modelID: "mock-model-cheap" },
                    parts: [{ type: "text", text: `EXACT_HISTORIAN_CHUNK_${command.seq}`, synthetic: true }],
                } });
                const completion = await executor.collect(handle, 50);
                settled = true;
                return { ok: true, childID: handle.id, completion };
            } catch (error) {
                return { ok: false, childID: handle?.id ?? null, error: String(error) };
            } finally {
                await executor.close(handle, { promptSettled: settled, privacySensitive: false, context: "output-cap-proof", log() {} });
            }
        };
        void (async () => {
            for (;;) {
                if (!existsSync(commandPath)) { await Bun.sleep(20); continue; }
                let command: Command;
                try { command = JSON.parse(readFileSync(commandPath, "utf8")); }
                catch { await Bun.sleep(20); continue; }
                unlinkSync(commandPath);
                const result = await run(command);
                writeJsonAtomically(join(directory, `hidden-child-result-${command.seq}.json`), result);
            }
        })();
    },
};
