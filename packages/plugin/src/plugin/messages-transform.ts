import type { CheckoutClaimGate } from "../features/magic-context/checkout-claim";
import {
    type FailClosedController,
    isFailClosedBlockingError,
    resolveAgentNameFromMessages,
    shouldBypassFailClosedBlock,
} from "../features/magic-context/fail-closed-block";
import { getOrCreateSessionMeta, openDatabase } from "../features/magic-context/storage";
import { getSchemaFenceRejection } from "../features/magic-context/storage-db";
import {
    getOverflowState,
    isEmergencyRecoveryArmed,
    isProviderOverflowFailClosedProven,
} from "../features/magic-context/storage-meta-persisted";
import { updateSessionMeta } from "../features/magic-context/storage-meta-session";
import { DegradedPassRefusalError } from "../hooks/magic-context/degraded-pass-refusal";
import { EmergencyFailClosedError } from "../hooks/magic-context/emergency-fail-closed";
import { replayLkg, resolveLkgModelKeys } from "../hooks/magic-context/lkg-replay";
import { lkgReplayFits, lkgReplayLimit } from "../hooks/magic-context/lkg-replay-fit";
import { dropSlot, getSlot, noteEntry } from "../hooks/magic-context/lkg-slot";
import { RawFallbackContextLimitError } from "../hooks/magic-context/raw-fallback-context-limit";
import {
    noteExternalLkgReplay,
    type RustLkgReplayParticipant,
    resolveRustLkgReplayParticipant,
} from "../hooks/magic-context/rust-lkg-freeze-registry";
import { StorageBusyRefusalError } from "../hooks/magic-context/storage-busy-refusal";
import type { MessageLike } from "../hooks/magic-context/transform-operations";
import { replayRustModeBindingMismatchStrips } from "../hooks/magic-context/transform-postprocess-phase";
import { UnmanagedOverWindowError } from "../hooks/magic-context/unmanaged-over-window";
import { UnresolvedHistoryBoundaryError } from "../hooks/magic-context/unresolved-history-boundary";
import { log, sessionLog } from "../shared/logger";
import {
    isTransientSqliteError,
    withAsyncPrivilegedWriter,
    withSqliteTransformPass,
} from "../shared/sqlite";

export const ASSISTANT_TERMINAL_RETRY_MESSAGE =
    "The conversation ends with a completed assistant response and cannot be resubmitted as-is — send a new message to continue.";

export class AssistantTerminalRetryError extends Error {
    readonly code = "ASSISTANT_TERMINAL_RETRY";
    readonly recoverable = true;

    constructor() {
        super(ASSISTANT_TERMINAL_RETRY_MESSAGE);
        this.name = "AssistantTerminalRetryError";
    }
}

export class IncompleteUserMessageError extends Error {
    readonly code = "INCOMPLETE_USER_MESSAGE";
    readonly recoverable = true;

    constructor() {
        super("Your message hadn't finished arriving. Send it again.");
        this.name = "IncompleteUserMessageError";
    }
}

type MessageWithParts = {
    info: import("@opencode-ai/sdk").Message;
    parts: import("@opencode-ai/sdk").Part[];
};

type MessagesTransformOutput = { messages: MessageWithParts[] };

type MagicContextTransformHooks = {
    "experimental.chat.messages.transform"?: ((
        input: Record<string, never>,
        output: MessagesTransformOutput,
    ) => Promise<void>) & {
        isProviderSession?: (sessionId: string) => boolean;
        recoverProviderOutput?: (sessionId: string, output: { messages: unknown[] }) => boolean;
    };
} | null;

function replaceMessagesInPlace(output: MessagesTransformOutput, next: MessageWithParts[]): void {
    if (output.messages !== next) output.messages.splice(0, output.messages.length, ...next);
}

const ASSISTANT_METADATA_PART_TYPES = new Set([
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "subtask",
    "compaction",
]);

function assistantHasCompletedContent(message: MessageWithParts): boolean {
    return message.parts.some((part) => {
        const value = part as unknown as Record<string, unknown>;
        const type = typeof value.type === "string" ? value.type : "";
        if (ASSISTANT_METADATA_PART_TYPES.has(type)) return false;
        if (type === "text") return typeof value.text !== "string" || value.text.trim().length > 0;
        return true;
    });
}

