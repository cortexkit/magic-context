import { decodeMergedReasoningParts } from "../../features/magic-context/merged-reasoning-decisions";
import {
    detectLatestTurnThinkingMismatch,
    detectThinkingBindingMismatch,
    isPrefixBoundThinkingModel,
} from "../../features/magic-context/overflow-detection";
import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    addMergedReasoningStrippedIds,
    armThinkingBindingRecovery,
    decodeThinkingBindingEntryOrder,
    getMergedReasoningStrippedIds,
    getThinkingBindingRecoveryTarget,
    THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
    thinkingBindingRecoveryFrozenId,
} from "../../features/magic-context/storage-meta-persisted";
import { ensureSessionMetaRow } from "../../features/magic-context/storage-meta-shared";
import { getReasoningRemovalState } from "../../features/magic-context/storage-reasoning-removal";
import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import { contextRefusalError } from "./emergency-fail-closed";
import {
    isSentAssistantMessage,
    latestAssistantTurnStart,
    type ProviderLatestTurn,
    providerLatestTurn,
} from "./latest-assistant-turn";
import { dropSlot } from "./lkg-slot";
import { isAnthropicFamilyRoute } from "./sentinel";
import type { MessageLike } from "./tag-messages";
import { TOOL_SWEEP_SCOPED_MARKER } from "./tool-sweep-policy";

/**
 * Every value this recovery stores in `thinking_binding_recovery_target`
 * starts with this prefix, which keeps it apart from the binding-mismatch
 * recovery that shares the column.
 */
export const LATEST_THINKING_RESTORE = "latest_thinking_original";
/** The current encoding: this prefix, then the JSON of a `RecoveryState`. */
const TURN_STATE = `${LATEST_THINKING_RESTORE}_turn:`;
const knownRejectedSessions = new Set<string>();

/**
 * Whether a `thinking_binding_recovery_target` value belongs to this recovery
 * rather than to the binding-mismatch recovery that shares the column. The
 * binding recovery must never consume it as its own armed flag.
 */
export function isLatestThinkingRecoveryTarget(target: string | null | undefined): boolean {
    return typeof target === "string" && target.startsWith(LATEST_THINKING_RESTORE);
}

/** The provider's latest turn, named by its first and last assistant message the host sends. */
interface BoundTurn {
    first: string;
    last: string;
}

/**
 * - `armed`: the provider rejected the turn; no remedy served yet.
 * - `restoring`: the turn's original thinking is served (first remedy).
 * - `remove`: the next pass removes the turn's thinking (a restored request
 *   was rejected, or a turn that went on after a removal was rejected again).
 * - `removed`: the turn's thinking is omitted (second remedy).
 * - `refused`: the third rejection of the turn; passes refuse locally.
 */
type RecoveryStage = "armed" | "restoring" | "remove" | "removed" | "refused";

interface RecoveryState extends BoundTurn {
    stage: RecoveryStage;
    /** Rejections of the bound turn recorded so far. */
    rejections: number;
    /** The pass whose request the latest recorded rejection refused. */
    pass?: string;
    /**
     * The model id (and provider, when known) the rejected request went to, as
     * the pass that built it saw it; the failure event's model only when no
     * pass in this process recorded one.
     */
    model?: string;
    provider?: string;
    /** A request after the removal was accepted (the turn went on). */
    accepted?: boolean;
}

/** Rejections of one turn after which passes refuse locally. */
const REFUSE_AT_REJECTION = 3;

const STAGES = new Set<string>(["armed", "restoring", "remove", "removed", "refused"]);

function readState(target: string): RecoveryState | undefined {
    if (!target.startsWith(TURN_STATE)) return undefined;
    try {
        const value: unknown = JSON.parse(target.slice(TURN_STATE.length));
        if (
            !isRecord(value) ||
            !STAGES.has(String(value.stage)) ||
            typeof value.first !== "string" ||
            typeof value.last !== "string" ||
            typeof value.rejections !== "number"
        )
            return undefined;
        return {
            stage: value.stage as RecoveryStage,
            first: value.first,
            last: value.last,
            rejections: value.rejections,
            ...(typeof value.pass === "string" ? { pass: value.pass } : {}),
            ...(typeof value.model === "string" ? { model: value.model } : {}),
            ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
            ...(value.accepted === true ? { accepted: true } : {}),
        };
    } catch {
        return undefined;
    }
}

