import { type ToolDefinition, type ToolResult, tool } from "@opencode-ai/plugin";
import { loadPluginConfigDetailed } from "../../config";
import { isCompactionEnabled } from "../../config/agent-disable";
import { getProtectedTokensTierOverrides } from "../../config/project-security";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    getOrCreateSessionMeta,
    isDatabasePersisted,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { assertExecutableToolInput } from "../../hooks/magic-context/dropped-input-guard";
import {
    createChatMessageHook,
    createToolExecuteAfterHook,
} from "../../hooks/magic-context/hook-handlers";
import { materializeM0 } from "../../hooks/magic-context/inject-compartments";
import {
    createLiveSessionState,
    type LiveSessionState,
} from "../../hooks/magic-context/live-session-state";
import { resolveOpenCodeProtectedTailBoundary } from "../../hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { preloadTokenizer } from "../../hooks/magic-context/read-session-formatting";
import { createTransform, type TransformDeps } from "../../hooks/magic-context/transform";
import { maybeSendUpgradeReminder } from "../../hooks/magic-context/upgrade-reminder";
import { registerRpcHandlers } from "../../plugin/rpc-handlers";
import { createToolRegistry } from "../../plugin/tool-registry";
import type { PluginContext } from "../../plugin/types";
import { detectConflicts } from "../../shared/conflict-detector";
import { getDataDir, getMagicContextStorageDir } from "../../shared/data-path";
import { resolveHistorianModel } from "../../shared/model-resolution";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import {
    ACTIVE_TOOL_IDS,
    createPromptSurfaceRuntime,
    type PromptSurfaceRuntime,
} from "../../shared/prompt-surface-runtime";
import { pushNotification } from "../../shared/rpc-notifications";
import { MagicContextRpcServer } from "../../shared/rpc-server";
import { v2CompactionMarkerStrategy } from "../fold/markers";
import { FoldOwner, foldDigest } from "../fold/owner";
import { restoreRow } from "../fold/restore";
import { createV2HiddenCompletionExecutor } from "../hidden-completion";
import { gaDatabasePath, V2StoreReader } from "../store-reader";
import { deliverPendingChannel2, isAdmittedSynthetic } from "./channel2";
import { startDreamTrigger } from "./dream-trigger";
import { HiddenChildHook, registerHiddenChildAgents } from "./hidden-child";
import { warmModelLimitCacheFromCatalog } from "./model-limit-cache";
import { adaptPayload, HEAD_IDS } from "./payload";
import { interruptBeforeProvider, V2ContextRefusal } from "./refusal";
import { rawMessages } from "./store";
import type { SessionContext, V2Context } from "./types";

export function createHostSeams(
    context: V2Context,
    read: TransformDeps["hostRawMessages"] & {},
    liveModels: NonNullable<TransformDeps["liveModelBySession"]>,
): Required<
    Pick<
        TransformDeps,
        "hostRawMessages" | "hostProtectedTailBoundary" | "hostModelFallback" | "hostRefuse"
    >
> {
    return {
        hostRawMessages: read,
        hostProtectedTailBoundary: (args) =>
            resolveOpenCodeProtectedTailBoundary({
                ...args,
                cacheNamespace: `opencode2:${args.sessionId}`,
            }),
        // Draft-backed: v2 never reconstructs the live model from message.updated.
        hostModelFallback: (sessionID) => liveModels.get(sessionID) ?? null,
        hostRefuse: (_client, sessionID) =>
            interruptBeforeProvider(context.session, sessionID as SessionContext["sessionID"]),
    };
}

function toolResultText(result: { content?: unknown } | undefined): string {
    const content = result?.content ?? (result as { output?: unknown } | undefined)?.output;
    if (typeof content === "string") return content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
        const record = content as { text?: unknown; value?: unknown };
        if (typeof record.text === "string") return record.text;
        if (typeof record.value === "string") return record.value;
        return "";
    }
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            const record = part as { type?: unknown; text?: unknown; value?: unknown };
            if (typeof record.text === "string") return record.text;
            if (typeof record.value === "string") return record.value;
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