function findLatestUserIndex(messages: readonly MessageWithParts[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].info.role === "user") return index;
    }
    return -1;
}

function moveUserToTail(
    messages: MessageWithParts[],
    user: MessageWithParts,
    userIndex: number,
): void {
    if (userIndex >= 0) messages.splice(userIndex, 1);
    messages.push(user);
}

function enforcePersistedUserTerminatedTail(messages: MessageWithParts[]): void {
    if (messages.at(-1)?.info.role !== "assistant") return;
    const userIndex = findLatestUserIndex(messages);
    const trailing = messages.slice(userIndex + 1);
    if (
        userIndex < 0 ||
        trailing.some(
            (message) => message.info.role !== "assistant" || assistantHasCompletedContent(message),
        )
    ) {
        // An assistant with real content at the array tail is OpenCode's NORMAL
        // mid-turn continuation shape: tool results ride as parts on the streaming
        // assistant, and the provider serializer emits the user-terminated wire
        // itself. Leave the array untouched — refusing (or reordering) here kills
        // every tool-using turn at its first continuation pass.
        return;
    }
    moveUserToTail(messages, messages[userIndex], userIndex);
}

/**
 * Role the provider request will end with once OpenCode serializes `messages`:
 * an assistant's tool parts become a trailing tool-result (user) turn, so only
 * an assistant carrying none of them ends the request as an assistant.
 */
function wireTailRole(messages: readonly MessageWithParts[]): "user" | "assistant" | "none" {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info.role === "user") return "user";
        if (!assistantHasCompletedContent(message)) continue;
        return message.parts.some((part) => (part as { type?: unknown }).type === "tool")
            ? "user"
            : "assistant";
    }
    return "none";
}

/**
 * Diagnostic backstop: models without assistant prefill support reject a request
 * that ends with an assistant turn, and the provider error does not say which
 * transform produced it. Log when this pass turned a user-terminated array into
 * an assistant-terminated one so a report carries the evidence.
 */
function reportAssistantTerminatedTail(
    messages: readonly MessageWithParts[],
    inputTailRole: ReturnType<typeof wireTailRole>,
    sessionId: string | null,
): void {
    if (inputTailRole !== "user" || wireTailRole(messages) !== "assistant") return;
    const tail = messages
        .slice(-3)
        .map(
            (message) =>
                `${message.info.role}:${message.parts.map((part) => (part as { type?: unknown }).type).join("+")}`,
        )
        .join(", ");
    const line = `transform produced an assistant-terminated request (input was user-terminated); providers without prefill support will reject it. tail=[${tail}]`;
    if (sessionId) sessionLog(sessionId, line);
    else log(`[magic-context] ${line}`);
}

function preserveUserTerminatedTail(
    messages: MessageWithParts[],
    inputMessages: readonly MessageWithParts[],
): void {
    const inputTail = inputMessages.at(-1);
    if (inputTail?.info.role !== "user" || messages.at(-1)?.info.role !== "assistant") return;

    let userIndex = messages.lastIndexOf(inputTail);
    if (userIndex < 0) {
        const inputId = inputTail.info.id;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message.info.role === "user" && message.info.id === inputId) {
                userIndex = index;
                break;
            }
        }
    }

    const originalIds = new Set(inputMessages.map((message) => message.info.id));
    const trailing =
        userIndex >= 0
            ? messages.slice(userIndex + 1)
            : messages.filter((message) => !originalIds.has(message.info.id));
    // Historical assistants before the input user keep their causal position. Only content
    // appended after that user participates in the race discriminator: blank/error shells
    // may move before it, while completed model output must never be moved below its prompt.
    if (
        trailing.some(
            (message) => message.info.role !== "assistant" || assistantHasCompletedContent(message),
        )
    ) {
        // Real model output landed after the input user mid-transform. Moving the
        // user below its own answer would rewrite causality, and refusing would
        // fail a turn that the provider serializer handles correctly — so leave
        // the array exactly as OpenCode built it.
        return;
    }
    moveUserToTail(messages, userIndex >= 0 ? messages[userIndex] : inputTail, userIndex);
}

class LkgAdmissionReplay extends Error {}