function encodeState(state: RecoveryState): string {
    return (
        TURN_STATE +
        JSON.stringify({
            stage: state.stage,
            first: state.first,
            last: state.last,
            rejections: state.rejections,
            ...(state.pass ? { pass: state.pass } : {}),
            ...(state.model ? { model: state.model } : {}),
            ...(state.provider ? { provider: state.provider } : {}),
            ...(state.accepted ? { accepted: true } : {}),
        })
    );
}

function identifyTurn<T>(
    messages: readonly T[],
    id: (message: unknown, index: number) => string | undefined,
): { turn: ProviderLatestTurn; bound: BoundTurn } | undefined {
    const turn = providerLatestTurn(messages);
    if (!turn) return undefined;
    const first = id(messages[turn.first], turn.first);
    const last = id(messages[turn.last], turn.last);
    return first && last ? { turn, bound: { first, last } } : undefined;
}

/**
 * The provider's latest turn in the request each session's most recent pass
 * built, with a token naming that pass and the model (and provider) the pass
 * built the request for. That request is the one a provider may reject next,
 * so arming binds recovery to this turn rather than to whichever turn rebuilds
 * after it, and counts one rejection per pass however many events the host
 * sends for it. Recording the pass's own model lets a later pass compare like
 * with like: a failure event may name the model differently (an alias, or the
 * model a plugin switched to), and comparing that with the pass's view would
 * unbind on every pass.
 */
const lastPassTurn = new Map<
    string,
    BoundTurn & { pass: string; model?: string; provider?: string }
>();
const PROCESS_TOKEN = Math.random().toString(36).slice(2, 10);
let passCounter = 0;

export const LATEST_THINKING_UNSAFE =
    "ANTHROPIC_LATEST_TURN_EDIT_UNSAFE: The provider keeps rejecting the thinking of this conversation's latest assistant turn, even after Magic Context restored or removed it. Sending a new message does not help, because the provider checks that same turn again. Switch the model once, or run /clear, to continue.";

/**
 * The refusal when the change a rejected turn needs could not be saved (or its
 * saved state read). No host matches on the latest-turn refusal's code, so this
 * one does not carry it: it is not that refusal.
 */
export const LATEST_THINKING_NOT_SAVED =
    "Magic Context could not save the change this request needs after the provider rejected the thinking of the latest assistant turn (its database was busy or changed at the same moment). Nothing was sent. Send your message again.";

/** The stage a further rejection, the `rejections`-th of the turn, moves to. */
function escalate(state: RecoveryState, rejections: number): RecoveryStage {
    switch (state.stage) {
        case "armed":
            return "armed";
        case "restoring":
        case "remove":
            return "remove";
        case "removed":
            if (state.accepted) return "remove";
            // A request without the turn's thinking is served again until the
            // turn's third rejection; then the pass refuses locally.
            return rejections >= REFUSE_AT_REJECTION ? "refused" : "removed";
        case "refused":
            return "refused";
    }
}

/**
 * Record a provider rejection of the latest turn's thinking, in the existing
 * recovery column. A first rejection binds to the provider's latest turn of
 * the pass that built the rejected request. Hosts report one failure in more
 * than one event; only the first report for a pass counts. With no pass in
 * this process to name the turn, the rejection stays unbound and the next pass
 * clears it.
 */
export function armLatestThinkingRecovery(
    db: ContextDatabase,
    sessionId: string,
    modelID?: string,
): void {
    knownRejectedSessions.add(sessionId);
    ensureSessionMetaRow(db, sessionId);
    const current = getThinkingBindingRecoveryTarget(db, sessionId);
    const state = current ? readState(current) : undefined;
    const pass = lastPassTurn.get(sessionId);
    let next: string;
    if (state) {
        if (pass !== undefined && state.pass === pass.pass) return;
        // A request after a removal was accepted, so this rejection opens a new count.
        const rejections = state.accepted ? 1 : state.rejections + 1;
        const stage = escalate(state, rejections);
        // The rejected request carried the turn as that pass saw it.
        const last = pass?.first === state.first ? pass.last : state.last;
        next = encodeState({
            ...state,
            stage,
            last,
            rejections,
            pass: pass?.pass,
            accepted: false,
        });
        sessionLog(
            sessionId,
            `latest-turn thinking recovery: provider rejected the bound turn again (rejection ${rejections}, first=${state.first} last=${last}); ${state.stage} -> ${stage}`,
        );
    } else if (pass) {
        const model = pass.model ?? modelID;
        const provider = pass.model ? pass.provider : undefined;
        next = encodeState({
            stage: "armed",
            first: pass.first,
            last: pass.last,
            rejections: 1,
            pass: pass.pass,
            ...(model ? { model } : {}),
            ...(provider ? { provider } : {}),
        });
        sessionLog(
            sessionId,
            `latest-turn thinking recovery: armed for the provider's latest turn (first=${pass.first} last=${pass.last} model=${provider ? `${provider}/` : ""}${model ?? "unknown"})`,
        );
    } else {
        next = LATEST_THINKING_RESTORE;
        sessionLog(
            sessionId,
            "latest-turn thinking recovery: rejection not bound, no pass in this process built the rejected request",
        );
    }
    db.prepare(
        "UPDATE session_meta SET thinking_binding_recovery_target = ? WHERE session_id = ?",
    ).run(next, sessionId);
}

