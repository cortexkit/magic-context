import { buildMagicContextSection } from "../../agents/magic-context-prompt";
import { isPrefixBoundThinkingModel } from "../../features/magic-context/overflow-detection";
import { computeHardCacheExpired } from "../../features/magic-context/scheduler";
import {
    type ContextDatabase,
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { noteSystemPromptHashChange } from "../../features/magic-context/transform-decision-log";
import type { PluginContext } from "../../plugin/types";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { log, sessionLog } from "../../shared/logger";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import {
    createPromptSurfaceGuidanceEpochCache,
    createPromptSurfaceRuntime,
    systemPromptFingerprint,
} from "../../shared/prompt-surface-runtime";
import {
    ctxReduceSpawnPermissionReadNeeded,
    primeCtxReduceSpawnPermission,
    resolveCtxReduceAvailability,
    spawnAgentFromOpenCodeDb,
} from "./ctx-reduce-availability";
import { currentLkgRequestIdentity } from "./lkg-measured-request";
import { requestPendingMaterialization } from "./pending-materialization";
import { estimateTokens } from "./read-session-formatting";
import { systemPromptDates } from "./system-prompt-dates";
import { isHeldHeadForRequest, recordSystemPromptForRequest } from "./system-prompt-delivery";
import {
    describeSystemPromptChange,
    type SystemPromptSnapshot,
    snapshotSystemPrompt,
} from "./system-prompt-diagnostics";
import {
    persistSystemPromptStickyDate,
    readPersistedSystemPromptStickyDate,
} from "./system-prompt-sticky-date";

const MAGIC_CONTEXT_MARKER = "## Magic Context";
const SYSTEM_PROMPT_GUIDANCE_SEPARATOR = "\n\n";
// Module-scope caches are per-plugin-instance (one plugin process per OpenCode
// process) and accumulate session entries over the plugin's lifetime. Without
// cleanup on `session.deleted`, these maps grow unbounded. Exported so hook.ts
// can register a cleanup callback tied to the session-deleted lifecycle event.
/**
 * Clear all per-session cache entries the system-prompt handler maintains,
 * including the module-scope user-profile/key-files maps and the per-handler
 * sticky-date/cached-docs maps (the latter passed in via the cleanup handle).
 * Called from the session-deleted event path.
 */
export function clearSystemPromptHashSession(
    sessionId: string,
    handleMaps: {
        stickyDateBySession: Map<string, string>;
        cachedDocsBySession: Map<string, string | null>;
    },
): void {
    handleMaps.stickyDateBySession.delete(sessionId);
    handleMaps.cachedDocsBySession.delete(sessionId);
}

/**
 * Detect OpenCode's three native hidden agents by stable signature lines from
 * their built-in prompts (see `~/Work/OSS/opencode/packages/opencode/src/agent/
 * prompt/{title,summary,compaction}.txt`).
 *
 * These agents:
 *   - "title": runs once on the first user turn against `small_model` to
 *              generate a short session title.
 *   - "summary": pull-request-style description of work done in a session.
 *   - "compaction": OpenCode's own auto-compaction summarizer (orthogonal to
 *                   our historian — fires when users haven't disabled
 *                   `compaction.auto`).
 *
 * Magic Context skips ALL injection (guidance, project docs, user profile,
 * key files, sticky date, hash flush) when these agents fire — they don't
 * benefit from any of it and the extra prompt content is wasted spend on
 * what's typically a small/cheap model running a fixed single-shot job.
 *
 * Detection uses literal substrings rather than fuzzy matching so a small
 * upstream prompt edit doesn't silently disable the skip. If OpenCode ever
 * rewrites these prompts, our injection will resume — that's the correct
 * fail-open behavior (worse than ideal, but not broken).
 */
function isInternalOpenCodeAgent(systemPromptContent: string): boolean {
    return (
        // title.txt opens with this exact line
        systemPromptContent.includes(
            "You are a title generator. You output ONLY a thread title.",
        ) ||
        // summary.txt opens with this exact line
        systemPromptContent.includes(
            "Summarize what was done in this conversation. Write like a pull request description.",
        ) ||
        // compaction.txt opens with this exact line
        systemPromptContent.includes(
            "You are an anchored context summarization assistant for coding sessions.",
        ) ||
        // compaction.txt from OpenCode 1.18 on opens with this line instead
        systemPromptContent.includes(
            "You are a context summarization agent. You are given a conversation between a user and an agent.",
        )
    );
}

/**
 * Detect Magic Context's OWN hidden child agents by their system-prompt
 * openers. These children (historian/dreamer) load a fixed agent identity and
 * must NOT receive the MC guidance block — it's wasted spend and a
 * contradictory second identity frame ("You are Historian…" plus "You are the
 * user's long-term partner…").
 *
 * This is the timing-independent companion to the `internalChildSessions` flag:
 * the flag is set at `session.created` (may race the very first system.transform
 * by event-delivery latency), whereas this signature is present in the prompt
 * content on pass 1 with zero timing dependency.
 *
 * Literal substrings (not fuzzy) so an upstream prompt edit fails open (resumes
 * injection) rather than silently mis-detecting.
 */
export function isMagicContextInternalAgent(systemPromptContent: string): boolean {
    return (
        // HISTORIAN_AGENT
        systemPromptContent.includes(
            "You are Historian — the hippocampus of a long-running coding agent.",
        ) ||
        // Every dreamer task prompt (generic base + curate / maintain-docs /
        // review-user-memories / primer-investigator) shares this identity phrase,
        // so one substring covers them all even though their openers differ.
        systemPromptContent.includes("for the magic-context system")
    );
}

/**
 * Handle system prompt via experimental.chat.system.transform:
 *
 * 1. Inject generic magic-context guidance into the system prompt.
 *    Skips injection if guidance is already present (e.g., baked into the
 *    agent prompt by oh-my-opencode).
 *
 * 2. Detect system-prompt content or prompt-surface preset changes for
 *    cache-flush triggering. The hash transition is the semantic boundary at
 *    which queued operations can ride the same HARD fold.
 */
export function createSystemPromptHashHandler(deps: {
    db: ContextDatabase;
    dreamerEnabled: boolean;
    smartNotesEnabled?: boolean;
    /** When false (`memory.enabled: false`), the `<project-memory>` block is
     *  never injected, so ctx_memory guidance is dropped from the prompt and the
     *  ctx_memory tool is not registered. ctx_search guidance stays (it still
     *  recalls conversation + git commits). Default true. */
    memoryEnabled?: boolean;
    /** Optional language from user config for the main agent's generated text. */
    language?: string;
    promptSurface?: PromptSurfaceConfig;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    /** Recover the session's latest model when the transform input omits it. */
    resolveModel?: (sessionId: string) => { providerID: string; modelID: string } | undefined;
    /**
     * One-shot signal that disk-backed adjuncts (user profile, key files,
     * sticky date) need to be re-read on this pass.
     * Drained at the end of the handler regardless of whether anything
     * actually refreshed — defer passes after this point MUST hit cached
     * values to keep the system prompt cache-stable.
     */
    systemPromptRefreshSessions: Set<string>;
    /**
     * Producer side: when this handler detects a real prompt-content or
     * prompt-surface-preset hash change, it adds the session to all three sets
     * so downstream consumers
     * (transform `prepareCompartmentInjection`, postprocess heuristics)
     * react on the same cycle. The hash change usually pairs with a new
     * agent identity, so all three are appropriate.
     */
    historyRefreshSessions: Set<string>;
    pendingMaterializationSessions: Set<string>;
    lastHeuristicsTurnId: Map<string, string>;
    /**
     * Issue #53: when false, Magic Context skips ALL system-prompt injection
     * for ALL agents. Global escape hatch for users who don't want Magic
     * Context guidance / sticky date touching the system prompt. (default: true)
     */
    injectionEnabled?: boolean;
    /**
     * Issue #53: per-agent opt-out. If the agent's system prompt contains
     * any of these substrings, skip ALL injection for this call. Lets users
     * mark specific custom agents (e.g. read-only QA agents that deny our
     * `ctx_*` tools) as no-injection without having to disable injection
     * globally.
     */
    injectionSkipSignatures?: string[];
    /**
     * Process-scoped set of Magic Context's OWN hidden child sessions
     * (historian/dreamer), flagged by title prefix at
     * `session.created`. When the active session is in this set we skip ALL
     * injection — these children have their own fixed agent identity/prompt and
     * never benefit from the MC guidance block. Belt to the prompt-signature
     * detection below (which is the pass-1 timing-independent suspenders).
     */
    internalChildSessions?: Set<string>;
    /** @deprecated user memories now render in m[0]/m[1], not system prompt. */
    experimentalUserMemories?: boolean;
    /** @deprecated key files now render in m[1], not system prompt. */
    experimentalPinKeyFiles?: boolean;
    /** @deprecated key files now render in m[1], not system prompt. */
    experimentalPinKeyFilesTokenBudget?: number;
    /** When true, add a temporal-awareness guidance paragraph + surface compartment dates */
    experimentalTemporalAwareness?: boolean;
    /**
     * OpenCode SDK client used to read the agent and session permissions for
     * ctx_reduce before the verdict freezes. OpenCode can run this hook before
     * the messages transform, so this hook may be the one that freezes it.
     * Absent (tests, hosts without the SDK): the verdict freezes from the
     * tools map alone, as before permissions were considered.
     */
    client?: PluginContext["client"];
    /** When true, inject a "BEWARE: history compression is on" warning so the
     *  agent doesn't mimic its own caveman-compressed past output. */
    experimentalCavemanTextCompression?: boolean;
    /**
     * True when the messages transform for this same request already ran (the
     * host calls the system hook after it). Consumes that per-request signal.
     * Absent (tests, hosts without the signal): a system change is assumed to be
     * seen before the messages transform, as on a system-first host.
     */
    consumeMessagesPrepared?: (sessionId: string) => boolean;
    /** Without a request token, pair hooks using the ID of the last real user whose turn contains the thinking. */
    resolveDateTurnId?: (sessionId: string) => string | undefined;
}): {
    handler: (
        input: {
            sessionID?: string;
            dateRefreshRequest?: SystemDateRequestIdentity;
            model?: { providerID?: string; modelID?: string };
        },
        output: { system: string[] },
    ) => Promise<void>;
    clearSession: (sessionId: string) => void;
} {
    const promptSurfaceRuntime =
        deps.promptSurfaceRuntime ??
        createPromptSurfaceRuntime({
            userConfigDirectory: process.cwd(),
            warn: (message) => log(`[magic-context] config warning: ${message}`),
        });
    const guidanceEpochs = createPromptSurfaceGuidanceEpochCache(promptSurfaceRuntime);

    // Per-session sticky date: we freeze the date string from the system prompt
    // and only update it on cache-busting passes. This prevents a midnight date
    // flip from causing an unnecessary flush + cache rebuild.
    const stickyDateBySession = new Map<string, string>();
    // The sticky date as last read from or written to the session's persisted
    // record (null: none recorded), so the record is read once per session and
    // written only when the date it holds changes.
    const recordedStickyDateBySession = new Map<string, string | null>();
    const recordedStickyDate = (sessionId: string): string | undefined => {
        let recorded = recordedStickyDateBySession.get(sessionId);
        if (recorded === undefined) {
            recorded = readPersistedSystemPromptStickyDate(deps.db, sessionId) ?? null;
            recordedStickyDateBySession.set(sessionId, recorded);
        }
        return recorded ?? undefined;
    };
    // Only the previous in-process prompt is retained for byte offsets. It is
    // never persisted; a cold handler explicitly reports an unknown baseline.
    const diagnosticPrompts = new Map<string, SystemPromptSnapshot>();

    const processSystemPrompt = async (
        input: {
            sessionID?: string;
            dateRefreshRequest?: SystemDateRequestIdentity;
            model?: { providerID?: string; modelID?: string };
        },
        output: { system: string[] },
    ): Promise<void> => {
        const sessionId = input.sessionID;
        if (!sessionId) return;

        // ── Skip OpenCode's internal hidden agents ──
        //
        // OpenCode invokes `experimental.chat.system.transform` for ALL llm
        // calls inside a session, including its three native hidden agents:
        //   - "title": runs once on the first user turn against `small_model`
        //              (or the small variant of the active model) to generate
        //              a session title from the first message.
        //   - "summary": session export / pull-request-style description.
        //   - "compaction": OpenCode's own auto-compaction summarizer.
        //
        // These agents:
        //   1. Don't benefit from magic-context guidance (they have a fixed
        //      single-shot job — no tools, no `ctx_reduce`, no nudges).
        //   2. Get hit with our `<project-docs>`, `<user-profile>`,
        //      `<key-files>`, and the multi-paragraph guidance block, which
        //      can multiply their input by 10× for a tiny single-line output.
        //   3. Often run on a smaller/cheaper model where the extra prompt
        //      content is wasted spend.
        //
        // The hook contract gives us only `{ sessionID, model }`, so we can't
        // dispatch on agent name. We detect them by signature lines from
        // their prompts in OpenCode source (`packages/opencode/src/agent/prompt/`).
        // These signatures are stable across OpenCode releases — they're the
        // first instruction lines of each internal prompt.
        const fullPromptForDetection = output.system.join("\n");
        if (isInternalOpenCodeAgent(fullPromptForDetection)) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (OpenCode internal agent: title/summary/compaction)",
            );
            return;
        }

        // ── Skip Magic Context's OWN hidden children ──
        // historian/dreamer must not get the MC
        // guidance block (wasted spend + contradictory identity frame). Two
        // signals: the title-prefix flag (set at session.created) and the
        // prompt-signature (timing-independent, reliable on pass 1). Either
        // match skips ALL injection + hash tracking.
        if (
            deps.internalChildSessions?.has(sessionId) ||
            isMagicContextInternalAgent(fullPromptForDetection)
        ) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (Magic Context internal child: historian/dreamer/migration)",
            );
            return;
        }

        // ── Issue #53: user-controlled per-agent opt-out ──
        //
        // Two layers, both honored here:
        //   1. Global: `system_prompt_injection.enabled: false` → skip
        //      injection for every agent. Useful when a user wants Magic
        //      Context to manage history but never touch the system prompt.
        //   2. Per-agent: `system_prompt_injection.skip_signatures` →
        //      substring opt-out. The user adds the signature (default
        //      `<!-- magic-context: skip -->`) inside their custom agent's
        //      prompt; whenever that agent fires, we skip injection for
        //      that call only.
        //
        // Both paths skip ALL injection (guidance, project docs, user
        // profile, key files, sticky date) AND skip hash tracking — like
        // the internal-agent skip above. Hash tracking is intentionally
        // skipped so a deny-listed agent's system prompt doesn't compete
        // with the main agent's hash, which would cause cross-agent
        // hash-change flushes.
        const injectionEnabled = deps.injectionEnabled !== false;
        const skipSignatures = deps.injectionSkipSignatures ?? [];
        if (!injectionEnabled) {
            sessionLog(sessionId, "system-prompt-hash skipped (injection globally disabled)");
            return;
        }
        if (skipSignatures.some((sig) => sig.length > 0 && fullPromptForDetection.includes(sig))) {
            sessionLog(
                sessionId,
                "system-prompt-hash skipped (matched system_prompt_injection.skip_signatures)",
            );
            return;
        }

        // Read after the skip checks above: a skipped title/summary call for this
        // session must not consume the marker left by the main request's messages pass.
        const messagesPrepared = deps.consumeMessagesPrepared?.(sessionId) ?? false;
        const dateRequest = beginSystemDateRequest(
            deps.historyRefreshSessions,
            sessionId,
            messagesPrepared ? "system-after-messages" : "system",
            input.dateRefreshRequest === undefined &&
                hasSystemDateRefresh(deps.historyRefreshSessions)
                ? (deps.resolveDateTurnId ?? latestRealUserTurnIdFromOpenCodeDb)(sessionId)
                : undefined,
            input.dateRefreshRequest,
        );
        bindSystemDateRequest(output, dateRequest);
        const requestMessagesFinal =
            messagesPrepared ||
            systemDateRefreshPermission(deps.historyRefreshSessions, dateRequest) !== undefined;

        // ── Step 1: Inject magic-context guidance ──
        // Subagents with callable ctx_reduce get only the minimal drop mechanics
        // guidance. Subagents without the tool get no Magic Context guidance,
        // because the primary-session no-reduce block would incorrectly describe
        // memory/search/note behavior for a bounded, parent-driven child task.
        let sessionMetaEarly: import("../../features/magic-context/types").SessionMeta | undefined;
        try {
            sessionMetaEarly = getOrCreateSessionMeta(deps.db, sessionId);
        } catch (error) {
            sessionLog(sessionId, "system-prompt-hash session meta load failed:", error);
        }
        const isSubagentSession = sessionMetaEarly?.isSubagent === true;
        // A session whose spawn tools map filters ctx_reduce out (parent
        // allow-lists) must be treated like ctx_reduce-disabled: reduce
        // guidance for an uncallable tool is overhead + cargo-cult risk.
        // The verdict freezes on the session's first user message; before that
        // exists it is a PROVISIONAL fail-open default. Guidance still renders
        // from the provisional value (a prompt must go out), but the hash write
        // below is gated on `frozen` so a provisional reduce-enabled prompt is
        // never persisted as the session's baseline — if the first user message
        // then denies the tool, the variant settles BEFORE any hash existed,
        // instead of flipping a persisted hash and busting the prompt cache.
        // Read the agent and session permissions before this call can freeze
        // the verdict. Only once the first user message is stored: before that
        // the spawn agent is unknown and the verdict stays provisional anyway.
        if (deps.client && ctxReduceSpawnPermissionReadNeeded(sessionId)) {
            const spawn = spawnAgentFromOpenCodeDb(sessionId);
            if (spawn.persisted) {
                await primeCtxReduceSpawnPermission(deps.client, sessionId, spawn.agent);
            }
        }
        const availability = resolveCtxReduceAvailability(sessionId);
        const ctxReduceCallable = availability.callable;
        const subagentReduceMode = isSubagentSession && ctxReduceCallable;
        const effectiveCtxReduceEnabled = isSubagentSession ? false : ctxReduceCallable;
        // A subagent without callable ctx_reduce gets no MC guidance.
        const skipGuidanceForDisabledSubagent = isSubagentSession && !ctxReduceCallable;
        const inputModel = input.model;
        const liveModel =
            inputModel?.providerID && inputModel.modelID
                ? { providerID: inputModel.providerID, modelID: inputModel.modelID }
                : deps.resolveModel?.(sessionId);
        const modelKey =
            liveModel?.providerID && liveModel.modelID
                ? piModelRefToCanonical(`${liveModel.providerID}/${liveModel.modelID}`)
                : undefined;
        const promptSurface = guidanceEpochs.resolve(sessionId, deps.promptSurface, modelKey);
        const fullPrompt = output.system.join("\n");
        if (
            fullPrompt.length > 0 &&
            !fullPrompt.includes(MAGIC_CONTEXT_MARKER) &&
            !skipGuidanceForDisabledSubagent
        ) {
            const guidance = buildMagicContextSection(
                null,
                0,
                effectiveCtxReduceEnabled,
                deps.dreamerEnabled,
                deps.experimentalTemporalAwareness,
                deps.experimentalCavemanTextCompression,
                subagentReduceMode,
                deps.language,
                deps.memoryEnabled !== false,
                promptSurface.preset,
                promptSurface.primaryOverride,
                deps.smartNotesEnabled,
            );
            // OpenAI-compatible serializers emit one wire message per array entry,
            // and strict chat templates reject a second system message. Keep the host
            // prompt and guidance in the original entry instead. Anthropic preserves
            // separate entries as separate content blocks, so old and new wire bytes
            // necessarily differ. The blank line keeps the two sections distinct and
            // changes the persisted hash from the previous newline-joined format, causing
            // the frozen cache prefix to rebuild once through its existing hash-change path.
            output.system[0] = `${output.system[0]}${SYSTEM_PROMPT_GUIDANCE_SEPARATOR}${guidance}`;
            sessionLog(
                sessionId,
                `injected generic guidance into system prompt (ctxReduce=${effectiveCtxReduceEnabled}, subagent=${isSubagentSession}, subagentReduceMode=${subagentReduceMode})`,
            );
        }

        // ── Step 1.5: m[0]/m[1]-resident adjuncts ──
        // Project docs, user profile, and key files intentionally do NOT
        // enter the system prompt in cache architecture v2.0. Project docs
        // and baseline user profile are materialized into m[0]; key files
        // are the volatile resident at m[1]. Keep only guidance + sticky
        // date in system so BP1 remains stable.
        const isCacheBusting = deps.systemPromptRefreshSessions.has(sessionId);
        // An idle-expired request still lets the sticky date advance (below), but
        // it is not a reason to adopt a changed prompt without a fold: the prompt
        // change itself rewrites the bytes before the conversation, so it folds
        // and drains like a change on a warm cache.
        const idleCacheExpired =
            sessionMetaEarly !== undefined &&
            computeHardCacheExpired(
                sessionMetaEarly.cacheTtl,
                sessionMetaEarly.lastResponseTime,
                Date.now(),
            );
        // When this request's messages are already final (OpenCode 1 runs the
        // messages transform before this hook), a changed system prompt is already
        // a full provider-cache rewrite on this request, and Magic Context can no
        // longer fold into it. Queuing a rebuild for the next request would make the
        // provider rewrite its cache a second time. Adopt the new identity here;
        // queued work rides the next natural bust.
        // This must not release the sticky date: OpenCode 1 reports
        // `requestMessagesFinal` on every request, warm or not.
        // A completed messages hook that kept m[0]/m[1] frozen for signed
        // thinking must instead wait for the matching successful provider reply.
        const adoptSystemChange =
            requestMessagesFinal &&
            !isHeldHeadForRequest(sessionId, currentLkgRequestIdentity(sessionId));

        // ── Step 2: Coalesce content/preset and date changes into one bust ──
        const liveSystemContent = output.system.join("\n");
        if (liveSystemContent.length === 0) return;
        const previousHash = sessionMetaEarly?.systemPromptHash ?? "";
        const hasPersistedHash = previousHash !== "" && previousHash !== "0";
        const prefixBoundModel = isPrefixBoundThinkingModel(
            liveModel?.providerID,
            liveModel?.modelID,
        );
        // When the durable system-prompt hash is cleared (a store-generation
        // rebase, a host conversion), the request establishes a new baseline.
        // A known non-prefix-bound model can adopt the live date with that baseline.
        // For prefix-bound or unknown models, the date still sits in front of
        // whatever signed thinking the request serves. If the new prompt has as
        // many host date fields as the previous
        // sticky date, that date stays in force and the new date is adopted only
        // through the same rule as any other date change (`systemDateMayMove`
        // below). If the counts differ, the previous date cannot be applied
        // position by position: it is discarded and the new prompt's dates become
        // the baseline unchecked, because the prompt layout itself changed in
        // front of that thinking anyway.
        let stickyDate = stickyDateBySession.get(sessionId);
        if (!hasPersistedHash) {
            const previous = stickyDate ?? recordedStickyDate(sessionId);
            const live = systemPromptDates(liveSystemContent).live;
            const fieldCount = (dates: string | undefined) =>
                dates === undefined ? 0 : (JSON.parse(dates) as unknown[]).length;
            stickyDate =
                (!modelKey || prefixBoundModel) &&
                previous !== undefined &&
                live !== undefined &&
                fieldCount(previous) === fieldCount(live)
                    ? previous
                    : undefined;
            if (stickyDate === undefined) stickyDateBySession.delete(sessionId);
            else stickyDateBySession.set(sessionId, stickyDate);
        }
        // A new process has no sticky date in memory. Restore the recorded one
        // when it reproduces the persisted hash: that is the date the session's
        // requests carried before the restart, and the signed thinking they
        // produced is bound to it. Without this the first request after a
        // restart past midnight would carry the new date in front of that
        // thinking on a pass that may not rebuild the prompt.
        if (stickyDate === undefined && hasPersistedHash) {
            const recorded = recordedStickyDate(sessionId);
            const live = systemPromptDates(liveSystemContent).live;
            if (
                recorded !== undefined &&
                live !== undefined &&
                recorded !== live &&
                systemPromptFingerprint(
                    systemPromptDates(liveSystemContent, recorded).stable,
                    promptSurface.preset,
                ) === previousHash
            ) {
                stickyDate = recorded;
                stickyDateBySession.set(sessionId, recorded);
                sessionLog(
                    sessionId,
                    `system prompt date restored after restart: real=${live}, using=${recorded}`,
                );
            }
        }
        // Record every change of the sticky date, so a restart can restore the
        // latest date that was saved successfully.
        const setStickyDate = (value: string) => {
            stickyDateBySession.set(sessionId, value);
            if (value !== recordedStickyDate(sessionId)) {
                if (persistSystemPromptStickyDate(deps.db, sessionId, value))
                    recordedStickyDateBySession.set(sessionId, value);
            }
        };
        const dates = systemPromptDates(liveSystemContent, stickyDate);
        const currentDate = dates.live;
        const stableCandidate = dates.stable;
        const stableCandidateHash = systemPromptFingerprint(stableCandidate, promptSurface.preset);
        const contentOrPresetChanged = hasPersistedHash && stableCandidateHash !== previousHash;
        const rewritePermission = systemDateRefreshPermission(
            deps.historyRefreshSessions,
            dateRequest,
        );
        // An idle-expired request rewrites the provider cache, but a signed
        // thinking block the messages pass kept on the wire stays bound to every
        // byte in front of it, the system date included. On a prefix-bound model
        // the date therefore stays frozen while the messages pass reports that
        // it served signed thinking, as on any other bust.
        const signedThinkingKept = systemDateSignedThinkingKept(
            deps.historyRefreshSessions,
            dateRequest,
        );
        // The one rule for moving the date: the request must be allowed to
        // rewrite the prefix (a permitted rebuild, or an expired provider cache)
        // and its messages pass must not report that it served signed thinking.
        // A pass that cannot report it (an ambiguous pairing, the Rust transform)
        // counts as not kept, as before. A held pass keeps that thinking even
        // when it is permitted to apply other work, so its date stays frozen.
        // The date can therefore lag for days: compaction-off strips earlier
        // turns' thinking only when a fold changes m[0]/m[1] or the mode
        // switches, so a session whose docs and memory stay the same keeps its
        // first date. That is deliberate. A stale date costs the model some
        // accuracy about today; a moved date in front of served signed thinking
        // invalidates it, and the provider rejects the request.
        const systemDateMayMove = (rewrite: boolean, keptSignedThinking: boolean | undefined) =>
            (rewrite || idleCacheExpired) && keptSignedThinking !== true;
        // A queued refresh alone cannot change the prompt before an assistant's
        // encrypted thinking that still requires its original earlier messages.
        // If the system hook runs first, wait for a permitted messages rebuild;
        // if the messages hook ran first, use its completed rebuild decision.
        // On a prefix-bound model an idle-expired request waits the same way,
        // for the messages pass to say whether it served signed thinking.
        let deferredDateRefresh = false;
        if (
            currentDate &&
            stickyDate &&
            currentDate !== stickyDate &&
            (idleCacheExpired ? prefixBoundModel : isCacheBusting) &&
            !contentOrPresetChanged &&
            !requestMessagesFinal
        ) {
            const liveElements = [...output.system];
            deferredDateRefresh = waitForSystemDateRefresh(
                deps.historyRefreshSessions,
                dateRequest,
                (permitted, keptSignedThinking) => {
                    if (!systemDateMayMove(permitted, keptSignedThinking)) {
                        deps.systemPromptRefreshSessions.add(sessionId);
                        return;
                    }
                    try {
                        const content = liveElements.join("\n");
                        const hash = systemPromptFingerprint(content, promptSurface.preset);
                        updateSessionMeta(deps.db, sessionId, {
                            systemPromptHash: hash,
                            cachedM0SystemHash: hash,
                            systemPromptTokens: estimateTokens(content),
                        });
                        setStickyDate(currentDate);
                        output.system.splice(0, output.system.length, ...liveElements);
                        publishSystemDateOutput(output.system);
                        deps.systemPromptRefreshSessions.delete(sessionId);
                        sessionLog(
                            sessionId,
                            `system prompt date updated after prefix rewrite: ${stickyDate} → ${currentDate}`,
                        );
                    } catch (error) {
                        deps.systemPromptRefreshSessions.add(sessionId);
                        sessionLog(
                            sessionId,
                            "system prompt date refresh failed (keeping frozen date):",
                            error,
                        );
                    }
                },
            );
        }
        const dateMayAdvance =
            contentOrPresetChanged ||
            (!deferredDateRefresh &&
                systemDateMayMove(
                    isCacheBusting &&
                        (dateRequest ? rewritePermission === true : rewritePermission !== false),
                    signedThinkingKept,
                ));

        if (currentDate && !stickyDate) {
            setStickyDate(currentDate);
        } else if (currentDate && stickyDate && currentDate !== stickyDate) {
            if (dateMayAdvance) {
                setStickyDate(currentDate);
                sessionLog(
                    sessionId,
                    `system prompt date updated: ${stickyDate} → ${currentDate} (cache-busting pass)`,
                );
            } else {
                // Apply the saved host dates to each system prompt element
                // without combining the original array entries.
                let offset = 0;
                const prior: string[] = JSON.parse(stickyDate);
                for (let index = 0; index < output.system.length; index++) {
                    const element = systemPromptDates(output.system[index]);
                    const count = element.live ? JSON.parse(element.live).length : 0;
                    output.system[index] = systemPromptDates(
                        output.system[index],
                        JSON.stringify(prior.slice(offset, offset + count)),
                    ).stable;
                    offset += count;
                }
                sessionLog(
                    sessionId,
                    `system prompt date frozen: real=${currentDate}, using=${stickyDate} (defer pass)`,
                );
            }
        }

        // ── Step 3: Persist only after all routing identities are frozen ──
        const systemContent = output.system.join("\n");
        // The first stable ctx_reduce verdict and resolved model jointly own the
        // baseline. A provisional tool verdict or unknown model can render a
        // prompt, but neither may persist a hash that the settled route would flip.
        if (!availability.frozen || !modelKey) return;

        // Use hex digest — numeric strings get coerced by SQLite INTEGER column affinity,
        // causing precision loss on read-back and infinite hash-change flushes.
        // node:crypto MD5 produces identical digests to Bun.CryptoHasher("md5"),
        // so persisted hashes remain stable across the Bun→Node runtime swap.
        const currentHash = systemPromptFingerprint(systemContent, promptSurface.preset);

        recordSystemPromptForRequest(
            sessionId,
            currentLkgRequestIdentity(sessionId),
            currentHash,
            deps.db,
            previousHash !== currentHash ? !deps.historyRefreshSessions.has(sessionId) : undefined,
            deps.historyRefreshSessions,
            deps.pendingMaterializationSessions,
        );

        // Reuse sessionMetaEarly from Step 1 — no code path between that read
        // and here mutates session_meta for this session, so a second DB read
        // would return identical data. If Step 1's read failed (sessionMetaEarly
        // is undefined), bail rather than re-attempting: we already logged the
        // error and can't make an informed hash-change decision without the
        // previous hash.
        if (!sessionMetaEarly) {
            return;
        }
        const sessionMeta = sessionMetaEarly;
        const previousPrompt = diagnosticPrompts.get(sessionId);
        const currentPrompt =
            previousPrompt && previousHash === currentHash
                ? previousPrompt
                : snapshotSystemPrompt(output.system, promptSurface.preset);
        diagnosticPrompts.set(sessionId, currentPrompt);
        if (previousHash !== "" && previousHash !== "0" && previousHash !== currentHash) {
            sessionLog(
                sessionId,
                `system prompt hash changed: ${previousHash} → ${currentHash} (len=${systemContent.length}), ${adoptSystemChange ? "adopting on the request whose messages are already final" : "triggering flush"}${idleCacheExpired ? " (idle-expired request)" : ""}; ${describeSystemPromptChange(previousPrompt, currentPrompt)}`,
            );
            // This request carries the new prompt, so the provider rewrites its
            // cache from the system block onward whatever the messages pass did.
            // Its transform decision names the change, in every branch below.
            noteSystemPromptHashChange(sessionId);
            // When the following messages transform can still fold into this
            // request, signal all three independent refresh lifetimes. The semantic
            // prompt epoch changed on this turn, so history rebuild, adjunct refresh,
            // and materialization should ride the same cycle.
            if (!adoptSystemChange) {
                deps.historyRefreshSessions.add(sessionId);
                deps.systemPromptRefreshSessions.add(sessionId);
                if (!deps.pendingMaterializationSessions.has(sessionId)) {
                    requestPendingMaterialization(
                        deps.pendingMaterializationSessions,
                        sessionId,
                        "system_hash",
                    );
                }
                deps.lastHeuristicsTurnId.delete(sessionId);
            }
        } else if (previousHash === "" || previousHash === "0") {
            sessionLog(
                sessionId,
                `system prompt hash initialized: ${currentHash} (len=${systemContent.length})`,
            );
        }

        // Estimate system prompt tokens for dashboard visibility only when
        // the prompt hash changed; unchanged prompts keep the stored count.
        //
        // FAIL-OPEN (per-turn handler rule): the prompt has ALREADY been mutated
        // in place above (guidance + sticky date). estimateTokens can throw on a
        // pathological tokenizer input and updateSessionMeta can throw on a busy/
        // failing DB — neither must propagate into the prompt path (a throw here
        // would fail the LLM call instead of just losing a telemetry write). Persist
        // the hash even if token estimation fails, so the next pass doesn't re-detect
        // a phantom hash change and re-flush.
        if (currentHash !== previousHash) {
            let systemPromptTokens = sessionMeta.systemPromptTokens;
            try {
                systemPromptTokens = estimateTokens(systemContent);
            } catch (error) {
                sessionLog(
                    sessionId,
                    "system prompt token estimate failed (using prior count):",
                    error,
                );
            }
            try {
                updateSessionMeta(deps.db, sessionId, {
                    systemPromptHash: currentHash,
                    systemPromptTokens,
                    // When messages.transform has already run before this hook,
                    // After a rebase clears the previous host baseline, the first
                    // m[0] render records no system-prompt hash. Store this request's
                    // hash with that cached render so the following pass recognizes
                    // the unchanged system prompt and reuses the cache.
                    cachedM0SystemHash:
                        !hasPersistedHash || adoptSystemChange ? currentHash : undefined,
                });
            } catch (error) {
                sessionLog(sessionId, "system prompt meta persist failed (fail-open):", error);
            }
        }

        // ── Step 4: Drain systemPromptRefreshSessions (one-shot semantics) ──
        // We've consumed the signal: adjuncts have been re-read or kept
        // cached as appropriate, sticky date has been updated or frozen,
        // and the hash has been re-evaluated. Future defer passes within
        // the same TTL window MUST hit cached adjunct values to keep the
        // system-prompt cache prefix stable.
        //
        // CRITICAL: drain conditionally on the value captured at the top
        // of the handler (`isCacheBusting` from line 201). Two distinct
        // cases hinge on this:
        //
        // 1. Flag was already set when handler started → adjuncts were
        //    refreshed in Step 1.5 above using the live `isCacheBusting`
        //    value. Signal consumed; drain it.
        //
        // 2. Flag was added LATER in Step 3 by hash-change detection
        //    (lines 401-403) → adjuncts in Step 1.5 used STALE cache
        //    because `isCacheBusting` was captured before the add.
        //    The just-added flag must survive to the NEXT pass so
        //    adjuncts can finally refresh. An unconditional drain here
        //    would silently drop that signal, leaving adjuncts stale
        //    forever.
        //
        // Early returns at lines 375 / 388 also benefit: they preserve
        // any pre-existing flag set by `/ctx-flush` or variant change so
        // the next valid pass can consume it.
        //
        // See Oracle review 2026-04-26 Finding A1 for the bug this fixes.
        if (
            isCacheBusting &&
            !deferredDateRefresh &&
            (contentOrPresetChanged ||
                !currentDate ||
                currentDate === stickyDate ||
                !dateRequest ||
                // A permitted pass that kept signed thinking left the date
                // frozen; keep the refresh for the pass that can move it.
                (rewritePermission === true && signedThinkingKept !== true))
        ) {
            deps.systemPromptRefreshSessions.delete(sessionId);
        }
    };

    const handler: typeof processSystemPrompt = async (input, output) => {
        try {
            await processSystemPrompt(input, output);
        } finally {
            finishSystemDateHook(
                deps.historyRefreshSessions,
                systemDateRequestForOutput(deps.historyRefreshSessions, output),
            );
        }
    };
    return {
        handler,
        clearSession: (sessionId: string) => {
            diagnosticPrompts.delete(sessionId);
            recordedStickyDateBySession.delete(sessionId);
            clearSystemDateRefresh(deps.historyRefreshSessions, sessionId);
            guidanceEpochs.clear(sessionId);
            clearSystemPromptHashSession(sessionId, {
                stickyDateBySession,
                cachedDocsBySession: new Map(),
            });
        },
    };
}

import { latestRealUserTurnIdFromOpenCodeDb } from "./read-session-db";
import {
    beginSystemDateRequest,
    bindSystemDateRequest,
    clearSystemDateRefresh,
    finishSystemDateHook,
    hasSystemDateRefresh,
    publishSystemDateOutput,
    type SystemDateRequestIdentity,
    systemDateRefreshPermission,
    systemDateRequestForOutput,
    systemDateSignedThinkingKept,
    waitForSystemDateRefresh,
} from "./system-date-refresh";