/** Replay a validated saved request that fits, before a writer retry or after a failed transform. */
export function tryMessagesTransformLkgReplay(args: {
    output: MessagesTransformOutput;
    sessionId: string;
    error: unknown;
    rust?: RustLkgReplayParticipant;
    agent?: string;
    onLkgReplay?: () => void;
    entry?: ReturnType<typeof noteEntry> | null;
    /** Host-owned envelope validation, before adopting any saved messages. */
    replayFits?: (messages: MessageLike[]) => boolean;
}): boolean {
    const { output, sessionId, error, agent } = args;
    const slotAtEntry = getSlot(sessionId);
    let entry = args.entry;
    if (entry === undefined && slotAtEntry) {
        try {
            entry = noteEntry(sessionId, output.messages as MessageLike[]);
        } catch {
            entry = null;
        }
    }
    if (sessionId && slotAtEntry && !entry) {
        dropSlot(sessionId, "lkg_invalidated_reshape");
        sessionLog(sessionId, "lkg_invalidated_reshape");
    } else if (sessionId && entry) {
        let replayBlocked = false;
        try {
            const db = openDatabase();
            // In Rust mode the adapter tracks whether the session is serving a frozen
            // replay, and it only replays when the replay fits the context limit.
            // A replay served here must update that tracking and pass the same check.
            const rust = args.rust;
            if (
                (error instanceof StorageBusyRefusalError &&
                    error.stage === "rust-mode-emergency") ||
                rust?.emergencyFailClosed(sessionId, output.messages as MessageLike[])
            ) {
                // The adapter refused while failing closed (usage at or above 95%
                // of the model's limit, or a proven provider overflow); there it
                // admits no last-known-good replay, so serving one here would
                // bypass its refusal.
                replayBlocked = true;
                sessionLog(sessionId, "lkg_emergency_band_refused");
            } else if (
                !db ||
                isEmergencyRecoveryArmed(sessionId) ||
                getOverflowState(db, sessionId).needsEmergencyRecovery
            ) {
                replayBlocked = true;
                sessionLog(sessionId, "lkg_emergency_armed");
            } else {
                const inputMessages = output.messages as MessageLike[];
                const inputCount = inputMessages.length;
                const keys = resolveLkgModelKeys(inputMessages);
                const replay = replayLkg({
                    sessionId,
                    messages: inputMessages,
                    modelKey: keys.modelKey,
                    providerKey: keys.providerKey,
                    entry,
                    prepareReplay: (messages) =>
                        rust
                            ? rust.stripPersistedReasoning(sessionId, messages, inputMessages)
                            : replayRustModeBindingMismatchStrips({
                                  db,
                                  sessionId,
                                  messages,
                                  resolvedProviderID: keys.providerKey ?? undefined,
                              }),
                });
                // TypeScript mode has no Rust result to check, but replaying
                // the saved request for a known model still has to pass the
                // same fit check as Rust mode: measured size of the saved
                // request plus an estimate for the messages added since.
                let tsFit = true;
                if (replay.ok && !rust && keys.providerKey && keys.modelKey) {
                    const model = {
                        providerID: keys.providerKey,
                        modelID: keys.modelKey.slice(keys.providerKey.length + 1),
                    };
                    if (
                        lkgReplayLimit({
                            db,
                            sessionId,
                            model,
                            modelKey: keys.modelKey,
                        }) !== undefined
                    ) {
                        const fit = lkgReplayFits({
                            db,
                            sessionId,
                            messages: replay.messages,
                            model,
                            modelKey: keys.modelKey,
                            systemPromptTokens: getOrCreateSessionMeta(db, sessionId)
                                .systemPromptTokens,
                            agentName: agent,
                        });
                        tsFit = fit.fits;
                        if (!fit.fits && fit.detail) sessionLog(sessionId, fit.detail);
                    }
                }
                if (
                    replay.ok &&
                    (!tsFit ||
                        args.replayFits?.(replay.messages) === false ||
                        (rust && !rust.replayFits(sessionId, replay.messages, inputMessages)))
                ) {
                    replayBlocked = true;
                    sessionLog(sessionId, "lkg_replay_does_not_fit");
                } else if (replay.ok) {
                    args.onLkgReplay?.();
                    replaceMessagesInPlace(
                        output,
                        replay.messages as unknown as MessageWithParts[],
                    );
                    // The provider has now cached the replayed bytes. Tell a Rust
                    // adapter, so its next successful pass keeps serving them instead
                    // of switching to module output, which would bust that cache.
                    noteExternalLkgReplay(rust, sessionId, inputCount);
                    sessionLog(sessionId, "lkg_replay_served");
                    return true;
                } else {
                    sessionLog(sessionId, replay.reason);
                }
            }
        } catch (replayError) {
            replayBlocked = true;
            sessionLog(sessionId, "lkg_replay_unavailable", replayError);
        }
        if (replayBlocked) {
            sessionLog(sessionId, "lkg_replay_declined");
        }
    } else if (sessionId) {
        sessionLog(sessionId, "lkg_miss");
    }
    return false;
}

