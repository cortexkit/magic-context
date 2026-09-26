import { loadPluginConfigDetailed } from "../../config";
import { isCompactionEnabled } from "../../config/agent-disable";
import {
    dreamerRunConfig,
    historianRunConfig,
    pluginConfigReader,
} from "../../config/live-run-config";
import { getProtectedTokensTierOverrides } from "../../config/project-security";
import { summarizeManualDream } from "../../features/magic-context/dreamer/manual-summary";
import { userMemoryCollectionEnabled } from "../../features/magic-context/dreamer/task-config";
import { formatUnsupportedDreamTasks } from "../../features/magic-context/dreamer/task-registry";
import { isFailClosedBlockingError } from "../../features/magic-context/fail-closed-block";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { detectOverflow } from "../../features/magic-context/overflow-detection";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    clearSession,
    getOrCreateSessionMeta,
    getOverflowState,
    isDatabasePersisted,
    markSessionCleanupPending,
    openDatabase,
    recordDetectedContextLimit,
    recordOverflowDetected,
} from "../../features/magic-context/storage";
import { getPersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import { rebaseSessionCoordinatesAsync } from "../../features/magic-context/store-generation-rebase";
import { createTagger } from "../../features/magic-context/tagger";
import {
    getCurrentToolSetHash,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { resolveCtxReduceAvailabilityFromMessages } from "../../hooks/magic-context/ctx-reduce-availability";
import {
    deriveHistorianChunkTokens,
    resolveHistorianContextLimit,
    resolveKnownHistorianContextLimit,
} from "../../hooks/magic-context/derive-budgets";
import {
    assertExecutableToolInput,
    createDroppedInputGuard,
    recordToolParameters,
} from "../../hooks/magic-context/dropped-input-guard";
import { EmergencyFailClosedError } from "../../hooks/magic-context/emergency-fail-closed";
import { getSessionErrorInfo } from "../../hooks/magic-context/event-payloads";
import { resolveContextLimit } from "../../hooks/magic-context/event-resolvers";
import {
    createChatMessageHook,
    createToolExecuteAfterHook,
} from "../../hooks/magic-context/hook-handlers";
import { materializeM0 } from "../../hooks/magic-context/inject-compartments";
import { createModuleToolBackends } from "../../hooks/magic-context/module-tool-backends";
import { resolveOpenCodeProtectedTailBoundary } from "../../hooks/magic-context/protected-tail-boundary";
import { setBoundedRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { preloadTokenizer } from "../../hooks/magic-context/read-session-formatting";
import { servedModuleM0Text } from "../../hooks/magic-context/rust-served-m0";
import { createSystemPromptHashHandler } from "../../hooks/magic-context/system-prompt-hash";
import { createTransform, type TransformDeps } from "../../hooks/magic-context/transform";
import { scheduleAfterBootQuiet } from "../../plugin/boot-quiet";
import { registerRpcHandlers } from "../../plugin/rpc-handlers";
import { detectConflicts } from "../../shared/conflict-detector";
import { getDataDir, getMagicContextStorageDir } from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { log, sessionLog } from "../../shared/logger";
import { resolveHistorianModel } from "../../shared/model-resolution";
import {
    isSaneLimit,
    refreshModelLimitsFromApi,
    resolveLimit,
    setOutputReserveConfig,
} from "../../shared/models-dev-cache";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import {
    ACTIVE_TOOL_IDS,
    createPromptSurfaceRuntime,
    type PromptSurfaceRuntime,
} from "../../shared/prompt-surface-runtime";
import { pushNotification } from "../../shared/rpc-notifications";
import { MagicContextRpcServer } from "../../shared/rpc-server";
import { renderUserFacingFailure, userFacingFailureCode } from "../../shared/user-facing-codes";
import { applyJsonSchemaParameterDescriptions } from "../../tools/parameter-descriptions";
import { createV2RustCompactionMarkerStrategy, trimToRecordedBoundary } from "../fold/boundary";
import { hostMediaAsset, hostUsesMediaAssets, rememberHostMedia } from "../fold/host-media";
import { v2CompactionMarkerStrategy } from "../fold/markers";
import { FoldOwner, foldDigest } from "../fold/owner";
import { restoreRow } from "../fold/restore";
import { createV2HiddenCompletionExecutor } from "../hidden-completion";
import { type HostServiceOwner, removeHostSession } from "../host-service";
import { gaDatabasePath, V2StoreReader } from "../store-reader";
import { deliverPendingChannel2, deliverSynthetic, isAdmittedSynthetic } from "./channel2";
import { registerV2Commands } from "./commands";
import { DeletedSessionTombstones } from "./deleted-session-tombstones";
import { resolveManualDreamTask, runManualDreamNow } from "./dream-manual";
import { startDreamTrigger } from "./dream-trigger";
import { HiddenChildHook, registerHiddenChildAgents } from "./hidden-child";
import { modelLimitCacheWarm, warmModelLimitCacheFromCatalog } from "./model-limit-cache";
import { adaptPayload, HEAD_IDS } from "./payload";
import { interruptBeforeProvider, V2ContextRefusal } from "./refusal";
import { RestoredRowCache } from "./restore-rows";
import { createV2RpcLiveSessionState } from "./rpc-live-state";
import { createV2RustRefusalRecovery, resolveV2RustModeModuleClient } from "./rust-mode";
import { runV2SessionProjectBackfill } from "./session-project-backfill";
import {
    createV2RawMessageProvider,
    createV2RawMessageReader,
    readAllV2RawMessagesForConversion,
    readV2RawMessagePagesForConversion,
    resolveV2BoundaryUserMessage,
    servedBoundaryRow,
} from "./store";
import { registerTools } from "./tools";
import type { SessionContext, V2Context } from "./types";
import { persistV2UsageReading } from "./usage-persist";
import { resolveUsageReading } from "./usage-reading";

// The event stream can trail the terminal store row by a scheduler tick; keep failure surfacing fast.
const HIDDEN_SESSION_ERROR_GRACE_MS = 50;

export function isBlockingV2TransformError(error: unknown): boolean {
    return error instanceof EmergencyFailClosedError || isFailClosedBlockingError(error);
}

/**
 * Cache the directory the host bound a session to, looked up once per session.
 *
 * On OpenCode 1 the shared transform asks the SDK client for this and records
 * the session-to-project binding (`session_projects`) only when the host
 * answered. OpenCode 2 gives plugins no SDK client, so without this lookup the
 * transform always fell back to the launch directory, never recorded a binding,
 * and the Dashboard found no project for any OpenCode 2 session. The session's
 * directory is fixed at creation, so one successful answer is kept for the
 * session's lifetime; a failed lookup is retried on the next pass.
 */
export async function cacheV2SessionDirectory(
    session: Pick<V2Context["session"], "get">,
    sessionID: string,
    directories: Map<string, string>,
): Promise<void> {
    if (directories.has(sessionID)) return;
    try {
        const directory = (await session.get({ sessionID }))?.location?.directory;
        if (typeof directory === "string" && directory.length > 0) {
            directories.set(sessionID, directory);
        }
    } catch (error) {
        sessionLog(
            sessionID,
            "v2 session directory lookup failed; using the launch directory:",
            error,
        );
    }
}

/**
 * Every pre-provider refusal on OpenCode 2 ends the turn with `session.interrupt`, which
 * the host records as a bare `outcome: "interrupted"` row: no error text reaches the
 * transcript, and under `opencode service` the server's stderr goes nowhere. The only
 * durable record of why a turn died is this log line, so it is written before the
 * interrupt is attempted.
 */
function refuseBeforeProvider(
    session: Pick<V2Context["session"], "interrupt">,
    sessionID: SessionContext["sessionID"],
    arm: string,
    cause?: unknown,
): Promise<void> {
    const detail =
        cause instanceof Error
            ? `${cause.name}: ${cause.message}`
            : cause === undefined
              ? ""
              : String(cause);
    sessionLog(
        sessionID,
        `v2 refusal: interrupting the turn before the provider request arm=${arm}${detail ? ` cause=${JSON.stringify(detail.slice(0, 500))}` : ""}`,
    );
    return interruptBeforeProvider(session, sessionID);
}

export function createHostSeams(
    context: V2Context,
    readAllForConversion: TransformDeps["hostRawMessages"] & {},
    reconciliationSource: NonNullable<TransformDeps["hostMessageReconciliationSource"]>,
    liveModels: NonNullable<TransformDeps["liveModelBySession"]>,
): Required<
    Pick<
        TransformDeps,
        | "hostRawMessages"
        | "hostMessageReconciliationSource"
        | "hostProtectedTailBoundary"
        | "hostModelFallback"
        | "hostRefusalNotice"
        | "hostRefuse"
    >
> {
    return {
        hostRawMessages: readAllForConversion,
        hostMessageReconciliationSource: reconciliationSource,
        hostProtectedTailBoundary: (args) =>
            resolveOpenCodeProtectedTailBoundary({
                ...args,
                cacheNamespace: `opencode2:${args.sessionId}`,
            }),
        // Draft-backed: v2 never reconstructs the live model from message.updated.
        hostModelFallback: (sessionID) => liveModels.get(sessionID) ?? null,
        hostRefusalNotice: async (_client, sessionID, message) => {
            pushNotification("toast", { message, variant: "error" }, sessionID);
            await deliverSynthetic(context, sessionID, message);
        },
        hostRefuse: (_client, sessionID) =>
            refuseBeforeProvider(
                context.session,
                sessionID as SessionContext["sessionID"],
                "transform-fail-closed",
            ),
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

/**
 * Record why a turn is about to be refused before the model is called.
 *
 * When reading the host store or the context database fails, the turn is treated
 * as unsafe and interrupted before the provider request. The host then stores the
 * turn as interrupted and the user simply never receives a reply — there is no
 * error on screen and no assistant message. Without this line the reason exists
 * only in OpenCode's own server log, so the Magic Context log that users are
 * asked for during a support request says nothing about why their turn died
 * (issue #493, where a store the OpenCode 2 host had migrated from OpenCode 1
 * was refused by the v2 store reader and every turn ended in silence).
 */
export function reportPreProviderRefusal(sessionID: string, error: unknown): void {
    console.warn("[magic-context] v2 refuseIfUnsafe", error);
    sessionLog(
        sessionID,
        `v2 refusing this turn before the model call: the context could not be read: ${getErrorMessage(error)}`,
    );
}

/** Accept both a raw model array and the 2.0.5 `{ data }` list payload. */
export function catalogModels(
    listed: unknown,
    draftModel?: SessionContext["model"],
): Array<{
    id: string;
    providerID: string;
    limit: { context: number; input?: number; output?: number };
}> {
    const rows = Array.isArray(listed)
        ? listed
        : listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
          ? (listed as { data: unknown[] }).data
          : [];
    const models = rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const model = row as {
            id?: unknown;
            providerID?: unknown;
            limit?: { context?: unknown; input?: number; output?: number };
        };
        if (typeof model.id !== "string" || typeof model.providerID !== "string") return [];
        const contextLimit = model.limit?.context;
        if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit)) return [];
        return [
            {
                id: model.id,
                providerID: model.providerID,
                limit: { ...model.limit, context: contextLimit },
            },
        ];
    });
    const draftContextLimit = draftModel?.limit?.context;
    if (
        draftModel &&
        typeof draftContextLimit === "number" &&
        Number.isFinite(draftContextLimit) &&
        draftContextLimit > 0
    ) {
        const key = `${draftModel.providerID}/${draftModel.id}`;
        const byKey = new Map(models.map((model) => [`${model.providerID}/${model.id}`, model]));
        byKey.set(key, {
            id: draftModel.id,
            providerID: draftModel.providerID,
            limit: { ...draftModel.limit, context: draftContextLimit },
        });
        return [...byKey.values()];
    }
    return models;
}

export function removeDreamerOnlyTools(draft: SessionContext): void {
    if (draft.tools) delete draft.tools.ctx_memory_list;
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
        applyJsonSchemaParameterDescriptions(id, tool.input, registration.preset);
    }
}