function clone<T>(value: T): T {
    if (Array.isArray(value)) return value.map(clone) as T;
    if (!isRecord(value)) return value;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
}

export function isThinkingPart(part: unknown): boolean {
    return (
        isRecord(part) && ["thinking", "reasoning", "redacted_thinking"].includes(String(part.type))
    );
}

function replayableOriginal(part: unknown): boolean {
    if (!isThinkingPart(part) || !isRecord(part)) return false;
    const metadata =
        isRecord(part.metadata) && isRecord(part.metadata.anthropic) ? part.metadata.anthropic : {};
    const signature =
        part.signature ??
        part.thinkingSignature ??
        metadata.signature ??
        part.data ??
        metadata.redactedData;
    return (
        typeof signature === "string" &&
        signature.length > 0 &&
        part.text !== "[cleared]" &&
        part.thinking !== "[cleared]"
    );
}

export interface LatestThinkingRecovery {
    /** Serve the bound turn's original thinking on this pass (the first remedy). */
    restore: boolean;
    /** A restoring recovery ended because a newer turn exists. */
    ended: boolean;
    /**
     * This pass removed the bound turn's thinking for the first time (the
     * second remedy). The removal is already persisted in the binding-mismatch
     * set, which this and every later pass replays. Hosts record the pass's
     * decision with `LATEST_TURN_THINKING_REMOVED_REASON`.
     */
    removedThisPass?: boolean;
    /**
     * The bound turn's assistant ids whose thinking the recovery removed: on
     * the pass that removed it and on every later pass while the recovery is
     * bound to that turn. A host that runs its pipeline more than once in a
     * pass strips these on every run.
     */
    removedIds?: readonly string[];
}

const NO_RECOVERY: LatestThinkingRecovery = { restore: false, ended: false };

/** Decision reason recorded for the pass that first removes the turn's thinking. */
export const LATEST_TURN_THINKING_REMOVED_REASON = "latest_turn_thinking_removed";

function replaceTarget(
    db: ContextDatabase,
    sessionId: string,
    expected: string,
    next: string,
): boolean {
    return (
        db
            .prepare(
                "UPDATE session_meta SET thinking_binding_recovery_target = ? WHERE session_id = ? AND thinking_binding_recovery_target = ?",
            )
            .run(next, sessionId, expected).changes > 0
    );
}

function decisionMessageId(decision: string): string | undefined {
    // Control entries name no message whose thinking was removed: the Pi strip
    // order marker, a per-entry strip order record, and the tool-sweep scope marker.
    if (
        decodeThinkingBindingEntryOrder(decision) ||
        decision === "binding_mismatch_order:end" ||
        decision === TOOL_SWEEP_SCOPED_MARKER
    )
        return undefined;
    return (
        decodeMergedReasoningParts(decision)?.[0] ??
        (decision.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)
            ? decision.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length)
            : decision)
    );
}

interface PrepareArgs {
    db: ContextDatabase;
    sessionId: string;
    messages: readonly unknown[];
    id: (message: unknown, index: number) => string | undefined;
    parts: (message: unknown) => readonly unknown[];
}

/** Assistant ids of the turn the host sends, in order. */
function sentAssistantIds(args: PrepareArgs, turn: ProviderLatestTurn): string[] {
    const ids: string[] = [];
    for (let index = turn.start; index < turn.end; index += 1) {
        const message = args.messages[index];
        if (!isSentAssistantMessage(message)) continue;
        const id = args.id(message, index);
        if (id) ids.push(id);
    }
    return ids;
}

/**
 * Whether Magic Context's replayed decisions removed, cleared or reordered
 * thinking in the turn: a frozen thinking decision or a reasoning removal names
 * one of its assistants, or the cleared-reasoning watermark covers one that
 * carries thinking (that lane replays `[cleared]` up to a saved tag on routes
 * whose thinking is not bound to the bytes before it, and the turn is not
 * protected from it once a user message follows). Only then can serving the
 * originals change bytes.
 */
