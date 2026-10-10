import { join } from "node:path";
import plugin from "../../../plugin/src/index";
import { tool } from "../../../plugin/node_modules/@opencode-ai/plugin/dist/index.js";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { acquireCompartmentLease, releaseCompartmentLease } from "../../../plugin/src/features/magic-context/compartment-lease";
import { resolveWrapupProtectedTailBoundary } from "../../../plugin/src/hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "../../../plugin/src/hooks/magic-context/read-session-chunk";
import { runCompartmentAgent } from "../../../plugin/src/hooks/magic-context/compartment-runner-incremental";

export default {
    ...plugin,
    async server(context: any) {
        const state = process.env.XDG_STATE_HOME ?? process.env.XDG_DATA_HOME;
        if (!state) throw new Error("marker observer requires an isolated XDG directory");
        process.env.MAGIC_CONTEXT_LOG_PATH = join(state, "marker.log");
        const hooks = await plugin.server(context);
        const sources = new Map<string, any[]>();
        return {
            ...hooks,
            "experimental.chat.messages.transform": async (input: any, output: any) => {
                const sessionID = output.messages.find((message: any) => message.info?.sessionID)?.info.sessionID;
                if (sessionID) {
                    const response = await context.client.session.messages({ path: { id: sessionID }, query: { directory: context.directory } });
                    const rows = (response.data ?? response).filter((message: any) => message.info.summary !== true)
                        .map((message: any, index: number) => ({ id: message.info.id, ordinal: index + 1, role: message.info.role, createdAt: message.info.time?.created, parts: message.parts }));
                    if (!sources.has(sessionID)) setRawMessageProvider(sessionID, { readMessages: () => sources.get(sessionID) ?? [] });
                    sources.set(sessionID, rows);
                }
                await hooks["experimental.chat.messages.transform"]?.(input, output);
            },
            tool: {
                ...hooks.tool,
                s3_direct_historian: tool({
                    description: "Run the real historian using either publication mode for the v1 control.", args: { deferred: tool.schema.boolean() },
                    async execute(args: { deferred: boolean }, execution: any) {
                        const db = openDatabase()!;
                        const sessionId = execution.sessionID;
                        const holder = "s3-direct-control";
                        // Background publication can finish a chunk before releasing the
                        // session lease. The positive control must wait for that owner,
                        // rather than turn a busy tool result into a missing marker call.
                        const deadline = Date.now() + 15000;
                        while (!acquireCompartmentLease(db, sessionId, holder)) {
                            if (Date.now() >= deadline) throw new Error("control lease unavailable after waiting for background historian");
                            await Bun.sleep(25);
                        }
                        try {
                            const boundary = resolveWrapupProtectedTailBoundary({ db, sessionId, mode: "manual-wrapup", contextLimit: 16000, executeThresholdPercentage: 65, usage: { percentage: 0, inputTokens: 100 }, usageSource: "live", messagesToKeep: 1 });
                            await runCompartmentAgent({ client: context.client, db, sessionId, directory: context.directory, model: "mock-anthropic/mock-sonnet", historianChunkTokens: 20000, historianTimeoutMs: 15000, boundarySnapshot: boundary.snapshot, compartmentLeaseHolderId: holder, forceKeepLastCompartment: true, forceDrainQuota: true, memoryEnabled: false, preserveInjectionCacheUntilConsumed: args.deferred });
                            return "Control historian published";
                        } finally { releaseCompartmentLease(db, sessionId, holder); }
                    },
                }),
            },
        };
    },
};