/**
 * Measure the tool definitions this request is actually going to send.
 *
 * OpenCode 1 measures the same thing through its `tool.definition` hook; OpenCode 2 has no such
 * hook, but the request draft carries the whole tool set, so the draft is the measurement seam.
 * This runs after the per-model descriptions have been applied, so what is counted is what goes on
 * the wire, and it is keyed by the same {provider, model, agent} triple the status and sidebar
 * handlers look the measurement up by.
 *
 * Measuring changes no served byte: the resulting tool-set hash is an attribution marker that the
 * m[0] materialization decision records but never folds on.
 */
export function recordV2ToolDefinitions(draft: SessionContext): void {
    if (!draft.tools) return;
    for (const [id, tool] of Object.entries(draft.tools)) {
        if (!tool) continue;
        // The execute hook sees only the tool name, so keep the parameter names
        // for the dropped-input refusal to list.
        recordToolParameters(id, tool.input);
        recordToolDefinition(
            draft.model.providerID,
            draft.model.id,
            draft.agent,
            id,
            typeof tool.description === "string" ? tool.description : "",
            tool.input,
        );
    }
}

/**
 * Run the system-prompt handler over one context draft and write its result back.
 *
 * The handler only compares and records the system-prompt hash once the session's
 * ctx_reduce verdict is frozen, because that verdict chooses the guidance text.
 * When nothing has frozen the verdict yet in this process, the handler falls
 * back to reading the first user message from OpenCode 1's `message` table. On
 * OpenCode 2 that read never succeeds (its store has a different schema), so
 * without freezing the verdict here first, the first pass after every restart
 * left the verdict provisional and skipped the hash comparison. A restart that changed the system
 * prompt then sent the new prompt on that first pass (so the provider cache was
 * lost there anyway) and only detected the change on the second pass, whose
 * separate HARD fold rebuilt the cache a second time.
 *
 * The verdict is therefore frozen first, from this draft's messages, with the
 * same resolver and the same message shape the message transform later in this
 * pass freezes it from (the adapted messages carry no per-message tools map, see
 * payload.ts), so it can only freeze to the value the transform would have
 * frozen. A draft with no user message leaves the verdict provisional, as before.
 * Any future read of OpenCode 2's ctx_reduce permissions has to run before this
 * call: once frozen, the verdict never changes for the session.
 */
