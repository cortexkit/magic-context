// Channel 2 delivery: the synthetic-user-message ceiling nudge.
//
// The transform records a cycle-capped `pending` intent in `session_meta`
// (`channel2_nudge_state`) when its persisted rendered-tail predicate holds.
// This module DELIVERS that
// intent from the event handler (`message.updated`, both mid-turn
// "tool-calls" and final "stop" events), because `promptAsync` must run on an
// event boundary, not mid-transform. Primary sessions keep both delivery
// points; subagents are gated to a live run so a final "stop" cannot start a
// follow-up turn. Mid-turn delivery is deliberate: the
// queued user message is picked up by OpenCode's run loop at the next step
// boundary, warning the agent WHILE the reclaimable pile is growing instead
// of after the turn already ballooned.
//
// Lease state machine (cross-process CAS): pending -> claimed(token) -> delivered.
//   - claim `pending -> claimed` with a per-claim token before send (so two
//     processes can't both send from the same pending row)
//   - on confirmed success: token-CAS `claimed -> delivered` (current tail-reset
//     cycle consumed)
//   - on send failure: revert `claimed -> pending` (don't burn the one ceiling
//     nudge on a transient transport error)
//   - after a successful send: never revert to pending, even if confirmation
//     fails; the user message may already exist and re-arming duplicates it. If
//     a stale lease was healed and another process re-delivered, the token-CAS
//     misses and we leave that authoritative row alone instead of blindly
//     overwriting it.
//
// Delivery transport is the in-process client OpenCode hands the plugin
// (`input.client`). On OpenCode >= 1.17.7 that client routes through the live
// listener runtime when one exists, so `promptAsync` joins the in-flight runner
// mid-turn (the synthetic nudge is queued and the existing run picks it up at
// its next step) instead of starting a SECOND runner that would persist a
// duplicate assistant message. Earlier OpenCode had that duplicate-runner bug
// for plugin-issued prompts (anomalyco/opencode#28202), so we used to build a
// separate client aimed at the live HTTP listener + a reachability probe to
// avoid it; that's fixed upstream now, so the separate client + probe are gone.

import { randomUUID } from "node:crypto";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import {
    casChannel2NudgeClaim,
    casChannel2NudgeState,
    claimChannel2NudgeState,
    getChannel2NudgeClaim,
    getChannel2NudgeState,
} from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import { resolvePromptContext } from "../../shared/prompt-context";
import type { Database } from "../../shared/sqlite";
import {
    buildChannel2Reminder,
    type Channel1State,
    type Channel2PredicateBaseline,
    evaluateChannel2,
    reclaimableToolOutputCount,
    type ToolReclaimHint,
} from "./ctx-reduce-nudge";
import { isMidTurn } from "./read-session-db";

export interface Channel2DeliveryDeps {
    db: Database;
    /**
     * The in-process client OpenCode hands the plugin (`input.client`). Channel 2
     * delivers the synthetic-user ceiling nudge through `client.session.promptAsync`.
     * No-op when absent (e.g. a context with no client wired).
     */
    client?: unknown;
    /** Persisted reclaimable/total tail tokens, typed deltas, and generation validity. */
    baseline?: Channel2PredicateBaseline & Partial<Pick<Channel1State, "baselineParts">>;
    oldestReclaimableToolTags?: readonly ToolReclaimHint[];
    /** Module-owned directives are already predicate-validated; preserve their text verbatim. */
    directiveText?: string;
}

/**
 * Return whether a pending nudge may be delivered to this session.
 *
 * Primary sessions retain the existing behavior: their Channel-2 message is
 * delivered at the event boundary even when the assistant has just stopped.
 * OpenCode subagents are different because the same prompt API starts a new
 * turn once their run is terminal. Their live-run test therefore fails closed
 * when the terminal assistant message is visible, and it is repeated after
 * claiming so a completion racing the claim cannot turn into a new run.
 */
