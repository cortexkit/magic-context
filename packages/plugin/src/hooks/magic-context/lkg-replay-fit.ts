import type { ContextDatabase } from "../../features/magic-context/storage";
import { getOverflowState } from "../../features/magic-context/storage-meta-persisted";
import { resolveTrustedContextLimit } from "./event-resolvers";
import {
    estimateAppendedWireTokens,
    estimateFinalWireInputTokens,
} from "./final-wire-token-estimate";
import { type LkgReplayMeasure, measureLkgReplay } from "./lkg-fit-measure";
import { measuredLkgPrefix } from "./lkg-measured-request";
import { getSlot } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

export {
    type LkgReplayMeasure,
    measureLkgReplay,
    RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
} from "./lkg-fit-measure";

type ReplayModel = { providerID: string; modelID: string } | null | undefined;

/**
 * The context limit every last-known-good replay is admitted against: the
 * model's trusted context limit, else the limit the provider reported for this
 * model. Undefined when none is known. Throws when the stored limits cannot be
 * read.
 *
 * The trusted limit is the window's usable soft limit (a declared prompt limit
 * when the catalog has one, else the window minus the output reserve), never the
 * larger usable hard limit: some providers enforce the declared prompt limit
 * (GitHub Copilot rejects a prompt over it), and a replay that overflows turns a
 * recoverable failure into a provider rejection.
 */
export function lkgReplayLimit(args: {
    db: ContextDatabase;
    sessionId: string;
    model: ReplayModel;
    modelKey: string | null | undefined;
}): number | undefined {
    const { db, sessionId, model } = args;
    const trusted = model
        ? resolveTrustedContextLimit(model.providerID, model.modelID, { db, sessionID: sessionId })
        : undefined;
    if (trusted !== undefined && trusted > 0) return trusted;
    const detected = getOverflowState(db, sessionId, args.modelKey).detectedContextLimit;
    return detected > 0 ? detected : undefined;
}

export type LkgReplayFit =
    | { fits: true }
    /** `detail` is the log line explaining the decline, when there is one to log. */
    | { fits: false; detail: string | null };

/** Prefer the input usage bound to this exact saved request. It already includes
 * system and tool definitions, so neither its messages nor its envelope are
 * estimated again. The byte risk budget likewise applies only to the new tail. */
export function measureLkgReplayRequest(args: {
    sessionId: string;
    messages: readonly MessageLike[];
    model: ReplayModel;
    systemPromptTokens: number;
    agentName?: string;
    limit: number;
    estimator?: typeof estimateFinalWireInputTokens;
}): LkgReplayMeasure {
    let measured: ReturnType<typeof measuredLkgPrefix>;
    try {
        measured = args.model
            ? measuredLkgPrefix({
                  ...args,
                  slot: getSlot(args.sessionId),
                  modelKey: `${args.model.providerID}/${args.model.modelID}`,
              })
            : undefined;
    } catch {
        // If the saved request can't be matched to its own usage, fall back to the
        // full estimate; the session's latest usage reading may belong to another request.
        measured = undefined;
    }
    const estimator = args.estimator ?? estimateFinalWireInputTokens;
    return measureLkgReplay({
        messages: measured?.appendedMessages ?? args.messages,
        limit: args.limit,
        measuredInputTokens: measured?.inputTokens,
        estimate: () =>
            measured
                ? estimateAppendedWireTokens({
                      messages: measured.appendedMessages,
                      providerID: args.model?.providerID,
                      modelID: args.model?.modelID,
                  })
                : estimator({
                      messages: args.messages,
                      systemPromptTokens: args.systemPromptTokens,
                      providerID: args.model?.providerID,
                      modelID: args.model?.modelID,
                      agentName: args.agentName,
                      sessionId: args.sessionId,
                  }),
    });
}

/**
 * Whether a last-known-good replay of `messages` may be sent in place of a failed
 * pass: it needs a known limit (`lkgReplayLimit`) and a measurement of "under"
 * (`measureLkgReplay`). Every way of not knowing declines, because a replay that
 * overflows turns a recoverable failure into a provider rejection.
 *
 * The Rust adapter's failure replay and the outer messages-transform wrapper's
 * replay both call this. A healthy frozen pass uses the same limit and
 * measurement; it differs only in serving an unproven measurement, because its
 * alternative is a cache bust rather than a refusal.
 */
export function lkgReplayFits(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    model: ReplayModel;
    modelKey: string | null | undefined;
    systemPromptTokens: number;
    agentName?: string;
    /** Token estimator; tests substitute it. */
    estimator?: typeof estimateFinalWireInputTokens;
}): LkgReplayFit {
    let limit: number | undefined;
    try {
        limit = lkgReplayLimit(args);
    } catch {
        // A limit read failure cannot admit cached bytes whose size is now unknown.
        return { fits: false, detail: null };
    }
    if (limit === undefined) return { fits: false, detail: null };
    const measure = measureLkgReplayRequest({ ...args, limit });
    if (measure.fit === "under") return { fits: true };
    return {
        fits: false,
        detail:
            measure.fit === "over"
                ? `lkg_over_context_limit estimated=${measure.tokens ?? "skipped"} proxy_tokens=${measure.proxyTokens ?? "unavailable"} limit=${limit}`
                : `lkg_fit_untrusted estimated=${measure.tokens ?? "unavailable"} limit=${limit}`,
    };
}