function magicContextEditedTurn(
    args: PrepareArgs,
    turn: ProviderLatestTurn,
    modelID: string | undefined,
): boolean {
    const ids = new Set(sentAssistantIds(args, turn));
    for (const decision of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
        const id = decisionMessageId(decision);
        if (id !== undefined && ids.has(id)) return true;
    }
    try {
        for (const id of getReasoningRemovalState(args.db, args.sessionId).messageIds) {
            if (ids.has(id)) return true;
        }
    } catch {
        // Unreadable removals fail the pass closed later; they prove no edit here.
    }
    return !isPrefixBoundThinkingModel(undefined, modelID) && clearedByWatermark(args, turn);
}

/**
 * Whether the cleared-reasoning watermark covers an assistant of the turn that
 * carries thinking. A message is cleared when its newest tag (a text part's or
 * a tool call's) is at or below the watermark. Two indexed lookups per
 * thinking-bearing assistant of the turn; nothing else is read.
 */
function clearedByWatermark(args: PrepareArgs, turn: ProviderLatestTurn): boolean {
    try {
        const row = args.db
            .prepare(
                "SELECT cleared_reasoning_through_tag AS watermark FROM session_meta WHERE session_id = ?",
            )
            .get(args.sessionId) as { watermark?: number | null } | null | undefined;
        const watermark = row?.watermark ?? 0;
        if (!(watermark > 0)) return false;
        const textTags = args.db.prepare(
            "SELECT MAX(tag_number) AS n FROM tags WHERE session_id = ? AND message_id >= ? AND message_id < ?",
        );
        const toolTags = args.db.prepare(
            "SELECT MAX(tag_number) AS n FROM tags WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id = ?",
        );
        for (let index = turn.start; index < turn.end; index += 1) {
            const message = args.messages[index];
            if (!isSentAssistantMessage(message)) continue;
            if (!args.parts(message).some(isThinkingPart)) continue;
            const id = args.id(message, index);
            if (!id) continue;
            // Part tags are `<message id>:p<index>` (or `:file<index>`); `;` sorts
            // right after `:`, so the range holds exactly this message's parts.
            const text = textTags.get(args.sessionId, `${id}:`, `${id};`) as {
                n?: number | null;
            } | null;
            const tool = toolTags.get(args.sessionId, id) as { n?: number | null } | null;
            const newest = Math.max(text?.n ?? 0, tool?.n ?? 0);
            if (newest > 0 && newest <= watermark) return true;
        }
    } catch {
        // An unreadable watermark proves no edit; the removal still recovers.
    }
    return false;
}

/**
 * Why the turn's originals cannot be restored safely, or undefined when they
 * can: the turn must still carry signed originals, and every frozen decision
 * must name a message whose original is present in this request.
 */
function restoreBlocker(args: PrepareArgs, turn: ProviderLatestTurn): string | undefined {
    // With no real user request before it, the turn's start is unknown and a
    // restore would rewrite the whole array.
    if (turn.start === 0) return "no-turn-start";
    const turnMessages = args.messages.slice(turn.start, turn.end);
    if (!turnMessages.some((message) => args.parts(message).some(replayableOriginal)))
        return "missing-thinking-original";
    const ids = new Map(args.messages.map((message, index) => [args.id(message, index), index]));
    for (const decision of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
        const id = decisionMessageId(decision);
        if (id === undefined) continue;
        const index = ids.get(id);
        if (
            index === undefined ||
            (index >= turn.start && !args.parts(args.messages[index]).some(replayableOriginal))
        )
            return `missing-original:${id}`;
    }
    return undefined;
}

function refuse(sessionId: string, why: string): never {
    sessionLog(sessionId, `latest-turn thinking recovery: refused locally (${why})`);
    throw contextRefusalError(LATEST_THINKING_UNSAFE);
}

/**
 * Refuse a pass whose recovery decision could not be saved or read. Nothing
 * was restored or removed and the state is unchanged, so the next pass tries
 * again; the user only needs to send the message again.
 */
function refuseUnsaved(sessionId: string, why: string): never {
    sessionLog(sessionId, `latest-turn thinking recovery: refused locally (${why})`);
    throw contextRefusalError(LATEST_THINKING_NOT_SAVED);
}