function subagentRunIsActive(deps: Channel2DeliveryDeps, sessionId: string): boolean {
    try {
        const meta = getOrCreateSessionMeta(deps.db, sessionId);
        if (!meta.isSubagent) return true;
        return isMidTurn(deps, sessionId);
    } catch (error) {
        sessionLog(
            sessionId,
            "channel2 subagent run-state check failed; refusing delivery:",
            error,
        );
        return false;
    }
}

function clearPendingChannel2Intent(db: Database, sessionId: string): void {
    try {
        if (casChannel2NudgeState(db, sessionId, "pending", "")) {
            sessionLog(sessionId, "channel2 intent cleared because the subagent run is terminal");
        }
    } catch (error) {
        sessionLog(
            sessionId,
            "channel2 terminal-run intent clear failed; leaving lease to heal:",
            error,
        );
    }
}

function releaseClaimWithoutDelivery(db: Database, sessionId: string, claimToken: string): void {
    try {
        if (casChannel2NudgeClaim(db, sessionId, "", claimToken)) {
            sessionLog(
                sessionId,
                "channel2 claim released because the subagent run completed before delivery",
            );
        }
    } catch (error) {
        sessionLog(
            sessionId,
            "channel2 terminal-run claim release failed; lease will heal:",
            error,
        );
    }
}

/**
 * Attempt to deliver a pending Channel 2 ceiling nudge for `sessionId`. Safe to
 * call on every step-boundary `message.updated`: it no-ops unless a `pending`
 * intent exists and a client is wired. Returns true only when a delivery was
 * confirmed (intent moved to `delivered`).
 */