/**
 * Top-level transform wrapper. Every failed managed pass replays the
 * last-known-good (LKG) request or refuses the turn.
 *
 * Error handling is tiered:
 *
 * - **FailClosedBlockingError / EmergencyFailClosedError / RawFallbackContextLimitError /
 *   AssistantTerminalRetryError**: Intentional loud aborts. Rethrown so the terminal UI surfaces the
 *   message and the turn does not silently fall through to native compaction or a
 *   provider-rejected raw prompt.
 *
 * - **SQLITE_BUSY / SQLITE_LOCKED**: Try validated LKG before backing off on
 *   writer acquisition. Replay or refuse; never retry the mutating transform.
 *
 * - **UnresolvedHistoryBoundaryError / UnmanagedOverWindowError / DegradedPassRefusalError**: The pass
 *   could not produce a request that is safe to send. Replay LKG or refuse.
 *
 * - **Non-BUSY errors**: Schema corruption, programming bugs, type errors.
 *   These can silently disable magic-context for the entire session if the
 *   error repeats on every pass. We:
 *     1. Log with full detail (code, name, message, stack).
 *     2. Persist a short error summary into `session_meta.last_transform_error`
 *        so the sidebar/dashboard surfaces the failure state. The sidebar
 *        already reads this field; runPostTransformPhase's catch only fires
 *        for errors that reach it, and an error thrown early enough bypasses
 *        it entirely. Writing it here at the outer boundary guarantees
 *        observability.
 *     3. Refuse if LKG could not replay. A small raw request is still unsafe:
 *        it omits persisted decisions and changes the provider's cached prefix.
 *        Only compaction-off mode passes the input through on failure.
 *
 * The transform is not assumed idempotent: only transaction acquisition retries.
 */