/** The binding-mismatch entries saved so far, as message ids. */
function frozenBindingIds(args: PrepareArgs): Set<string> {
    const frozen = new Set<string>();
    for (const decision of getMergedReasoningStrippedIds(args.db, args.sessionId)) {
        if (decision.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX))
            frozen.add(decision.slice(THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length));
    }
    return frozen;
}

/** The turn's sent assistants whose thinking the binding-mismatch set omits. */
function frozenTurnIds(args: PrepareArgs, turn: ProviderLatestTurn): string[] {
    const frozen = frozenBindingIds(args);
    return sentAssistantIds(args, turn).filter((id) => frozen.has(id));
}

function persistBindingRemoval(
    db: ContextDatabase,
    sessionId: string,
    ids: readonly string[],
): boolean {
    return addMergedReasoningStrippedIds(db, sessionId, ids.map(thinkingBindingRecoveryFrozenId));
}

/**
 * The second remedy. The provider refused the turn as it stood, either with
 * all its original thinking (so restoring would resend the same bytes) or with
 * the originals restored, so the only shape left that it accepts is the turn
 * without thinking. Every thinking part of the turn is omitted through the
 * binding-mismatch set, which every host replays on every pass, and the
 * omission is written before the request is served so the next pass replays
 * it byte for byte. The turn loses its reasoning and the provider cache is
 * rewritten from the turn on; nothing before the turn changes.
 */
function removeTurnThinking(
    args: PrepareArgs & { persistRemoval?: (ids: readonly string[]) => boolean },
    target: string,
    state: RecoveryState,
    turn: ProviderLatestTurn,
    current: BoundTurn,
): LatestThinkingRecovery {
    const frozen = frozenBindingIds(args);
    const ids: string[] = [];
    let parts = 0;
    for (let index = turn.start; index < turn.end; index += 1) {
        const message = args.messages[index];
        if (!isSentAssistantMessage(message)) continue;
        const thinking = args.parts(message).filter(isThinkingPart).length;
        if (thinking === 0) continue;
        const id = args.id(message, index);
        if (!id) refuse(args.sessionId, "a thinking message of the turn has no stable id");
        if (frozen.has(id)) continue;
        ids.push(id);
        parts += thinking;
    }
    if (ids.length === 0) {
        replaceTarget(
            args.db,
            args.sessionId,
            target,
            encodeState({ ...state, stage: "refused", last: current.last }),
        );
        refuse(args.sessionId, "the rejected turn has no thinking left to remove");
    }
    const persist =
        args.persistRemoval ?? ((next) => persistBindingRemoval(args.db, args.sessionId, next));
    let persisted = false;
    try {
        args.db
            .transaction(() => {
                if (!persist(ids)) throw new Error("thinking removal was not persisted");
                const next = encodeState({ ...state, stage: "removed", last: current.last });
                if (!replaceTarget(args.db, args.sessionId, target, next))
                    throw new Error("recovery state changed concurrently");
            })
            .immediate();
        persisted = true;
    } catch (error) {
        sessionLog(args.sessionId, "latest-turn thinking recovery: removal write failed:", error);
    }
    // Serving the turn unchanged would resend the bytes the provider refused.
    // The transaction rolled back, so the state is still the stage it was in.
    if (!persisted) refuseUnsaved(args.sessionId, "the thinking removal could not be saved");
    sessionLog(
        args.sessionId,
        `latest-turn thinking recovery: removed thinking from the bound turn (parts=${parts} messages=${ids.length} first=${state.first} last=${current.last})`,
    );
    return {
        restore: false,
        ended: false,
        removedThisPass: true,
        removedIds: frozenTurnIds(args, turn),
    };
}

/**
 * Decide this pass's latest-turn thinking recovery. Only a provider rejection
 * of the turn's thinking arms it, and it stays bound to the turn that request
 * carried (see `providerLatestTurn`): later user messages and failed empty
 * assistant rows do not unbind it, a newer assistant message does, because a
 * newer message proves a request after the rejection was accepted.
 *
 * Remedies, one per rejection: restore the originals when Magic Context's
 * replayed decisions edited the turn's thinking; otherwise, or once a restored
 * request is rejected too, remove all of the turn's thinking; the turn's third
 * rejection refuses locally until the turn is no longer the latest or the
 * request goes to another model. `modelID` and `providerID` name the model
 * this pass builds its request for, the same value the pass records for a
 * later arm, so unbinding compares a pass's view with a pass's view.
 * `persistRemoval` lets a host write the removal its own way (Pi keeps its
 * strip order); it must add the ids to the binding-mismatch set.
 */