/** Accept both a raw model array and the 2.0.5 `{ data }` list payload. */
export function catalogModels(listed: unknown): Array<{
    id: string;
    providerID: string;
    limit: { context: number };
}> {
    const rows = Array.isArray(listed)
        ? listed
        : listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
          ? (listed as { data: unknown[] }).data
          : [];
    return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const model = row as {
            id?: unknown;
            providerID?: unknown;
            limit?: { context?: unknown };
        };
        if (typeof model.id !== "string" || typeof model.providerID !== "string") return [];
        const contextLimit = model.limit?.context;
        if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit)) return [];
        return [{ id: model.id, providerID: model.providerID, limit: { context: contextLimit } }];
    });
}

/** Build the JSON Schema OpenCode 2 expects for a tool's `input` from its zod arg shape. */
function toolArgsJsonSchema(args: ToolDefinition["args"]): Record<string, unknown> {
    try {
        const objectSchema = tool.schema.object(args);
        const { $schema: _schema, ...rest } = tool.schema.toJSONSchema(objectSchema) as Record<
            string,
            unknown
        >;
        return rest;
    } catch {
        // A shape zod cannot render as JSON Schema must not take down plugin setup.
        return { type: "object", properties: {}, additionalProperties: true };
    }
}

/** Bridge a v1 `ToolResult` to the v2 `Tool.Result` shape (content/metadata). */
function toV2ToolResult(result: ToolResult): {
    content?: string;
    metadata?: Record<string, unknown>;
} {
    if (typeof result === "string") return { content: result };
    return {
        content: result.output ?? "",
        ...(result.metadata ? { metadata: result.metadata } : {}),
    };
}

/** Rewrite Magic Context ctx_* tool descriptions for this draft's model. */
export function applyV2PromptSurfaceTools(
    draft: SessionContext,
    runtime: PromptSurfaceRuntime,
    config: PromptSurfaceConfig | undefined,
): void {
    if (!draft.tools) return;
    const modelKey = `${draft.model.providerID}/${draft.model.id}`;
    const registration = runtime.resolveRegistration(config, modelKey);
    for (const id of ACTIVE_TOOL_IDS) {
        const tool = draft.tools[id];
        if (!tool) continue;
        tool.description = registration.descriptionFor(id, tool.description);
    }
}