export function createMessagesTransformHandler(args: {
    magicContext: MagicContextTransformHooks;
    /**
     * Optional live getter so a healed storage reopen can swap in real hooks
     * without rebuilding the outer wrapper.
     */
    getMagicContext?: () => MagicContextTransformHooks;
    failClosed?: FailClosedController | null;
    failClosedBlockingEnabled?: boolean;
    /**
     * Compaction-off mode (issue #266): the fail-closed BLOCKING wrapper is
     * inert BY DESIGN — MC inoperability no longer risks unbounded growth
     * because native compaction (or nothing) owns the window. A thrown or
     * failed transform degrades to passthrough of the input messages: no
     * blocking message, no cancelled request, one diagnostic. The enforce
     * call still runs (its re-probe can heal storage mid-process), but any
     * error it raises is converted to passthrough here.
     */
    compactionOff?: boolean;
    onStorageBusyRefusal?: (sessionId: string, message: string) => Promise<void>;
    /** Fit saved messages against the host's current tools and paired system prompt. */
    replayFits?: (messages: MessageLike[]) => boolean;
    /** Validate and restore host-owned prompt segments before adopting replayed messages. */
    onLkgReplay?: () => void;
    internalChildSessions?: Set<string>;
    tryReopenStorage?: () => boolean | Promise<boolean>;
    /**
     * The Rust adapter of this wrapper's own plugin instance, or null when the
     * instance runs in TypeScript mode. When omitted, the process-wide replay
     * registry picks the adapter (the one that most recently ran the session).
     */
    rustReplayParticipant?: () => RustLkgReplayParticipant | null | undefined;
    /**
     * The checkout claim check, run before anything in the pass can write. A
     * session whose agent another machine holds is refused here, in every mode
     * (compaction-off included): passing it through would let this machine keep
     * working on an agent it does not hold.
     */
    checkoutClaim?: {
        gate: Pick<CheckoutClaimGate, "refusal">;
        projectRoot: string;
        /** Tells the user before the refusal is thrown (the host shows a thrown error tersely). */
        onRefusal?: (sessionId: string, message: string) => Promise<void>;
    };
}): (input: Record<string, never>, output: MessagesTransformOutput) => Promise<MessageWithParts[]> {
    const resolveRust = (sessionId: string): RustLkgReplayParticipant | undefined =>
        args.rustReplayParticipant
            ? (args.rustReplayParticipant() ?? undefined)
            : resolveRustLkgReplayParticipant(sessionId);
    const run = async (input: Record<string, never>, output: MessagesTransformOutput) => {
        const sessionId = resolveSessionId(output);
        const agent = resolveAgentNameFromMessages(output.messages);
        const isInternalChild =
            typeof sessionId === "string" &&
            sessionId.length > 0 &&
            args.internalChildSessions?.has(sessionId) === true;
        // Magic Context's own child sessions belong to no agent; every other
        // session is checked once per cache period before the pass writes.
        if (args.checkoutClaim && sessionId && !isInternalChild) {
            const refusal = await args.checkoutClaim.gate.refusal(
                sessionId,
                args.checkoutClaim.projectRoot,
            );
            if (refusal) {
                if (args.checkoutClaim.onRefusal) {
                    try {
                        await args.checkoutClaim.onRefusal(sessionId, refusal.message);
                    } catch (noticeError) {
                        log("[magic-context] checkout-claim host refusal failed:", noticeError);
                    }
                }
                throw refusal;
            }
        }
        // Snapshot only the array, never nested messages: compaction-off gates
        // every stage that writes retained message internals, and its additive
        // path only prepends new synthetic message objects. A shallow snapshot
        // can therefore restore the exact input without a hot-path deep clone.
        // Proxy-guarded success and failure tests enforce that retained inputs
        // stay read-only.
        const compactionOffInputSnapshot = args.compactionOff ? [...output.messages] : null;
        const restoreCompactionOffInput = (): void => {
            if (compactionOffInputSnapshot && output.messages !== compactionOffInputSnapshot) {
                output.messages.splice(0, output.messages.length, ...compactionOffInputSnapshot);
            }
        };

        if (args.failClosed) {
            try {
                await args.failClosed.enforce({
                    blockingEnabled: args.failClosedBlockingEnabled !== false,
                    exempt: shouldBypassFailClosedBlock({
                        agent,
                        isInternalChildSession: isInternalChild,
                    }),
                    tryReopen: args.tryReopenStorage,
                });
            } catch (error) {
                // Compaction-off: fail_closed_blocking is inert BY DESIGN. A
                // storage-unavailable gate that would otherwise throw (blocking
                // the turn) degrades to passthrough of the input messages: no
                // blocking message, no cancelled request, one diagnostic. The
                // inner transform is skipped because storage is unavailable;
                // the harness proceeds on the unmodified input.
                if (args.compactionOff && isFailClosedBlockingError(error)) {
                    log(
                        `[magic-context] compaction-off: fail-closed inert, passing through: ${error.message}`,
                    );
                    restoreCompactionOffInput();
                    return output.messages;
                }
                throw error;
            }
        }

        const magicContext = args.getMagicContext ? args.getMagicContext() : args.magicContext;
        const provider = magicContext?.["experimental.chat.messages.transform"];
        const providerAtEntry = sessionId
            ? provider?.isProviderSession?.(sessionId) === true
            : false;
        const captureEntry = (): ReturnType<typeof noteEntry> => {
            if (
                !sessionId ||
                providerAtEntry ||
                provider?.isProviderSession?.(sessionId) ||
                !getSlot(sessionId)
            )
                return null;
            try {
                return noteEntry(sessionId, output.messages as MessageLike[]);
            } catch (error) {
                sessionLog(sessionId, "lkg entry snapshot failed; replay unavailable", error);
                return null;
            }
        };
        let entry = captureEntry();
        let admissionRetried = false;
        try {
            if (magicContext) {
                const admissionDb = openDatabase();
                if (admissionDb) {
                    if (!args.compactionOff) {
                        await withAsyncPrivilegedWriter(admissionDb, () => undefined, {
                            beforeRetry: (error) => {
                                admissionRetried = true;
                                entry = captureEntry();
                                if (
                                    sessionId &&
                                    !providerAtEntry &&
                                    !provider?.isProviderSession?.(sessionId) &&
                                    tryMessagesTransformLkgReplay({
                                        output,
                                        sessionId,
                                        error,
                                        entry,
                                        rust: resolveRust(sessionId),
                                        agent,
                                        replayFits: args.replayFits,
                                        onLkgReplay: args.onLkgReplay,
                                    })
                                )
                                    throw new LkgAdmissionReplay();
                            },
                        });
                    }
                } else {
                    const fence = getSchemaFenceRejection();
                    if (fence) {
                        // Another process migrated context.db past the newest schema this
                        // build supports. The inner transform writes through the handle this
                        // process cached at startup, so running it would write rows the newer
                        // schema no longer reads the same way. Refuse the pass instead, the
                        // way boot refuses a database it cannot open.
                        log(
                            `[magic-context] schema fence on a cached handle: database v${fence.persistedVersion} is newer than this build supports (v${fence.supportedVersion}); refusing to transform`,
                        );
                        if (args.compactionOff) {
                            restoreCompactionOffInput();
                            return output.messages;
                        }
                        if (args.failClosed) {
                            args.failClosed.arm({ kind: "schema_fence", ...fence });
                            await args.failClosed.enforce({
                                blockingEnabled: args.failClosedBlockingEnabled !== false,
                                exempt: shouldBypassFailClosedBlock({
                                    agent,
                                    isInternalChildSession: isInternalChild,
                                }),
                                tryReopen: args.tryReopenStorage,
                            });
                        }
                        return output.messages;
                    }
                }
            }
            // A yielded writer wait can let the host reshape history. Preserve
            // the new pre-transform entry for recovery, not the pre-wait one.
            if (admissionRetried) entry = captureEntry();
            await magicContext?.["experimental.chat.messages.transform"]?.(input, output);
            return output.messages;
        } catch (error) {
            if (error instanceof LkgAdmissionReplay) return output.messages;
            if (sessionId && (providerAtEntry || provider?.isProviderSession?.(sessionId))) {
                // The durable runner record is the provider session's only replay.
                // Explicit turn refusals must not be bypassed by any replay.
                if (
                    error instanceof EmergencyFailClosedError ||
                    (error as { code?: string })?.code === "store_ahead_of_binary"
                )
                    throw error;
                if (provider?.recoverProviderOutput?.(sessionId, output)) return output.messages;
                throw new EmergencyFailClosedError("Provider record cannot recover this turn", {
                    cause: error,
                });
            }
            if (
                error instanceof RawFallbackContextLimitError ||
                error instanceof AssistantTerminalRetryError
            ) {
                throw error;
            }
            if (error instanceof EmergencyFailClosedError || isFailClosedBlockingError(error)) {
                if (!args.compactionOff) throw error;
                // Inert by design: log a diagnostic and hand the harness back its
                // own messages unchanged.
                log(
                    `[magic-context] compaction-off: fail-closed inert, passing through: ${error instanceof Error ? error.message : String(error)}`,
                );
                restoreCompactionOffInput();
                return output.messages;
            }
            if (
                !args.compactionOff &&
                !isTransientSqliteError(error) &&
                sessionId &&
                isProviderOverflowFailClosedProven(sessionId)
            ) {
                throw new EmergencyFailClosedError(
                    "Emergency recovery transform failed; refusing an unbounded raw fallback",
                    { cause: error },
                );
            }
            if (args.compactionOff) {
                // Skip the LKG replay entirely: the contract for this mode is
                // "return the input messages unmodified", never a cached
                // transformed array.
                restoreCompactionOffInput();
            } else if (
                sessionId &&
                tryMessagesTransformLkgReplay({
                    output,
                    sessionId,
                    error,
                    entry,
                    rust: resolveRust(sessionId),
                    agent,
                    replayFits: args.replayFits,
                    onLkgReplay: args.onLkgReplay,
                })
            ) {
                return output.messages;
            }
            // The LKG replay above (the last request this session served
            // successfully) could not stand in, and the pass could not produce a
            // request that is safe to send: the untrimmed request does not fit
            // the window, or a stage the request depends on failed. Refuse the
            // turn rather than hand the provider a request it will reject (or,
            // on OpenCode 1, the raw input messages, which are just as large).
            if (
                !args.compactionOff &&
                (error instanceof UnresolvedHistoryBoundaryError ||
                    error instanceof UnmanagedOverWindowError ||
                    error instanceof DegradedPassRefusalError)
            ) {
                throw error;
            }
            const code = (error as { code?: string } | null)?.code;
            const name = (error as { name?: string } | null)?.name;
            const message = error instanceof Error ? error.message : String(error);
            const isTransient =
                isTransientSqliteError(error) || error instanceof StorageBusyRefusalError;
            if (isTransient) {
                if (!args.compactionOff) {
                    const refusal =
                        error instanceof StorageBusyRefusalError
                            ? error
                            : new StorageBusyRefusalError(error, "messages-transform");
                    if (sessionId && args.onStorageBusyRefusal) {
                        try {
                            await args.onStorageBusyRefusal(sessionId, refusal.message);
                        } catch (noticeError) {
                            log("[magic-context] storage-busy host refusal failed:", noticeError);
                        }
                    }
                    throw refusal;
                }
                log(
                    `[magic-context] transform skipped this pass — ${code} (transient; retrying next pass): ${message}`,
                );
                restoreCompactionOffInput();
                return output.messages;
            }

            // Persistent non-transient errors are the real risk: silent forever
            // disable unless we surface them. Persist to session_meta so the
            // sidebar shows an obvious failure indicator.
            log(
                `[magic-context] transform FAILED code=${code ?? "none"} name=${name ?? "none"}: ${message}. ${args.compactionOff ? "Compaction-off: passing through input." : "No last-good replay; refusing the turn."}`,
                error,
            );

            // Best-effort: surface the error in session_meta so users see
            // something is broken. We can only do this when we have a
            // session id — the output's first message carries it.
            const persistSessionId = resolveSessionId(output);
            if (persistSessionId) {
                try {
                    const db = openDatabase();
                    // null = storage unavailable (schema fence); nothing to persist to.
                    if (db) {
                        const summary = truncateError(name, code, message);
                        // Write-if-changed guard: when the same error repeats on
                        // every transform pass (e.g. persistent schema corruption),
                        // skip the DB write if lastTransformError already matches.
                        // Prevents needless WAL churn during degraded operation.
                        const current = getOrCreateSessionMeta(
                            db,
                            persistSessionId,
                        ).lastTransformError;
                        if (current !== summary) {
                            updateSessionMeta(db, persistSessionId, {
                                lastTransformError: summary,
                            });
                        }
                    }
                } catch (persistError) {
                    // Swallow — if we can't even write the error, we definitely
                    // can't recover. Next pass may succeed.
                    log("[magic-context] failed to persist transform error:", persistError);
                }
            }
            if (!args.compactionOff) {
                throw new DegradedPassRefusalError("messages-transform-failed", { cause: error });
            }
        }
        restoreCompactionOffInput();
        return output.messages;
    };

    return (input, output): Promise<MessageWithParts[]> =>
        withSqliteTransformPass(async () => {
            const tail = output.messages.at(-1);
            // OpenCode persists the user row before its parts. Refuse before any
            // transform or replay can turn that incomplete row into the old request.
            // ID-less injected heads and host summary rows are not arriving prompts.
            if (
                tail?.info.role === "user" &&
                tail.info.id &&
                !(tail.info as { summary?: boolean }).summary &&
                tail.parts.length === 0
            ) {
                throw new IncompleteUserMessageError();
            }
            const inputMessages = [...output.messages];
            // Read before the transform runs: it mutates the shared message objects.
            const inputTailRole = wireTailRole(output.messages);
            enforcePersistedUserTerminatedTail(output.messages);
            try {
                return await run(input, output);
            } finally {
                preserveUserTerminatedTail(output.messages, inputMessages);
                reportAssistantTerminatedTail(
                    output.messages,
                    inputTailRole,
                    resolveSessionId(output),
                );
            }
        });
}

function resolveSessionId(output: MessagesTransformOutput): string | null {
    for (const message of output.messages) {
        const sid = (message.info as { sessionID?: string } | undefined)?.sessionID;
        if (typeof sid === "string" && sid.length > 0) return sid;
    }
    return null;
}

function truncateError(
    name: string | undefined,
    code: string | undefined,
    message: string,
    maxLen = 240,
): string {
    const prefix = `${name ?? "Error"}${code ? ` [${code}]` : ""}: `;
    const budget = Math.max(20, maxLen - prefix.length);
    const trimmed = message.length > budget ? `${message.slice(0, budget)}…` : message;
    return `${prefix}${trimmed}`;
}