export function prepareLatestThinkingRecovery(
    args: PrepareArgs & {
        modelID?: string;
        providerID?: string;
        persistRemoval?: (ids: readonly string[]) => boolean;
    },
): LatestThinkingRecovery {
    const identified = identifyTurn(args.messages, args.id);
    if (identified)
        lastPassTurn.set(args.sessionId, {
            ...identified.bound,
            pass: `${PROCESS_TOKEN}:${++passCounter}`,
            ...(args.modelID ? { model: args.modelID } : {}),
            ...(args.modelID && args.providerID ? { provider: args.providerID } : {}),
        });
    else lastPassTurn.delete(args.sessionId);
    let target: string | null;
    try {
        target = getThinkingBindingRecoveryTarget(args.db, args.sessionId);
    } catch (error) {
        if (knownRejectedSessions.has(args.sessionId))
            refuseUnsaved(args.sessionId, "the recovery state could not be read");
        // Let the host's existing unavailable-store/LKG policy handle an
        // unarmed session; recovery must not change its fallback contract.
        return NO_RECOVERY;
    }
    if (!target || !target.startsWith(LATEST_THINKING_RESTORE)) {
        knownRejectedSessions.delete(args.sessionId);
        return NO_RECOVERY;
    }
    const state = readState(target);
    if (!state) {
        // Unbound (no pass in this process built the rejected request) or
        // written by an older build: the rejected turn cannot be named, so
        // nothing is applied.
        replaceTarget(args.db, args.sessionId, target, "");
        knownRejectedSessions.delete(args.sessionId);
        sessionLog(
            args.sessionId,
            "latest-turn thinking recovery: cleared a rejection that names no turn",
        );
        return NO_RECOVERY;
    }
    const unbind = (why: string): LatestThinkingRecovery => {
        replaceTarget(args.db, args.sessionId, target, "");
        knownRejectedSessions.delete(args.sessionId);
        sessionLog(
            args.sessionId,
            `latest-turn thinking recovery: unbound because ${why} (stage=${state.stage} first=${state.first} last=${state.last})`,
        );
        return { restore: false, ended: state.stage === "restoring" };
    };
    // Another model receives the turn's thinking as text on every host, so the
    // rejected blocks are no longer sent. Both values are the passes' own view
    // of the request's model, so a spelling the failure event used never
    // counts as a switch. The provider counts too: the same model id through
    // another provider is a different route.
    if (args.modelID && state.model && args.modelID.toLowerCase() !== state.model.toLowerCase())
        return unbind(`the request now goes to ${args.modelID}`);
    if (
        args.providerID &&
        state.provider &&
        args.providerID.toLowerCase() !== state.provider.toLowerCase()
    )
        return unbind(`the request now goes through ${args.providerID}`);
    const current = identified?.bound;
    if (!identified || !current || current.first !== state.first)
        return unbind(
            `a newer turn was accepted (now first=${current?.first ?? "none"} last=${current?.last ?? "none"})`,
        );
    const turn = identified.turn;
    if (current.last !== state.last && state.stage !== "restoring") {
        if (state.stage !== "removed")
            return unbind(`a newer message of the turn was accepted (now last=${current.last})`);
        // The request without the turn's thinking was accepted and the turn
        // went on. The removal stays frozen; a later rejection of the turn's
        // new thinking removes that too instead of refusing.
        replaceTarget(
            args.db,
            args.sessionId,
            target,
            encodeState({ ...state, last: current.last, accepted: true }),
        );
        sessionLog(
            args.sessionId,
            `latest-turn thinking recovery: a request without the turn's removed thinking was accepted (first=${state.first} last=${current.last})`,
        );
        return { ...NO_RECOVERY, removedIds: frozenTurnIds(args, identified.turn) };
    }
    knownRejectedSessions.add(args.sessionId);
    switch (state.stage) {
        case "refused":
            return refuse(
                args.sessionId,
                `the provider rejected the turn first=${state.first} ${state.rejections} times`,
            );
        case "removed":
            // Every run of the pass's pipeline must serve the removal; a host
            // that runs it again on a copy taken before the removal was saved
            // (Pi's fit reclaim) strips these ids itself.
            return { ...NO_RECOVERY, removedIds: frozenTurnIds(args, turn) };
        case "restoring": {
            const blocker = restoreBlocker(args, turn);
            if (blocker === undefined) return { restore: true, ended: false };
            sessionLog(
                args.sessionId,
                `latest-turn thinking recovery: restore no longer possible (${blocker}); removing the turn's thinking instead`,
            );
            return removeTurnThinking(args, target, state, turn, current);
        }
        case "armed": {
            if (magicContextEditedTurn(args, turn, args.modelID)) {
                const blocker = restoreBlocker(args, turn);
                if (blocker === undefined) {
                    // The first remedy: Magic Context edited the turn's thinking,
                    // so serving the originals changes what the provider sees.
                    // It stays applied for the rest of the turn.
                    replaceTarget(
                        args.db,
                        args.sessionId,
                        target,
                        encodeState({ ...state, stage: "restoring", last: current.last }),
                    );
                    sessionLog(
                        args.sessionId,
                        `latest-turn thinking recovery: restore applied to the bound turn (first=${state.first} last=${current.last})`,
                    );
                    return { restore: true, ended: false };
                }
                sessionLog(
                    args.sessionId,
                    `latest-turn thinking recovery: restore unavailable (${blocker}); removing the turn's thinking instead`,
                );
            }
            return removeTurnThinking(args, target, state, turn, current);
        }
        case "remove":
            return removeTurnThinking(args, target, state, turn, current);
    }
}