export async function applyV2SystemPrompt(
    systemPrompt: Pick<ReturnType<typeof createSystemPromptHashHandler>, "handler">,
    draft: Pick<SessionContext, "sessionID" | "model" | "messages" | "system">,
): Promise<void> {
    resolveCtxReduceAvailabilityFromMessages(
        draft.sessionID,
        draft.messages.map((message) => ({ info: { role: message.role } })),
    );
    const system = { system: draft.system.map((part) => String(part.text ?? "")) };
    await systemPrompt.handler(
        {
            sessionID: draft.sessionID,
            model: { providerID: draft.model.providerID, modelID: draft.model.id },
        },
        system,
    );
    const originals = [...draft.system];
    draft.system.splice(
        0,
        draft.system.length,
        ...system.system.map((text, index) => ({
            ...originals[index],
            type: "text",
            text,
        })),
    );
}

export async function registerContext(context: V2Context) {
    const directory = context.location.directory;
    const config = loadPluginConfigDetailed(directory).config;
    if (!config.enabled) return;
    const liveConfigReader = pluginConfigReader(directory, config);
    const compactionOff = !isCompactionEnabled(config);
    const conflicts = detectConflicts(directory, {
        compactionEnabled: !compactionOff,
        hostGeneration: "v2",
    });
    if (conflicts.hasConflict) {
        console.warn(
            `[magic-context] v2 setup disabled by conflicting context hooks: ${conflicts.reasons.join("; ")}`,
        );
        return;
    }
    const folds = new FoldOwner(context.storage);
    setOutputReserveConfig(config.output_reserve);
    const queriedModels = new Set<string>();
    const rawLimits = new Map<string, { context: number; input?: number; output?: number }>();
    const hiddenSessionErrors = new Map<string, unknown>();
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
    // Rust mode reaches the `ck-mc` module over the same subc client the OpenCode 1
    // lane builds. Building it is inert until a pass actually calls the module, so
    // it is safe to hold one here for the whole process. It is resolved before the
    // tools are registered because the tool facades are part of the same wiring:
    // registering `ctx_note`/`ctx_memory` without them would let an agent's write
    // land in the host read model alone, where the module never sees it.
    const rustModeModuleClient = resolveV2RustModeModuleClient(config, directory);
    const rustMemorySyncRequestedSessions = new Set<string>();
    const moduleToolBackends =
        db && isDatabasePersisted(db)
            ? createModuleToolBackends({
                  db,
                  moduleClient: rustModeModuleClient,
                  directory,
                  memorySyncRequestedSessions: rustMemorySyncRequestedSessions,
              })
            : undefined;
    const tools =
        db && isDatabasePersisted(db)
            ? await registerTools(context, db, config, moduleToolBackends?.backends)
            : undefined;
    const usage: TransformDeps["contextUsageMap"] = new Map();
    await context.session.hook("http.response", async (draft) => {
        if (!db || draft.kind !== "primary" || draft.response.ok) return;
        const detection = detectOverflow(await draft.response.clone().text());
        if (!detection.isOverflow) return;
        const modelKey = `${draft.model.providerID}/${draft.model.id}`;
        if (compactionOff) {
            if (detection.reportedLimit)
                recordDetectedContextLimit(
                    db,
                    draft.sessionID,
                    detection.reportedLimit,
                    modelKey,
                    detection.reportedLimitProvenance,
                );
        } else {
            recordOverflowDetected(
                db,
                draft.sessionID,
                detection.reportedLimit,
                modelKey,
                "provider_overflow",
                detection.reportedLimitProvenance,
                detection.reportedInputTokens,
            );
            if (detection.reportedInputTokens) {
                const provenLimit = getOverflowState(
                    db,
                    draft.sessionID,
                    modelKey,
                ).detectedContextLimit;
                usage.set(draft.sessionID, {
                    usage: {
                        inputTokens: detection.reportedInputTokens,
                        percentage:
                            provenLimit > 0
                                ? (detection.reportedInputTokens / provenLimit) * 100
                                : 100,
                    },
                    hasUsageTokens: true,
                    updatedAt: Date.now(),
                });
            }
        }
    });
    const hiddenChildHook = new HiddenChildHook();
    await registerHiddenChildAgents(context.agent);
    let hiddenAgentsReady: Promise<void> | undefined;
    const hiddenCompletionExecutor =
        db && isDatabasePersisted(db)
            ? await createV2HiddenCompletionExecutor(
                  {
                      ...context.session,
                      get: async (input) => {
                          const session = await context.session.get(input);
                          const error = hiddenSessionErrors.get(input.sessionID);
                          return error === undefined ? session : { ...session, error };
                      },
                      terminalError: async (input) => {
                          const deadline = Date.now() + HIDDEN_SESSION_ERROR_GRACE_MS;
                          do {
                              const error = hiddenSessionErrors.get(input.sessionID);
                              if (error !== undefined) return error;
                              await new Promise((resolve) => setTimeout(resolve, 5));
                          } while (Date.now() < deadline);
                          return undefined;
                      },
                      prompt: async (input) => {
                          hiddenSessionErrors.delete(input.sessionID);
                          return context.session.prompt(input);
                      },
                      // The injected session surface stops short of deletion, so retiring a hidden
                      // child reaches the host's delete route directly — through the registration
                      // the child recorded when it was created, never through whichever service
                      // happens to be registered now.
                      remove: (input: { sessionID: string; owner?: HostServiceOwner }) =>
                          removeHostSession(input.sessionID, input.owner),
                  },
                  {
                      db,
                      projectIdentity: resolveProjectIdentity(directory) ?? directory,
                      hook: hiddenChildHook,
                      keepSubagents: config.keep_subagents === true,
                      ensureAgent: () => (hiddenAgentsReady ??= context.agent.reload()),
                      modelCatalog: () => Promise.resolve(context.model.list()),
                      openReader: () =>
                          new V2StoreReader(
                              gaDatabasePath(
                                  getDataDir(),
                                  process.env.OPENCODE_CHANNEL ?? "latest",
                              ),
                          ),
                  },
              )
            : undefined;
    const dreamerAtBoot = config.dreamer;
    const dreamTrigger =
        hiddenCompletionExecutor && dreamerAtBoot && !dreamerAtBoot.disable
            ? startDreamTrigger(context, {
                  config: dreamerAtBoot,
                  sample: () => {
                      const current = dreamerRunConfig(config, liveConfigReader.poll().effective);
                      return { config: current.dreamer ?? dreamerAtBoot, mural: current.mural };
                  },
                  executor: hiddenCompletionExecutor,
                  projectIdentity: () => resolveProjectIdentity(directory) ?? directory,
                  language: config.language,
                  mural: config.mural,
              })
            : undefined;
    const sampleHistorian = () => {
        const fresh = historianRunConfig(config, liveConfigReader.poll().effective);
        const models = resolveHistorianModel(fresh, "opencode");
        return {
            model: models.primary,
            fallbackModels: models.fallbacks,
            contextLimit: resolveKnownHistorianContextLimit(models.primary?.model),
            maxOutputTokens: fresh.historian?.maxTokens,
            timeoutMs: fresh.historian_timeout_ms,
            twoPass: fresh.historian?.two_pass === true,
            autoPromote: fresh.memory?.auto_promote ?? true,
            userMemoriesEnabled: userMemoryCollectionEnabled(fresh.dreamer),
            commitClusterTrigger: fresh.commit_cluster_trigger,
            chunkTokens: deriveHistorianChunkTokens(
                resolveHistorianContextLimit(models.primary?.model),
            ),
        };
    };
    const historianModels = resolveHistorianModel(config, "opencode");
    const channel1: NonNullable<TransformDeps["channel1StateBySession"]> = new Map();
    const variants = new Map<string, string | undefined>();
    const agents = new Map<string, string>();
    const sessionDirectories = new Map<string, string>();
    const historyRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const restoredRows = new RestoredRowCache();
    const rawProviders = new Map<string, () => void>();
    let passDuties: ReturnType<typeof createChatMessageHook> | undefined;
    let toolDuties: ReturnType<typeof createToolExecuteAfterHook> | undefined;
    const droppedInputGuard = createDroppedInputGuard();
    await context.tool.hook("execute.before", (draft) =>
        assertExecutableToolInput(droppedInputGuard, {
            sessionID: draft.sessionID,
            toolName: draft.tool,
            input: draft.input,
        }),
    );
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
    const openStoreReader = () =>
        new V2StoreReader(gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"));
    const pagedRead = createV2RawMessageReader(openStoreReader);
    if (db && isDatabasePersisted(db)) {
        const backfillDb = db;
        scheduleAfterBootQuiet(() => {
            runV2SessionProjectBackfill(backfillDb, openStoreReader).catch((error: unknown) =>
                log("[session-project-backfill] OpenCode 2 backfill failed:", error),
            );
        });
    }
    const readAllForConversion = (sessionID: string) =>
        readAllV2RawMessagesForConversion(openStoreReader, sessionID);
    // Refusal recovery only needs to know whether a user turn followed the refused
    // one, so it reads the rows from that message onward, never the whole session.
    const readRowsFrom = (sessionID: string, messageID: string) => {
        const reader = openStoreReader();
        try {
            const seq = reader.sequenceForId(sessionID, messageID);
            if (seq === undefined) return [];
            return reader.range(sessionID, seq - 1, reader.latestSequence(sessionID));
        } finally {
            reader.close();
        }
    };
    const rustRefusalRecovery = rustModeModuleClient
        ? createV2RustRefusalRecovery({
              context,
              moduleClient: rustModeModuleClient,
              readRowsFrom,
          })
        : undefined;
    let transform: ReturnType<typeof createTransform> | undefined;
    let systemPrompt: ReturnType<typeof createSystemPromptHashHandler> | undefined;
    const systemPromptRefreshSessions = new Set<string>();
    const tagger = createTagger();
    const deletedSessions = new DeletedSessionTombstones();
    /**
     * Record the provider's usage for the session's latest reply. Returns true only
     * when that could not be done safely (the context database is not durable, or a
     * store could not be read); the usage figure itself never makes a turn unsafe.
     */
    const recordUsage = async (
        draft: Pick<SessionContext, "sessionID" | "model">,
    ): Promise<boolean> => {
        let unsafe = false;
        try {
            db ??= openDatabase();
            if (!db || !isDatabasePersisted(db)) throw new Error("context storage is not durable");
            getOrCreateSessionMeta(db, draft.sessionID);
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            try {
                const latest = reader.latestAssistant(draft.sessionID);
                const draftModelKey = `${draft.model.providerID}/${draft.model.id}`;
                if (!queriedModels.has(draftModelKey)) {
                    const catalog = await Promise.resolve(context.model.list());
                    const providers = new Map<
                        string,
                        {
                            id: string;
                            models: Record<
                                string,
                                { limit: { context: number; input?: number; output?: number } }
                            >;
                        }
                    >();
                    for (const model of catalogModels(catalog, draft.model)) {
                        rawLimits.set(`${model.providerID}/${model.id}`, model.limit);
                        const provider = providers.get(model.providerID) ?? {
                            id: model.providerID,
                            models: {},
                        };
                        provider.models[model.id] = { limit: model.limit };
                        providers.set(model.providerID, provider);
                    }
                    await refreshModelLimitsFromApi({
                        config: {
                            providers: async () => ({
                                data: { providers: [...providers.values()] },
                            }),
                        },
                    });
                    queriedModels.add(draftModelKey);
                }
                const usageDb = db;
                const limitFor = (providerID: string, modelID: string) => {
                    const modelKey = `${providerID}/${modelID}`;
                    const rawLimit = rawLimits.get(modelKey);
                    // The shared catalog rejects unusually small limits, but a
                    // provider may explicitly configure a valid small context window.
                    return rawLimit && !isSaneLimit(rawLimit.context)
                        ? (resolveLimit(rawLimit, providerID, modelID) ?? 0)
                        : resolveContextLimit(providerID, modelID, {
                              db: usageDb,
                              sessionID: draft.sessionID,
                          });
                };
                const reading = resolveUsageReading({
                    rowModel: latest?.data.model,
                    draftModel: { providerID: draft.model.providerID, id: draft.model.id },
                    tokens: latest?.data.tokens,
                    completed: latest?.data.time?.completed,
                    limitFor,
                });
                if (reading) {
                    persistV2UsageReading({
                        db: usageDb,
                        sessionID: draft.sessionID,
                        draftModel: draft.model,
                        reading,
                        contextUsageMap: usage,
                    });
                }
            } finally {
                reader.close();
            }
        } catch (error) {
            reportPreProviderRefusal(draft.sessionID, error);
            unsafe = true;
        }
        return unsafe;
    };
    // Context runs before generation. Persist terminal usage at execution completion
    // so pressure is visible even when the user has not started another turn.
    const usageController = new AbortController();
    const usageDone = (async () => {
        try {
            for await (const value of context.event.subscribe({ signal: usageController.signal })) {
                if (usageController.signal.aborted) break;
                const event = value as { type?: string; data?: { sessionID?: string } };
                if (!event.data?.sessionID) continue;
                const sessionID = event.data.sessionID;
                if (event.type === "session.error") {
                    const error = getSessionErrorInfo(event.data)?.error;
                    if (error !== undefined) hiddenSessionErrors.set(sessionID, error);
                    continue;
                }
                if (event.type === "session.deleted") {
                    deletedSessions.add(sessionID);
                    if (db) {
                        markSessionCleanupPending(db, sessionID);
                        clearSession(db, sessionID);
                    }
                    rawProviders.get(sessionID)?.();
                    rawProviders.delete(sessionID);
                    usage.delete(sessionID);
                    hiddenSessionErrors.delete(sessionID);
                    liveModels.delete(sessionID);
                    variants.delete(sessionID);
                    agents.delete(sessionID);
                    channel1.delete(sessionID);
                    historyRefreshSessions.delete(sessionID);
                    pendingMaterializationSessions.delete(sessionID);
                    lastHeuristicsTurnId.delete(sessionID);
                    restoredRows.forget(sessionID);
                    systemPromptRefreshSessions.delete(sessionID);
                    systemPrompt?.clearSession(sessionID);
                    tagger.cleanup(sessionID);
                    continue;
                }
                if (event.type !== "session.execution.succeeded") continue;
                const model = liveModels.get(sessionID);
                if (model)
                    await recordUsage({
                        sessionID,
                        model: { providerID: model.providerID, id: model.modelID },
                    });
            }
        } catch (error) {
            if (!usageController.signal.aborted)
                console.warn("[magic-context] v2 usage subscription failed", error);
        }
    })();
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
                toolSetHash: getCurrentToolSetHash(
                    draft.model.providerID,
                    draft.model.id,
                    draft.agent,
                ),
                modelKey: `${draft.model.providerID}/${draft.model.id}`,
                // materializeM0 does not read cacheExpired. mustMaterialize owns
                // expiry decisions on the transform path; this fold always renders
                // fresh bytes and keys its markers from the system and model hashes.
                cacheExpired: false,
                lastResponseTime: state.lastResponseTime,
            },
        }).m0Text;
    };
    if (!compactionOff)
        await context.session.hook("compaction", async (draft) => {
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            try {
                const watermark = reader.latestSequenceForIds(
                    draft.sessionID,
                    draft.messages.flatMap((message) => (message.id ? [message.id] : [])),
                );
                const running = reader.latestRunningCompaction(draft.sessionID);
                // In Rust mode the module composes m[0] and the host renders none, so the
                // checkpoint has to be the module's own baseline. Composing a TypeScript one
                // here would give the session two different histories: the one the host
                // stores in its checkpoint and the one the module keeps serving.
                const moduleBaseline = rustModeModuleClient
                    ? servedModuleM0Text(draft.sessionID)
                    : undefined;
                // This hook ALWAYS answers, and leaving `result` unset is not an option.
                // On GA 2.0.5 an unanswered request is not a polite decline: the host
                // summarizes with its own model and, when that answer is not in the
                // template it requires, records a `compaction.failed` row and ends the
                // turn with idle outcome=failed. Measured on the real host, a session
                // whose hook declined produced a failed compaction and no provider
                // request at all on every turn after the first. When the module has
                // served nothing yet there is no module baseline to answer with, so the
                // TypeScript one is supplied instead: still Magic Context's own account
                // of the session, rather than a host-composed summary of history the
                // module never served, or a dead turn.
                const source = !rustModeModuleClient
                    ? "typescript"
                    : moduleBaseline === null
                      ? "typescript_fallback"
                      : "module";
                const fold = await folds.supply({
                    sessionID: draft.sessionID,
                    watermark,
                    runningCut: running?.seq,
                    // Kept lazy for the TypeScript lane: materializing writes cache state and
                    // must only happen when the fold identity is actually new.
                    materialize: () => moduleBaseline ?? materialize(draft),
                });
                // One line per request with the baseline it was answered from. The
                // host's rate and ours are separate facts, and only reading both
                // explains a session's checkpoint cadence.
                sessionLog(
                    draft.sessionID,
                    `v2 compaction hook: fired answered=true source=${source}`,
                );
                draft.result = { summary: fold.submitted };
            } catch (cause) {
                await refuseBeforeProvider(
                    context.session,
                    draft.sessionID,
                    "compaction-fold",
                    cause,
                );
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
        // Learn the host's message and attachment classes, so attachments on rows restored
        // after a host checkpoint can be rebuilt in the host's own shape.
        rememberHostMedia(draft.messages);
        if (hiddenChildHook.apply(draft)) return;
        removeDreamerOnlyTools(draft);
        // A deletion that races an in-flight pass must not let that pass rebuild
        // the state just cleared by the one deletion event.
        if (deletedSessions.has(draft.sessionID)) return;
        liveModels.set(draft.sessionID, {
            providerID: draft.model.providerID,
            modelID: draft.model.id,
        });
        variants.set(draft.sessionID, draft.model.variant);
        if (!modelLimitCacheWarm()) void warmModelLimitCacheFromCatalog(context);
        agents.set(draft.sessionID, draft.agent);
        // Per-model descriptions are applied to this request's draft only.
        // `context.tool.transform` must never be called from here: the host keeps
        // every registration for the life of the process, so one call per pass
        // grows host state without bound and a light-preset session's shortened
        // descriptions become the baseline every later request (any session,
        // any model) starts from. Registration happens once, in tools.ts.
        applyV2PromptSurfaceTools(draft, promptSurfaceRuntime, config.prompt_surface);
        // Measured after the descriptions are final, so the Tool Defs row and the tool-set hash
        // describe the bytes this request sends rather than the host's unedited catalog.
        recordV2ToolDefinitions(draft);
        let postFold = false;
        try {
            // Only a failure to read or record usage refuses here. A high reading is
            // left to the transform below: its force band and emergency path are what
            // reduce an over-limit session, and refusing ahead of them would refuse
            // the same stored reading again on every later turn.
            if ((await recordUsage(draft)) && !compactionOff) {
                await refuseBeforeProvider(context.session, draft.sessionID, "usage-unavailable");
                return;
            }
            if (!db) return;
            // OpenCode 2 exposes system and message transformation through one
            // context hook, with the system handler running first below. Rebase
            // before it so a converted session initializes the new host's prompt
            // hash instead of comparing against the previous host and arming a
            // redundant follow-up fold. The shared transform sees the new stamp
            // later in this pass and treats its own rebase call as a no-op.
            // The first request of a long session last served by OpenCode 1 does
            // real work here; the async form lets the host keep serving (Stop,
            // health checks) meanwhile, and this pass still waits for the
            // commit before it builds anything.
            try {
                await rebaseSessionCoordinatesAsync({
                    db,
                    sessionId: draft.sessionID,
                    generation: "v2",
                    readMessages: readAllForConversion,
                    readMessagePages: (sessionID) =>
                        readV2RawMessagePagesForConversion(openStoreReader, sessionID),
                });
            } catch (error) {
                sessionLog(
                    draft.sessionID,
                    "store projection rebase failed before system prompt (retrying in transform):",
                    error,
                );
            }
            systemPrompt ??= createSystemPromptHashHandler({
                db,
                dreamerEnabled: config.dreamer !== undefined && !config.dreamer.disable,
                memoryEnabled: config.memory.enabled,
                language: config.language,
                promptSurface: config.prompt_surface,
                promptSurfaceRuntime,
                systemPromptRefreshSessions,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                injectionEnabled: config.system_prompt_injection.enabled,
                injectionSkipSignatures: config.system_prompt_injection.skip_signatures,
            });
            await applyV2SystemPrompt(systemPrompt, draft);
            await preloadTokenizer();
            passDuties ??= createChatMessageHook({
                db,
                liveModelBySession: liveModels,
                variantBySession: variants,
                agentBySession: agents,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                systemPromptRefreshSessions,
                cacheTtlConfig: config.cache_ttl,
            });
            await passDuties({
                sessionID: draft.sessionID,
                agent: draft.agent,
                variant: draft.model.variant,
                model: { providerID: draft.model.providerID, modelID: draft.model.id },
            });
            await cacheV2SessionDirectory(context.session, draft.sessionID, sessionDirectories);
            // Background historian reads outlive the context callback. Keep its source
            // registered until plugin disposal, rather than falling back to the v1 store.
            if (!rawProviders.has(draft.sessionID))
                rawProviders.set(
                    draft.sessionID,
                    setBoundedRawMessageProvider(
                        draft.sessionID,
                        createV2RawMessageProvider(pagedRead, draft.sessionID),
                    ),
                );
            transform ??= createTransform({
                db,
                tagger,
                scheduler: createScheduler({
                    executeThresholdPercentage: config.execute_threshold_percentage,
                    executeThresholdTokens: config.execute_threshold_tokens,
                }),
                contextUsageMap: usage,
                compactionOff,
                // OpenCode 2 reads `session_message`, which numbers the same
                // conversation differently from the v1 tables a converted store
                // still carries.
                storeGeneration: "v2",
                // GA owns its native checkpoints; this adapter never writes the v1
                // synthetic marker rows that the shared off-transition deletes.
                hostCleanupCompactionMarkers: () => ({
                    verified: true,
                    removedLineages: 0,
                    removedRows: 0,
                    retainedLineages: 0,
                }),
                protectedTokens: config.protected_tokens,
                protectedTokenTierOverrides: getProtectedTokensTierOverrides(config),
                executeThresholdPercentage: config.execute_threshold_percentage,
                executeThresholdTokens: config.execute_threshold_tokens,
                liveModelBySession: liveModels,
                getToolSetHash: (sessionId) => {
                    const model = liveModels.get(sessionId);
                    if (!model) return "";
                    return getCurrentToolSetHash(
                        model.providerID,
                        model.modelID,
                        agents.get(sessionId),
                    );
                },
                channel1StateBySession: channel1,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                variantBySession: variants,
                clearReasoningAge: config.clear_reasoning_age,
                directory,
                sessionDirectoryBySession: sessionDirectories,
                projectPath: directory,
                hiddenCompletionExecutor,
                historianRunnable:
                    !compactionOff &&
                    hiddenCompletionExecutor !== undefined &&
                    config.historian?.disable !== true,
                historianModel: historianModels.primary,
                fallbackModels: historianModels.fallbacks,
                resolveHistorianRun: sampleHistorian,
                historianTimeoutMs: config.historian_timeout_ms,
                // Raw config on purpose: absent means the user configured no
                // output cap, and the hidden carrier only puts a cap on the wire
                // when one was configured. The producer-window arithmetic applies
                // its own default, so no fallback belongs here.
                historianMaxOutputTokens: config.historian?.maxTokens,
                historianTwoPass: config.historian?.two_pass,
                historianRunner: config.historian?.runner,
                historianHostRunnerEnabled: config.historian?.host_runner?.enabled,
                // TypeScript mode folds on the host's own compaction rows, so its marker
                // carrier stays inert. Rust mode has no such row to write: the module's
                // materialized boundary is recorded in the marker columns instead, and
                // the compaction hook above answers the host from it.
                compactionMarkerStrategy: rustModeModuleClient
                    ? createV2RustCompactionMarkerStrategy((sessionID, endMessageID) => {
                          const reader = openStoreReader();
                          try {
                              return resolveV2BoundaryUserMessage(reader, sessionID, endMessageID);
                          } finally {
                              reader.close();
                          }
                      })
                    : v2CompactionMarkerStrategy,
                transformMode: config.transform_mode,
                rustModeModuleClient,
                rustModeProjectRoot: directory,
                rustMemorySyncRequestedSessions,
                // OpenCode 1 puts this on the host's toast surface through its SDK
                // client. This host exposes no such client to a plugin, so it goes
                // out on the notification socket the TUI already reads — the same
                // carrier a finished dream reports on. Without it a parked module
                // is invisible: the session keeps answering from the last good
                // output and nothing says why it stopped moving.
                onRustModeParked: (sessionId, message) =>
                    pushNotification(
                        "toast",
                        { message: `Rust Magic Context paused: ${message}`, variant: "warning" },
                        sessionId,
                    ),
                // A session can resolve a project other than the launch directory,
                // so the note-evaluation bridge is ensured per prepared project
                // rather than once at setup.
                onRustModeProjectPrepared: (projectPath) =>
                    moduleToolBackends?.ensureNoteEvaluationBridge(projectPath),
                promptSurface: config.prompt_surface,
                promptSurfaceRuntime,
                onRustEngineReconnectRefusal: (refusal) => rustRefusalRecovery?.arm(refusal),
                memoryConfig: {
                    enabled: config.memory.enabled,
                    injectionBudgetTokens: config.memory.injection_budget_tokens,
                    autoPromote: config.memory.auto_promote,
                },
                ...createHostSeams(context, readAllForConversion, pagedRead, liveModels),
            });
            const admitted = new Set<string>();
            for (const message of draft.messages) {
                if (message.id && (await isAdmittedSynthetic(context, draft.sessionID, message.id)))
                    admitted.add(message.id);
            }
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            let checkpoint: SessionContext["messages"][number] | undefined;
            let submitted: string | undefined;
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
                    // Rust mode restores against the boundary the module itself published and
                    // keeps that boundary row, because the array handed to the module has to
                    // begin there — exactly where an OpenCode 1 compaction row would have made
                    // the host begin it. TypeScript mode restores after its own m0 baseline.
                    const moduleBoundaryID = rustModeModuleClient
                        ? (getPersistedCompactionMarkerState(db, draft.sessionID)
                              ?.boundaryMessageId ?? null)
                        : null;
                    const moduleBoundarySeq = moduleBoundaryID
                        ? reader.sequenceForId(draft.sessionID, moduleBoundaryID)
                        : undefined;
                    const boundaryID = (
                        db
                            .prepare(
                                "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
                            )
                            .get(draft.sessionID) as { id: string | null } | null
                    )?.id;
                    // Restore only rows after the cached message prefix and before the host
                    // checkpoint; older rows are already present in the cached messages. The
                    // first fold has no cached prefix, so it starts immediately before the
                    // first retained seq instead of using an unbounded seq-zero scan.
                    // A boundary on a row the host never serves by id (an instruction
                    // update) stands for the nearest earlier served row. Restoring from
                    // that row keeps the unserved rows after it in the raw tail, the
                    // same cut the transform's trim makes, so a priced pass and the
                    // defers after it restore identical rows.
                    const servedBoundary = boundaryID
                        ? servedBoundaryRow(reader, draft.sessionID, boundaryID)
                        : null;
                    const boundary =
                        (moduleBoundarySeq !== undefined ? moduleBoundarySeq - 1 : undefined) ??
                        servedBoundary?.seq ??
                        reader.sequenceForId(draft.sessionID, boundaryID) ??
                        (reader.earliestSequence(draft.sessionID) ?? 0) - 1;
                    if (moduleBoundarySeq !== undefined)
                        sessionLog(
                            draft.sessionID,
                            `v2 restore: from the module boundary ${moduleBoundaryID} to the host checkpoint`,
                        );
                    const present = new Set(draft.messages.map((message) => message.id));
                    const restored = restoredRows
                        .rows(reader, draft.sessionID, boundary, cut.seq)
                        .filter((row) => !present.has(row.id))
                        .flatMap((row) =>
                            restoreRow(
                                row,
                                draft.model,
                                hostUsesMediaAssets()
                                    ? {
                                          asset: hostMediaAsset,
                                          unavailable: (detail) =>
                                              sessionLog(
                                                  draft.sessionID,
                                                  `v2 restore: attachment replaced by a note row=${detail.rowID} name=${JSON.stringify(detail.name ?? null)} mediaType=${detail.mediaType} reason=${JSON.stringify(detail.reason)}`,
                                              ),
                                      }
                                    : undefined,
                            ),
                        );
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
            // On a turn the host did not compact, the array still starts at the top
            // of the conversation, and the module would be handed the whole history
            // again — the cost the fold exists to remove. On a turn it did compact,
            // the boundary message is already gone from the array and this is a
            // no-op. Both happen in an ordinary session.
            if (rustModeModuleClient && db) {
                const dropped = trimToRecordedBoundary(db, draft.sessionID, draft.messages);
                if (dropped > 0)
                    sessionLog(
                        draft.sessionID,
                        `v2 boundary trim: dropped ${dropped} messages before the module boundary`,
                    );
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
            if (isBlockingV2TransformError(error)) {
                // These errors mean the shared transform cannot prove a safe prompt.
                // Native compaction owns recovery when Magic Context compaction is off.
                if (!compactionOff) {
                    await refuseBeforeProvider(
                        context.session,
                        draft.sessionID,
                        "blocking-transform-error",
                        error,
                    );
                    throw new V2ContextRefusal("Magic Context refused to send an unsafe prompt.", {
                        cause: error,
                    });
                }
                console.warn(
                    "[magic-context] compaction-off: fail-closed inert, passing through",
                    error,
                );
            } else if (postFold) {
                await refuseBeforeProvider(
                    context.session,
                    draft.sessionID,
                    "post-fold-restore",
                    error,
                );
                throw new V2ContextRefusal(
                    "Magic Context could not restore the unarchived host history.",
                    { cause: error },
                );
            } else {
                // Another plugin can poison the shared draft. Do not fail an otherwise viable turn.
                console.warn("[magic-context] v2 context unavailable", error);
            }
        }
    });
    // Warm eagerly for cold sidebar/status reads; a failed startup warm releases
    // its latch and the context hook above retries after the host catalog settles.
    void warmModelLimitCacheFromCatalog(context);
    // OpenCode 2 never runs the v1 server() lane. Start the RPC surface here so
    // the terminal TUI can read the v2 lane's draft-authoritative session state.
    const rpcLiveSessionState = createV2RpcLiveSessionState({
        liveModelBySession: liveModels,
        variantBySession: variants,
        agentBySession: agents,
        channel1StateBySession: channel1,
        historyRefreshSessions,
        pendingMaterializationSessions,
        systemPromptRefreshSessions,
        sessionDirectoryBySession: sessionDirectories,
    });
    const storageDir = getMagicContextStorageDir();
    const rpcServer = new MagicContextRpcServer(storageDir, directory);
    let rpcStopped = false;
    registerRpcHandlers(rpcServer, {
        directory,
        config,
        client: undefined,
        liveSessionState: rpcLiveSessionState,
        rustModeModuleClient,
        hiddenCompletionExecutor,
        storageDir,
    });
    // The v2 TUI reaches manual dreaming through RPC because this host has no
    // command-template path. The run continues in the background and reports its
    // result through the notification socket.
    const manualDreamer =
        config.dreamer && config.dreamer.disable !== true ? config.dreamer : undefined;
    rpcServer.handle("dream", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        if (!manualDreamer || !hiddenCompletionExecutor) {
            pushNotification(
                "toast",
                { message: "Dreaming is not configured for this project.", variant: "warning" },
                sessionId,
            );
            return { ok: false, error: "dreamer unavailable" };
        }
        const requested = resolveManualDreamTask(params.task);
        if (requested.error) {
            pushNotification("toast", { message: requested.error, variant: "warning" }, sessionId);
            return { ok: false, error: requested.error };
        }
        db ??= openDatabase();
        if (!db || !isDatabasePersisted(db)) {
            pushNotification(
                "toast",
                {
                    message: "Dreaming is unavailable: context storage is not durable.",
                    variant: "error",
                },
                sessionId,
            );
            return { ok: false, error: "storage unavailable" };
        }
        const runDb = db;
        const runExecutor = hiddenCompletionExecutor;
        void runManualDreamNow({
            db: runDb,
            dreamer: manualDreamer,
            projectIdentity: resolveProjectIdentity(directory) ?? directory,
            directory,
            language: config.language,
            mural: config.mural,
            executor: runExecutor,
            sessionId,
            ...(requested.task !== undefined ? { task: requested.task } : {}),
        })
            .then(({ summary, unsupportedTasks }) => {
                // When an explicitly requested task is unsupported, omit the
                // otherwise misleading "No enabled dream tasks" empty summary.
                const hasSummaryContent =
                    summary.ran.length > 0 ||
                    summary.failed.length > 0 ||
                    summary.skippedNoWork.length > 0 ||
                    summary.deferredBusy.length > 0 ||
                    Object.keys(summary.backlogBefore ?? {}).length > 0 ||
                    Object.keys(summary.backlogAfter ?? {}).length > 0;
                const message = [
                    hasSummaryContent || unsupportedTasks.length === 0
                        ? summarizeManualDream(summary)
                        : undefined,
                    unsupportedTasks.length > 0
                        ? [
                              renderUserFacingFailure("dream_task_needs_tool_loop", "plain"),
                              formatUnsupportedDreamTasks(
                                  unsupportedTasks,
                                  userFacingFailureCode("dream_task_needs_tool_loop"),
                              ),
                          ].join("\n")
                        : undefined,
                ]
                    .filter((line) => line !== undefined)
                    .join("\n\n");
                pushNotification(
                    "action",
                    {
                        action: "show-result-dialog",
                        title: "Magic Context dream run",
                        message,
                    },
                    sessionId,
                );
            })
            .catch((error) => {
                pushNotification(
                    "toast",
                    { message: `Dream run failed: ${getErrorMessage(error)}`, variant: "error" },
                    sessionId,
                );
            });
        return { ok: true };
    });
    // Server-side command registration: this is what makes /ctx-* reachable from
    // `opencode run`, the HTTP API and Desktop rather than only from the terminal
    // UI's own keymap.
    await registerV2Commands({
        command: context.command,
        rpc: rpcServer,
        directory,
        compactionEnabled: !compactionOff,
    });
    // Start the RPC server asynchronously after plugin construction returns so
    // Bun.serve and its discovery-file write do not consume the host's deadline.
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
            tools?.dispose();
            usageController.abort();
            await usageDone;
            deletedSessions.clear();
            await dreamTrigger?.dispose();
            for (const release of rawProviders.values()) release();
            rawProviders.clear();
            restoredRows.clear();
        },
    };
}