export async function maybeDeliverChannel2(
    sessionId: string,
    deps: Channel2DeliveryDeps,
): Promise<boolean> {
    // Cheap pre-check: only proceed if an intent is pending.
    let state: string;
    try {
        state = getChannel2NudgeState(deps.db, sessionId);
    } catch {
        return false;
    }
    if (state !== "pending") return false;

    // A terminal subagent must never be re-awakened by a stale pending intent.
    // Primary sessions intentionally keep their existing step-boundary behavior.
    if (!subagentRunIsActive(deps, sessionId)) {
        clearPendingChannel2Intent(deps.db, sessionId);
        return false;
    }

    // Revalidate before delivering. Between arming and this step boundary the
    // agent may have reduced or appended enough typed mass to change the saved
    // predicate. A module directive is already validated by the module, so its
    // lease skips this TypeScript baseline check and preserves its text.
    //
    // An unavailable or generation-invalidated baseline holds `pending`; a known
    // false predicate cancels it to the re-armable empty state.
    const evaluation = evaluateChannel2(deps.baseline);
    if (deps.directiveText === undefined && !evaluation.evaluable) {
        return false;
    }
    if (deps.directiveText === undefined && !evaluation.shouldTrigger) {
        try {
            casChannel2NudgeState(deps.db, sessionId, "pending", "");
            sessionLog(
                sessionId,
                `channel2 intent cleared pre-delivery (U ${evaluation.reclaimableTokens}, T ${evaluation.tailTokens} — trigger no longer holds; re-armable)`,
            );
        } catch {
            // best-effort; if the CAS fails the next pass re-evaluates.
        }
        return false;
    }
    const effectiveU = evaluation.reclaimableTokens;

    const client = deps.client;
    if (!client) return false;

    // Claim the intent before sending so a sibling process can't send from the
    // same pending row; the token makes confirm/revert refuse healed stale leases.
    const claimToken = randomUUID();
    if (!claimChannel2NudgeState(deps.db, sessionId, claimToken)) {
        return false;
    }

    // The assistant can finish after the pre-check but before this delivery
    // attempt acquires its claim. Release the claim without sending if that
    // happens; the token prevents a concurrent lease from being changed.
    if (!subagentRunIsActive(deps, sessionId)) {
        releaseClaimWithoutDelivery(deps.db, sessionId, claimToken);
        return false;
    }

    try {
        const promptContext = await resolvePromptContext(client, sessionId);
        // Module directives carry their own validated wording; host-triggered
        // reminders use the measured reclaimable tail after the predicate above.
        const reminder =
            deps.directiveText ??
            buildChannel2Reminder(
                effectiveU,
                reclaimableToolOutputCount(deps.baseline?.baselineParts ?? []),
                deps.oldestReclaimableToolTags,
            );

        const body: Record<string, unknown> = {
            noReply: false,
            // synthetic: true — this is an agent-directed nudge, not a real user
            // turn. It still drives the run loop and reaches the model (OpenCode
            // serializes on !ignored && text!=="", and MessageV2.latest/the run
            // loop ignore `synthetic`), but it (a) skips OpenCode's queued-message
            // `<system-reminder>…Please address…` wrapper — which would otherwise
            // double-wrap our reminder AND flip wrapped↔unwrapped as lastFinished
            // advances, busting the prefix cache (issue #129 class) — and (b)
            // drops out of the TUI user-message render. MUST NOT be paired with
            // `ignored: true` (that would strip it from the model call).
            parts: [{ type: "text", text: reminder, synthetic: true }],
        };
        if (promptContext?.agent) body.agent = promptContext.agent;
        if (promptContext?.model) {
            body.model = {
                providerID: promptContext.model.providerID,
                modelID: promptContext.model.modelID,
            };
        }
        if (promptContext?.variant) body.variant = promptContext.variant;

        const session = (client as { session?: { promptAsync?: (i: unknown) => Promise<unknown> } })
            .session;
        if (typeof session?.promptAsync !== "function") {
            throw new Error("client has no session.promptAsync");
        }
        const claim = getChannel2NudgeClaim(deps.db, sessionId);
        if (claim.state !== "claimed" || claim.claimToken !== claimToken) {
            sessionLog(
                sessionId,
                `channel2 ceiling nudge delivery skipped: claim no longer owned before send (state=${claim.state || "empty"})`,
            );
            return false;
        }
        // resolvePromptContext yielded to the host. Re-check immediately before
        // promptAsync: a child that completed while the claim was queued must
        // leave its report as the last message, not start a follow-up turn.
        if (!subagentRunIsActive(deps, sessionId)) {
            releaseClaimWithoutDelivery(deps.db, sessionId, claimToken);
            return false;
        }
        await session.promptAsync({ path: { id: sessionId }, body });
    } catch (error) {
        // Revert only when the send itself failed. Once promptAsync returns, the
        // synthetic user message may already exist; re-arming can duplicate it.
        try {
            const restored = casChannel2NudgeClaim(deps.db, sessionId, "pending", claimToken);
            if (restored) {
                sessionLog(
                    sessionId,
                    "channel2 ceiling nudge delivery failed (will retry):",
                    error,
                );
            } else {
                sessionLog(
                    sessionId,
                    "channel2 ceiling nudge delivery failed after its claim was no longer owned; lease state left unchanged:",
                    error,
                );
            }
        } catch (revertError) {
            sessionLog(
                sessionId,
                "channel2 ceiling nudge delivery failed; pending restore was busy so the stale claim will heal later:",
                { deliveryError: error, revertError },
            );
        }
        return false;
    }

    try {
        // Confirmed: consume the current tail-reset cycle. The CAS result is
        // authoritative; a stolen/expired claim must not be treated as delivered.
        const confirmed = casChannel2NudgeClaim(deps.db, sessionId, "delivered", claimToken);
        if (confirmed) {
            sessionLog(sessionId, "channel2 ceiling nudge delivered");
            return true;
        }
        const claim = getChannel2NudgeClaim(deps.db, sessionId);
        sessionLog(
            sessionId,
            `channel2 ceiling nudge sent but claim confirmation was not ours (state=${claim.state || "empty"}); leaving existing lease state unchanged`,
        );
        return false;
    } catch (error) {
        // Post-send DB failure: do NOT revert to pending, because the send already
        // happened and retrying risks a duplicate ceiling nudge.
        sessionLog(
            sessionId,
            "channel2 ceiling nudge sent but token-confirm failed; lease state left unchanged:",
            error,
        );
        return false;
    }
}