/**
 * End the latest-thinking recovery after the Rust module served a signed-thinking reset.
 * The reset removed every signed block of the active turn because bytes before them
 * changed, so the originals the recovery would restore are bound to bytes that no longer
 * exist: restoring them on a later pass would serve invalid signatures.
 */
export function endLatestThinkingRecoveryAfterReset(db: ContextDatabase, sessionId: string): void {
    const target = getThinkingBindingRecoveryTarget(db, sessionId);
    if (target?.startsWith(LATEST_THINKING_RESTORE)) {
        db.prepare(
            "UPDATE session_meta SET thinking_binding_recovery_target = '' WHERE session_id = ? AND thinking_binding_recovery_target = ?",
        ).run(sessionId, target);
        sessionLog(
            sessionId,
            "latest-turn thinking recovery: ended after a signed-thinking reset removed the turn's thinking",
        );
    }
    knownRejectedSessions.delete(sessionId);
}

/**
 * Read-only: the messages of the turn whose originals a restoring recovery
 * serves on this array, or undefined when none is restoring. Hosts that replay
 * frozen thinking omissions outside `prepareLatestThinkingRecovery` (Pi, at the
 * start or the end of its pass) skip these messages, so the original thinking
 * the rejection asked for is neither removed before it is checked nor removed
 * again after it is restored. Older turns keep their omissions, and so does a
 * turn whose thinking the recovery removed.
 */
export function latestThinkingRestoringTurnMessages<T>(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: readonly T[];
    id: (message: unknown, index: number) => string | undefined;
}): Set<T> | undefined {
    let target: string | null;
    try {
        target = getThinkingBindingRecoveryTarget(args.db, args.sessionId);
    } catch {
        return undefined;
    }
    const state = target ? readState(target) : undefined;
    if (state?.stage !== "restoring") return undefined;
    const identified = identifyTurn(args.messages, args.id);
    if (identified?.bound.first !== state.first) return undefined;
    return new Set(args.messages.slice(identified.turn.start));
}

/** Capture after tagging, before destructive legacy replay, to retain wire tags. */
export function captureOriginalTurn<T>(
    messages: T[],
    parts: (message: T) => unknown,
    setParts: (message: T, parts: unknown) => void,
): (target?: T[]) => void {
    // The restored turn is the provider's latest turn, which a later real user
    // message does not end; from the user request that opened it on.
    const start = Math.max(
        0,
        (providerLatestTurn(messages)?.start ?? latestAssistantTurnStart(messages)) - 1,
    );
    const originals = messages
        .slice(start)
        .map((message) => ({ message, parts: clone(parts(message)) }));
    const before = messages.slice(0, start);
    return (target = messages) => {
        const first = target.findIndex((message) =>
            originals.some(
                (original) =>
                    original.message === message ||
                    (isRecord(message) &&
                        isRecord(original.message) &&
                        ((isRecord(message.info) &&
                            isRecord(original.message.info) &&
                            message.info.id === original.message.info.id) ||
                            (message.role === original.message.role &&
                                message.timestamp !== undefined &&
                                message.timestamp === original.message.timestamp))),
            ),
        );
        const prefix =
            first >= 0 ? target.slice(0, first) : target === messages ? before : target.slice();
        for (const original of originals) {
            setParts(original.message, clone(original.parts));
        }
        target.length = 0;
        target.push(...prefix, ...originals.map((original) => original.message));
    };
}