export async function registerContext(context: V2Context) {
    const directory = context.location.directory;
    const config = loadPluginConfigDetailed(directory).config;
    if (!config.enabled) return;
    // Compaction-off mode: Magic Context still provides tools, memory/docs
    // injection and the RPC surface, but every compaction-only path
    // (host-checkpoint intercept, folds, historian, unsafe interrupts) stays
    // out of the way so the host's native compaction owns the window.
    const compactionEnabled = isCompactionEnabled(config);
    const conflicts = detectConflicts(directory, {
        compactionEnabled,
        hostGeneration: "v2",
    });
    if (conflicts.hasConflict) {
        console.warn(
            `[magic-context] v2 setup disabled by conflicting context hooks: ${conflicts.reasons.join("; ")}`,
        );
        return;
    }
    const folds = new FoldOwner(context.storage);
    const limits = new Map<string, number>();
    const queriedModels = new Set<string>();
    // Draft-authoritative model/variant/agent. Not the v1 event-driven map.
    const liveModels: NonNullable<TransformDeps["liveModelBySession"]> = new Map();
    const promptSurfaceRuntime = createPromptSurfaceRuntime({
        harness: "opencode2",
        directory,
        warn: (message) => console.warn(`[magic-context] config warning: ${message}`),
    });
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
        db = openDatabase() ?? undefined;
    } catch {
        // The primary context hook retains the existing fail-closed storage path.
        // Hidden work remains unavailable for this plugin instance when durable storage cannot open.
    }
    const hiddenChildHook = new HiddenChildHook();
    await registerHiddenChildAgents(context.agent);
    let hiddenAgentsReady: Promise<void> | undefined;
    const hiddenCompletionExecutor =
        db && isDatabasePersisted(db)
            ? await createV2HiddenCompletionExecutor(context.session, {
                  db,
                  projectIdentity: resolveProjectIdentity(directory) ?? directory,
                  hook: hiddenChildHook,
                  ensureAgent: () => (hiddenAgentsReady ??= context.agent.reload()),
                  openReader: () =>
                      new V2StoreReader(
                          gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
                      ),
              })
            : undefined;
    const dreamTrigger =
        hiddenCompletionExecutor && config.dreamer && !config.dreamer.disable
            ? startDreamTrigger(context, {
                  config: config.dreamer,
                  executor: hiddenCompletionExecutor,
                  projectIdentity: () => resolveProjectIdentity(directory) ?? directory,
                  language: config.language,
                  mural: config.mural,
              })
            : undefined;
    const historianModels = resolveHistorianModel(config, "opencode");
    const usage: TransformDeps["contextUsageMap"] = new Map();
    const channel1: NonNullable<TransformDeps["channel1StateBySession"]> = new Map();
    const variants = new Map<string, string | undefined>();
    const agents = new Map<string, string>();
    const historyRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const rawProviders = new Map<string, () => void>();
    let passDuties: ReturnType<typeof createChatMessageHook> | undefined;
    let toolDuties: ReturnType<typeof createToolExecuteAfterHook> | undefined;
    await context.tool.hook("execute.before", (draft) => assertExecutableToolInput(draft.input));
    await context.tool.hook("execute.after", async (draft) => {
        if (!db) return;
        if (draft.status && draft.status !== "completed") return;
        try {
            toolDuties ??= createToolExecuteAfterHook({ db, channel1StateBySession: channel1 });
            const text = toolResultText(draft.result);
            const output = { output: text };
            await toolDuties({ ...draft, args: draft.input }, output);
            if (draft.result && output.output !== text) {
                const content = draft.result.content;
                if (typeof content === "string") draft.result.content = output.output;
                else if (Array.isArray(content) && output.output.startsWith(text))
                    content.push({ type: "text", text: output.output.slice(text.length) });
            }
            const baseline = channel1.get(draft.sessionID);
            await deliverPendingChannel2(context, db, draft.sessionID, baseline);
        } catch (error) {
            console.warn("[magic-context] v2 Channel 2 delivery deferred", error);
        }
    });
    // OpenCode 2 has no v1 plugin lane, so the v1 server() path that built
    // createToolRegistry never runs and the ctx_* tools are otherwise absent.
    // Register them on the v2 tool domain here. They are added with
    // codemode:false so they surface as direct tools, matching how the v1 lane
    // exposed them.
    const registry = createToolRegistry({
        ctx: { directory } as PluginContext,
        pluginConfig: config,
        promptSurfaceRuntime,
        registrationPromptSurface: config.prompt_surface,
    });
    const registryEntries = Object.entries(registry);
    if (registryEntries.length > 0 && context.tool.transform) {
        try {
            await context.tool.transform((editor) => {
                for (const [name, definition] of registryEntries) {
                    editor.add({
                        name,
                        description: definition.description,
                        input: toolArgsJsonSchema(definition.args),
                        options: { codemode: false },
                        execute: async (input, toolContext) => {
                            const result = await definition.execute(input as never, {
                                sessionID: toolContext.sessionID,
                                messageID: toolContext.messageID,
                                agent: toolContext.agent,
                                directory,
                                worktree: directory,
                                abort: new AbortController().signal,
                                metadata: () => {},
                                ask: async () => {},
                            });
                            return toV2ToolResult(result);
                        },
                    });
                }
            });
        } catch (error) {
            console.warn("[magic-context] v2 ctx_* tool registration skipped", error);
        }
    }
    const read = (sessionID: string) => {
        const reader = new V2StoreReader(
            gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
        );
        try {
            return rawMessages(reader.history(sessionID));
        } finally {
            reader.close();
        }
    };
    const pagedRead = Object.assign(read, {
        readPage: (sessionID: string, after: number, limit: number, watermark: number) =>
            read(sessionID)
                .filter((m) => m.ordinal > after && m.ordinal <= watermark)
                .slice(0, limit),
        getCount: (sessionID: string) => read(sessionID).length,
    });
    let transform: ReturnType<typeof createTransform> | undefined;
    const refuseIfUnsafe = async (draft: SessionContext): Promise<boolean> => {
        let unsafe = false;
        try {
            db ??= openDatabase();
            if (!db || !isDatabasePersisted(db)) throw new Error("context storage is not durable");
            getOrCreateSessionMeta(db, draft.sessionID);
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            try {
                const latest = reader
                    .history(draft.sessionID)
                    .filter((row) => row.type === "assistant")
                    .at(-1);
                const tokens = latest?.data.tokens;
                const modelKey = `${draft.model.providerID}/${draft.model.id}`;
                if (!queriedModels.has(modelKey)) {
                    const catalog = await Promise.resolve(context.model.list());
                    for (const model of catalogModels(catalog))
                        limits.set(`${model.providerID}/${model.id}`, model.limit.context);
                    queriedModels.add(modelKey);
                }
                const limit = limits.get(modelKey);
                if (tokens && limit && Number.isFinite(limit) && limit > 0) {
                    const inputTokens = tokens.input + tokens.cache.read + tokens.cache.write;
                    // Native compaction owns the window when MC compaction is off.
                    unsafe = compactionEnabled && inputTokens / limit >= 0.95;
                    const completed = latest?.data.time?.completed;
                    // The v1 lane persists usage from its event handler; the v2 lane
                    // has no event handler, so persist the same fields here or the
                    // sidebar/status surface stays at the 0 defaults.
                    updateSessionMeta(db, draft.sessionID, {
                        ...(typeof completed === "number" ? { lastResponseTime: completed } : {}),
                        lastContextPercentage: (inputTokens / limit) * 100,
                        lastInputTokens: inputTokens,
                        lastUsageContextLimit: limit,
                        lastObservedModelKey: modelKey,
                    });
                    usage.set(draft.sessionID, {
                        usage: { inputTokens, percentage: (inputTokens / limit) * 100 },
                        hasUsageTokens: true,
                        updatedAt: Date.now(),
                    });
                }
            } finally {
                reader.close();
            }
        } catch (error) {
            console.warn("[magic-context] v2 refuseIfUnsafe", error);
            // A storage failure in compaction-off mode must not abort the turn:
            // there is no MC recovery path to run.
            unsafe = compactionEnabled;
        }
        if (unsafe) await interruptBeforeProvider(context.session, draft.sessionID);
        return unsafe;
    };
    const materialize = (draft: SessionContext) => {
        db ??= openDatabase();
        if (!db || !isDatabasePersisted(db)) throw new Error("context storage is not durable");
        const state = getOrCreateSessionMeta(db, draft.sessionID);
        return materializeM0({
            db,
            sessionId: draft.sessionID,
            state,
            projectPath: resolveProjectIdentity(directory) ?? directory,
            projectDirectory: directory,
            memoryEnabled: config.memory.enabled,
            memoryInjectionBudgetTokens: config.memory.injection_budget_tokens,
            hardSignals: {
                systemHash: foldDigest(JSON.stringify(draft.system)),
                toolSetHash: "",
                modelKey: `${draft.model.providerID}/${draft.model.id}`,
                cacheExpired: false,
                lastResponseTime: state.lastResponseTime,
            },
        }).m0Text;
    };
    if (compactionEnabled)
        await context.session.hook("compaction", async (draft) => {
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            try {
                const rows = reader.history(draft.sessionID);
                const ids = new Set(draft.messages.map((message) => message.id));
                const watermark = Math.max(
                    -1,
                    ...rows.filter((row) => ids.has(row.id)).map((row) => row.seq),
                );
                const running = rows
                    .filter((row) => row.type === "compaction" && row.data.status === "running")
                    .at(-1);
                const fold = await folds.supply({
                    sessionID: draft.sessionID,
                    watermark,
                    runningCut: running?.seq,
                    materialize: () => materialize(draft),
                });
                draft.result = { summary: fold.submitted };
            } catch (cause) {
                await interruptBeforeProvider(context.session, draft.sessionID);
                throw new V2ContextRefusal(
                    "Magic Context could not preserve the host checkpoint.",
                    {
                        cause,
                    },
                );
            } finally {
                reader.close();
            }
        });
    await context.session.hook("context", async (draft) => {
        if (hiddenChildHook.apply(draft)) return;
        liveModels.set(draft.sessionID, {
            providerID: draft.model.providerID,
            modelID: draft.model.id,
        });
        variants.set(draft.sessionID, draft.model.variant);
        agents.set(draft.sessionID, draft.agent);
        applyV2PromptSurfaceTools(draft, promptSurfaceRuntime, config.prompt_surface);
        if (context.tool.transform) {
            const modelKey = `${draft.model.providerID}/${draft.model.id}`;
            const registration = promptSurfaceRuntime.resolveRegistration(
                config.prompt_surface,
                modelKey,
            );
            await context.tool.transform((editor) => {
                for (const id of ACTIVE_TOOL_IDS) {
                    editor.update(id, (tool) => {
                        tool.description = registration.descriptionFor(id, tool.description);
                    });
                }
            });
        }
        let postFold = false;
        try {
            if (await refuseIfUnsafe(draft)) return;
            if (!db) return;
            const storage = db;
            updateSessionMeta(db, draft.sessionID, {
                systemPromptHash: foldDigest(JSON.stringify(draft.system)),
            });
            await preloadTokenizer();
            passDuties ??= createChatMessageHook({
                db,
                liveModelBySession: liveModels,
                variantBySession: variants,
                agentBySession: agents,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                systemPromptRefreshSessions: new Set(),
                cacheTtlConfig: config.cache_ttl,
                upgradeReminder: (sessionID) =>
                    maybeSendUpgradeReminder(
                        {
                            db: storage,
                            client: undefined,
                            getNotificationParams: () => ({}),
                            sendStatusNotification: async (_client, id, text) => {
                                pushNotification("toast", { message: text, variant: "info" }, id);
                                return "queued";
                            },
                        },
                        sessionID,
                    ),
            });
            await passDuties({
                sessionID: draft.sessionID,
                agent: draft.agent,
                variant: draft.model.variant,
                model: { providerID: draft.model.providerID, modelID: draft.model.id },
            });
            // Background historian reads outlive the context callback. Keep its source
            // registered until plugin disposal, rather than falling back to the v1 store.
            if (!rawProviders.has(draft.sessionID))
                rawProviders.set(
                    draft.sessionID,
                    setRawMessageProvider(draft.sessionID, {
                        readMessages: () => read(draft.sessionID),
                    }),
                );
            transform ??= createTransform({
                db,
                tagger: createTagger(),
                scheduler: createScheduler({
                    executeThresholdPercentage: config.execute_threshold_percentage,
                }),
                contextUsageMap: usage,
                compactionOff: !compactionEnabled,
                protectedTokens: config.protected_tokens,
                protectedTokenTierOverrides: getProtectedTokensTierOverrides(config),
                executeThresholdPercentage: config.execute_threshold_percentage,
                liveModelBySession: liveModels,
                channel1StateBySession: channel1,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                variantBySession: variants,
                clearReasoningAge: config.clear_reasoning_age,
                directory,
                projectPath: directory,
                hiddenCompletionExecutor,
                historianRunnable:
                    compactionEnabled &&
                    hiddenCompletionExecutor !== undefined &&
                    config.historian?.disable !== true,
                historianModel: historianModels.primary,
                fallbackModels: historianModels.fallbacks,
                historianTimeoutMs: config.historian_timeout_ms,
                historianMaxOutputTokens: config.historian?.maxTokens,
                historianTwoPass: config.historian?.two_pass,
                compactionMarkerStrategy: v2CompactionMarkerStrategy,
                memoryConfig: {
                    enabled: config.memory.enabled,
                    injectionBudgetTokens: config.memory.injection_budget_tokens,
                    autoPromote: config.memory.auto_promote,
                },
                ...createHostSeams(context, pagedRead, liveModels),
            });
            const admitted = new Set<string>();
            for (const message of draft.messages) {
                if (message.id && (await isAdmittedSynthetic(context, draft.sessionID, message.id)))
                    admitted.add(message.id);
            }
            let checkpoint: SessionContext["messages"][number] | undefined;
            let submitted: string | undefined;
            if (compactionEnabled) {
                const reader = new V2StoreReader(
                    gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
                );
                try {
                    const cut = reader.latestCompaction(draft.sessionID);
                    const incoming = cut && draft.messages.find((message) => message.id === cut.id);
                    postFold = cut !== undefined;
                    if (cut && !incoming)
                        throw new Error("The host checkpoint disappeared from the context draft");
                    if (cut && incoming) {
                        const identity = await folds.observe({
                            sessionID: draft.sessionID,
                            cutSeq: cut.seq,
                            summary: cut.data.summary ?? "",
                            rendered: incoming,
                            onHard: (reason) => {
                                console.warn(
                                    `[magic-context] HARD reason=${reason} session=${draft.sessionID}`,
                                );
                                materialize(draft);
                                pendingMaterializationSessions.add(draft.sessionID);
                            },
                        });
                        checkpoint = structuredClone(identity.rendered ?? incoming);
                        submitted = identity.rendered
                            ? (identity.renderedSummary ?? identity.submitted)
                            : (cut.data.summary ?? "");
                        const all = reader.history(draft.sessionID);
                        const boundaryID = (
                            db
                                .prepare(
                                    "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
                                )
                                .get(draft.sessionID) as { id: string | null } | null
                        )?.id;
                        const boundary = all.find((row) => row.id === boundaryID)?.seq ?? -1;
                        const present = new Set(draft.messages.map((message) => message.id));
                        const restored = all
                            .filter(
                                (row) =>
                                    row.seq > boundary &&
                                    row.seq <= cut.seq &&
                                    !present.has(row.id),
                            )
                            .flatMap((row) => restoreRow(row, draft.model));
                        draft.messages.splice(
                            0,
                            draft.messages.length,
                            ...restored,
                            ...draft.messages.filter((message) => message !== incoming),
                        );
                    }
                } finally {
                    reader.close();
                }
            }
            const mapped = adaptPayload(draft, admitted);
            await transform({}, mapped);
            mapped.commit();
            if (db) {
                await deliverPendingChannel2(
                    context,
                    db,
                    draft.sessionID,
                    channel1.get(draft.sessionID),
                );
            }
            if (checkpoint && submitted !== undefined) {
                const head = draft.messages.find((message) => message.id === HEAD_IDS[0]);
                const baseline = head?.content.find((part) => part.type === "text")?.text;
                if (typeof baseline === "string") {
                    for (const part of checkpoint.content)
                        if (part.type === "text" && typeof part.text === "string") {
                            part.text = part.text.replace(
                                `<summary>\n${submitted}\n</summary>`,
                                `<summary>\n${baseline}\n</summary>`,
                            );
                        }
                    const volatile = draft.messages.find((message) => message.id === HEAD_IDS[1]);
                    if (volatile && head)
                        volatile.content.push(
                            ...head.content.filter((part) => part.type !== "text"),
                        );
                    draft.messages.splice(
                        0,
                        draft.messages.length,
                        checkpoint,
                        ...draft.messages.filter((message) => message !== head),
                    );
                }
            }
        } catch (error) {
            if (error instanceof V2ContextRefusal) throw error;
            if (postFold) {
                await interruptBeforeProvider(context.session, draft.sessionID);
                throw new V2ContextRefusal(
                    "Magic Context could not restore the unarchived host history.",
                    { cause: error },
                );
            }
            // Another plugin can poison the shared draft. Do not fail an otherwise viable turn.
            console.warn("[magic-context] v2 context unavailable", error);
        }
    });
    // The v1 lane warms MC's model-limit cache from its SDK client at boot; the
    // v2 lane must seed it from the host catalog, or every limit resolved here
    // falls back to the generic 200k default (sidebar denominator, history
    // budgets and window geometry then disagree with the transform's own math).
    setTimeout(() => {
        void warmModelLimitCacheFromCatalog(context);
    }, 0);
    // OpenCode 2 never runs the v1 server() lane, so the RPC server that the
    // terminal TUI's sidebar/status reads depend on would never start: the v2
    // TUI is a pure RPC client (no direct SQLite access), so without a listener
    // the sidebar renders zeros. Start the same surface here and hand it the v2
    // lane's draft-authoritative live maps so the snapshot/status handlers
    // resolve the session's active model, variant and agent.
    const rpcLiveSessionState: LiveSessionState = {
        ...createLiveSessionState(),
        liveModelBySession: liveModels,
        variantBySession: variants,
        agentBySession: agents,
        channel1StateBySession: channel1,
        historyRefreshSessions,
        pendingMaterializationSessions,
    };
    const storageDir = getMagicContextStorageDir();
    const rpcServer = new MagicContextRpcServer(storageDir, directory);
    let rpcStopped = false;
    registerRpcHandlers(rpcServer, {
        directory,
        config,
        // The v2 host context exposes no SDK client, so the recomp/upgrade
        // notify paths stay inert; the read-only snapshot handlers need none.
        client: undefined,
        liveSessionState: rpcLiveSessionState,
        rustModeModuleClient: undefined,
        storageDir,
    });
    // start() is async but its Bun.serve + discovery-file prefix is synchronous;
    // run it in the next task so those filesystem calls stay outside the host's
    // deadline-bound plugin construction, matching the v1 lane.
    setTimeout(() => {
        if (rpcStopped) return;
        void rpcServer
            .start()
            .catch((error) => console.warn("[magic-context] v2 RPC server failed to start", error));
    }, 0);
    return {
        async dispose() {
            rpcStopped = true;
            rpcServer.stop();
            await dreamTrigger?.dispose();
            for (const release of rawProviders.values()) release();
            rawProviders.clear();
        },
    };
}