/**
 * The messages a restoring recovery serves with their original thinking: the
 * provider's latest turn, from the user message that opened it to the end of
 * the array. That turn starts before the open turn once a real user message
 * follows it, and after it when a message the host or a plugin wrote ends an
 * earlier run inside the open turn; nothing before it is restored. With no
 * assistant message in the array, the open turn (`activeTurn`).
 */
export function restoredTurnMessages<T>(
    messages: readonly T[],
    activeTurn: ReadonlySet<T>,
): Set<T> {
    const turn = providerLatestTurn(messages);
    return turn ? new Set(messages.slice(turn.start)) : new Set(activeTurn);
}

export function captureLatestTurnOriginals(
    messages: MessageLike[],
): (target?: MessageLike[]) => void {
    return captureOriginalTurn(
        messages,
        (message) => message.parts,
        (message, parts) => {
            message.parts = parts as unknown[];
        },
    );
}

/**
 * Route a binding 400 ("bound to a different conversation") while the column
 * holds latest-turn state. While the recovery restores or is waiting to act on
 * the turn (`armed`, `restoring`, `remove`), the rejection counts against the
 * latest turn as before. Once the turn's thinking is removed (`removed`) or
 * the turn is refused (`refused`), nothing of the turn's own earlier thinking
 * is left for a latest-turn remedy to change: the 400 names a block the
 * binding recovery strips, so it is handed to that recovery. Its flag replaces
 * the latest-turn state in the shared column; the removal stays in the ledger,
 * and the next pass sees no latest-turn state and strips every remaining
 * signed block.
 */
export function armBindingRecoverySafely(db: ContextDatabase, sessionId: string): void {
    const target = getThinkingBindingRecoveryTarget(db, sessionId);
    if (target?.startsWith(LATEST_THINKING_RESTORE)) {
        const stage = readState(target)?.stage;
        if (stage !== "removed" && stage !== "refused") {
            armLatestThinkingRecovery(db, sessionId);
            return;
        }
        knownRejectedSessions.delete(sessionId);
        sessionLog(
            sessionId,
            `latest-turn thinking recovery: binding rejection handed to the binding recovery (stage=${stage})`,
        );
    }
    armThinkingBindingRecovery(db, sessionId);
}

/**
 * Arm recovery from a host failure event when the provider rejected the
 * thinking of the latest assistant turn. OpenCode 2 reports provider failures
 * only through its session event stream, so it arms here; the next pass then
 * applies the next remedy. Returns whether the error was this rejection.
 */
export function armLatestThinkingRecoveryFromError(args: {
    db: ContextDatabase;
    sessionId: string;
    error: unknown;
    providerID?: string;
    modelID?: string;
}): boolean {
    if (!detectLatestTurnThinkingMismatch(args.error)) return false;
    if (!isAnthropicFamilyRoute(args.providerID, args.modelID)) return true;
    armLatestThinkingRecovery(args.db, args.sessionId, args.modelID);
    // The last-known-good request still carries the rejected bytes.
    dropSlot(args.sessionId, "latest-thinking-recovery-arm");
    return true;
}

/**
 * Arm thinking-binding recovery from a host failure event when the provider
 * rejected a signed thinking block bound to a different prefix (the binding
 * 400). OpenCode 2 reports provider failures only through its session event
 * stream, so it arms here, as OpenCode 1's event handler does; the next pass
 * then strips the reasoning of every assistant still carrying it. Without the
 * arm, every later prompt would resend the same rejected block. Arms only for
 * prefix-bound models (the same rule as OpenCode 1). Returns whether the error
 * was this rejection.
 */
export function armThinkingBindingRecoveryFromError(args: {
    db: ContextDatabase;
    sessionId: string;
    error: unknown;
    providerID?: string;
    modelID?: string;
    /** The host event the error came from, for the log line. */
    source: string;
}): boolean {
    const mismatch = detectThinkingBindingMismatch(args.error);
    if (!mismatch.isBindingMismatch) return false;
    if (!isPrefixBoundThinkingModel(args.providerID, args.modelID)) return true;
    armBindingRecoverySafely(args.db, args.sessionId);
    sessionLog(
        args.sessionId,
        `thinking binding recovery armed from ${args.source} (provider paths: failing=${mismatch.failingBlockPath ?? "?"} firstChanged=${mismatch.firstChangedPath ?? "?"})`,
    );
    // The last-known-good request still carries the rejected bytes.
    dropSlot(args.sessionId, "thinking-binding-recovery-arm");
    return true;
}
