import { ensureInstallInstanceId } from "../../features/magic-context/install-instance-id";
import { failedInvocationStatus } from "../../features/magic-context/subagent-token-capture";
import type { PluginContext } from "../../plugin/types";
import { log as defaultLog } from "../../shared/logger";
import { promptSyncWithValidatedOutputRetry } from "../../shared/model-suggestion-retry";
import { getSdkOutputLimit, getSdkWindowGeometry } from "../../shared/models-dev-cache";
import { modelBodyField } from "../../shared/resolve-fallbacks";
import type { Database } from "../../shared/sqlite";
import { createV1HiddenCompletionExecutor } from "./compartment-runner-historian";
import {
    type HiddenCompletion,
    type HiddenCompletionExecutor,
    HiddenCompletionRefusal,
} from "./compartment-runner-types";
import {
    resolveHistorianProducerLimits,
    resolveKnownHistorianContextLimit,
} from "./derive-budgets";
import { historianProducerReserve, producerPromptFailureReason } from "./producer-window-guard";
import { estimateTokens } from "./read-session-formatting";

/**
 * The host half of the `historian.runner: "host"` lane.
 *
 * The module owns everything about a fold except the model call: it decides when
 * to fire, assembles the chunk, builds the prompt, validates the answer and runs
 * the publish CAS. When the runner is `host` it stops short of the completion and
 * queues the assembled request instead. This is what takes those queued runs and
 * answers them.
 *
 * One loop serves every session this process has open, because a claimant
 * discovers runs by polling rather than by already knowing which session produced
 * them. The four operations it uses are the module's management ops, pinned by
 * `crates/mc-module/testdata/historian-claim-wire-golden.json`:
 *
 *   historian.pending    what is waiting for a claimant
 *   historian.claim      take one, under an attempt and token the module mints
 *   historian.heartbeat  say the claim is still alive
 *   historian.complete   the terminal report: one text, or one failure
 *
 * Three rules shape everything below.
 *
 * 1. **Refusals are ordinary.** Losing a claim race, or holding a token that was
 *    replaced, is normal operation for a poller. The answer is always to move on
 *    to the next run, never to retry the same attempt: the module mints the
 *    attempt and the token, so a claimant cannot re-present a claim it has lost.
 *    A refused HEARTBEAT is the one that ends a run in flight: whatever the code,
 *    it means the claim this host is working under is over, so the completion is
 *    abandoned and nothing is reported.
 *
 * 2. **A slow run must not block an unrelated one.** A completion legitimately
 *    takes minutes. Claims are therefore started and then left to run on their
 *    own, so a fold for one session never delays claiming a run for another.
 *
 * 3. **One claim per session at a time.** The module allows one firing per
 *    session anyway; taking a second here would spend a provider call on a run
 *    whose report could never be admitted.
 *
 * The loop is per project, and its requests ride a route bound to that project.
 * The module scopes the lane to the caller's binding, so an unbound caller is
 * refused and a bound one only ever sees its own project's runs. That matters
 * here for more than tidiness: a claim hands back the folded transcript, so a
 * loop that could poll across projects could read another project's
 * conversation.
 */

/** The four module ops this lane uses. */
export type HistorianHostMethod =
    | "historian.pending"
    | "historian.claim"
    | "historian.heartbeat"
    | "historian.complete";

/** Model-attempt usage sent to the Rust module, which assigns invocation ids and fallback parent ids. */
interface HistorianHostInvocation {
    provider_id: string | null;
    model_id: string | null;
    started_at: number;
    ended_at: number;
    status: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    error: string | null;
}

export interface HistorianHostPendingRun {
    runId: string;
    sessionId: string;
    chunkFingerprint: string;
    promptBytesLen: number;
    /** When the RUN stops being worth running. Not the lease. */
    deadlineMs: number;
}

export interface HistorianHostClaim {
    runId: string;
    sessionId: string;
    attempt: number;
    token: string;
    system: string;
    user: string;
    modelChain: string[];
    awaitBudgetMs: number;
    /**
     * The queuing request's per-attempt timeout, when the module sent one. Each model
     * gets this long, so the run is attempted the same way whichever host claims it.
     * A module that predates the field sends none, and the host's own
     * `attemptTimeoutMs` applies instead.
     */
    historianTimeoutMs?: number;
    claimDeadlineMs: number;
    heartbeatIntervalMs: number;
}

export interface HistorianHostExecutorBinding {
    executor: HiddenCompletionExecutor;
    sessionDirectory: string;
}

export interface HistorianHostRunnerDeps {
    /** Sends one management op to the module and returns its decoded body. */
    call(args: {
        method: HistorianHostMethod;
        sessionId: string;
        body: Record<string, unknown>;
    }): Promise<unknown>;
    /**
     * The persisted per-install identity this host presents when it claims. Not a
     * credential: what authorises a report is the attempt-scoped token the module
     * mints at claim time.
     */
    claimantInstanceId: string;
    /** The hidden completion carrier to run this session's prompt through. */
    openExecutor(sessionId: string): HistorianHostExecutorBinding | undefined;
    /**
     * Kill switch, read once per poll so an operator's edit takes effect on the
     * next pass instead of needing a restart.
     */
    enabled(): boolean;
    /** Output cap the user configured for the historian, when they configured one. */
    maxOutputTokens?: number;
    /**
     * The host's own `historian_timeout_ms`, sampled per claim. Used only when the
     * claim carries no per-attempt timeout of its own (a module that predates that
     * field): each model in the chain then gets this long before the next one is
     * tried. The claim's await budget still bounds the run as a whole. Absent on
     * both sides means each attempt may use the whole budget.
     */
    attemptTimeoutMs?(): number | undefined;
    /**
     * The configured OpenCode variant (for example a reasoning effort) for a chain
     * model, read from the host's current config. Claims carry model names only, so
     * without this every attempt would run the model with no variant, which leaves
     * models such as Claude Sonnet 5.5 with thinking off.
     */
    resolveVariant?(model: string): string | undefined;
    now?(): number;
    log?(message: string): void;
    /** How long an idle loop waits before looking again. */
    idleIntervalMs?: number;
    /** Test seam: replaces the wall-clock timers. */
    schedule?(callback: () => void, delayMs: number): () => void;
}

/**
 * A run whose deadline is this close is not worth claiming: the module has
 * effectively stopped waiting for it, so the provider call would be paid for and
 * then refused.
 */
const CLAIM_START_MARGIN_MS = 5_000;

/** How long an idle loop waits between polls when nothing is running. */
const IDLE_INTERVAL_MS = 30_000;

/**
 * How many times the loop looks again on its own after a pass found nothing.
 *
 * Runs are only ever queued by a transform pass, so the pass is the real clock
 * and this is a safety net for a run queued by a pass that has already ended.
 * Bounded rather than perpetual: an idle project must not keep a timer alive
 * asking a question whose answer cannot change until something else happens.
 */
const IDLE_POLLS_AFTER_PASS = 3;

interface ActiveRun {
    claim: HistorianHostClaim;
    abort: AbortController;
    settled: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** The module answers a lost race with `{ok: false, refusal}`, not an error frame. */
function refusalOf(response: unknown): string | null {
    if (!isRecord(response)) return "malformed_response";
    if (response.ok === true) return null;
    const refusal = response.refusal;
    return typeof refusal === "string" && refusal.length > 0 ? refusal : "malformed_response";
}

function readPendingRuns(response: unknown): HistorianHostPendingRun[] {
    if (!isRecord(response) || !Array.isArray(response.runs)) return [];
    const runs: HistorianHostPendingRun[] = [];
    for (const entry of response.runs) {
        if (!isRecord(entry)) continue;
        const runId = entry.run_id;
        const sessionId = entry.session_id;
        if (typeof runId !== "string" || typeof sessionId !== "string") continue;
        runs.push({
            runId,
            sessionId,
            chunkFingerprint:
                typeof entry.chunk_fingerprint === "string" ? entry.chunk_fingerprint : "",
            promptBytesLen: typeof entry.prompt_bytes_len === "number" ? entry.prompt_bytes_len : 0,
            deadlineMs: typeof entry.deadline_ms === "number" ? entry.deadline_ms : 0,
        });
    }
    return runs;
}

function readClaim(response: unknown): HistorianHostClaim | null {
    if (!isRecord(response) || response.ok !== true) return null;
    const prompt = isRecord(response.prompt) ? response.prompt : {};
    const runId = response.run_id;
    const sessionId = response.session_id;
    const token = response.token;
    const system = prompt.system;
    const user = prompt.user;
    if (
        typeof runId !== "string" ||
        typeof sessionId !== "string" ||
        typeof token !== "string" ||
        typeof system !== "string" ||
        typeof user !== "string"
    ) {
        return null;
    }
    const modelChain = Array.isArray(response.model_chain)
        ? response.model_chain.filter((entry): entry is string => typeof entry === "string")
        : [];
    return {
        runId,
        sessionId,
        attempt: typeof response.attempt === "number" ? response.attempt : 0,
        token,
        system,
        user,
        modelChain,
        awaitBudgetMs: typeof response.await_budget_ms === "number" ? response.await_budget_ms : 0,
        ...(typeof response.historian_timeout_ms === "number" &&
        Number.isFinite(response.historian_timeout_ms) &&
        response.historian_timeout_ms > 0
            ? { historianTimeoutMs: response.historian_timeout_ms }
            : {}),
        claimDeadlineMs:
            typeof response.claim_deadline_ms === "number" ? response.claim_deadline_ms : 0,
        heartbeatIntervalMs:
            typeof response.heartbeat_interval_ms === "number"
                ? response.heartbeat_interval_ms
                : 30_000,
    };
}

/**
 * Settle with `work`, or fail once `remainingMs` runs out or `signal` aborts. The
 * failures carry the retry helper's own timeout and abort messages, so it treats
 * them exactly as it treats the carrier's `attempt` call running out of time or
 * being aborted.
 */
async function withinAttempt<T>(
    work: Promise<T>,
    remainingMs: number,
    attemptMs: number,
    signal: AbortSignal,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
        const fail = () =>
            reject(
                signal.aborted
                    ? new Error("prompt aborted by external signal")
                    : new Error(`prompt timed out after ${attemptMs}ms`),
            );
        if (signal.aborted) return fail();
        timer = setTimeout(fail, Math.max(0, remainingMs));
        onAbort = fail;
        signal.addEventListener("abort", onAbort, { once: true });
    });
    // A late rejection from the abandoned carrier call has nobody left to observe it.
    work.catch(() => {});
    try {
        return await Promise.race([work, expired]);
    } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * Give the module the claimant's own word for what went wrong. The module's
 * failure taxonomy treats these exactly as it treats an in-module producer error,
 * so the vocabulary matters: `chain_exhausted` feeds the provider backoff,
 * `aborted` does not.
 */
function failureCode(error: unknown, aborted: boolean): string {
    if (aborted) return "aborted";
    if (error instanceof HiddenCompletionRefusal) return "local_refusal";
    const text = describeError(error).toLowerCase();
    if (text.includes("all models exhausted") || text.includes("all fallback models failed")) {
        return "chain_exhausted";
    }
    if (text.includes("timed out") || text.includes("timeout")) return "timed_out";
    return "run_failed";
}

export class HistorianHostRunner {
    private readonly active = new Map<string, ActiveRun>();
    private readonly unknownWindows = new Set<string>();
    private polling: Promise<void> | null = null;
    private idleCancel: (() => void) | null = null;
    private idlePollsLeft = 0;
    private disabledLogged = false;
    private pendingRefusalLogged: string | null = null;
    private stopped = false;

    constructor(private readonly deps: HistorianHostRunnerDeps) {}

    /** Sessions this host currently holds a claim for. Diagnostics and tests. */
    inFlightSessions(): string[] {
        return [...this.active.keys()];
    }

    /**
     * Look for work once, on behalf of a transform pass.
     *
     * Safe to call from every pass: a poll already in flight is joined rather than
     * queued behind, so a burst of passes costs one round trip and not one each.
     */
    pump(routeSessionId: string): Promise<void> {
        this.idlePollsLeft = IDLE_POLLS_AFTER_PASS;
        return this.poll(routeSessionId);
    }

    /**
     * Abandon every claim this host holds and stop looking for more.
     *
     * Reports are deliberately NOT sent for the abandoned runs. The module's lease
     * is what recovers them: after it lapses the same or another claimant takes the
     * run under a new attempt, which is the behaviour a crash would produce anyway,
     * and it is better tested for being the only path.
     */
    async stop(): Promise<void> {
        this.stopped = true;
        this.cancelIdle();
        const settled = [...this.active.values()].map((run) => {
            run.abort.abort(new Error("historian host runner stopped"));
            return run.settled;
        });
        await Promise.allSettled(settled);
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now();
    }

    private log(message: string): void {
        (this.deps.log ?? defaultLog)(`[magic-context] historian host runner: ${message}`);
    }

    private poll(routeSessionId: string): Promise<void> {
        if (this.polling) return this.polling;
        const pass = this.runPoll(routeSessionId)
            .catch((error) => {
                // A poll is best-effort. The module is the durable record of what is
                // outstanding, so a failed look costs one cycle and nothing else.
                //
                // Deduplicated on the same key a refused poll uses. The module
                // answers a scope or version fault with an error FRAME rather than a
                // refusal body, so without this the one fault an operator most needs
                // to see once - this host is asking a question it is not allowed to
                // ask - would print on every transform pass for as long as the
                // misconfiguration lasts.
                const failure = `poll failed: ${describeError(error)}`;
                if (this.pendingRefusalLogged !== failure) {
                    this.pendingRefusalLogged = failure;
                    this.log(failure);
                }
            })
            .finally(() => {
                this.polling = null;
                this.armIdle(routeSessionId);
            });
        this.polling = pass;
        return pass;
    }

    private async runPoll(routeSessionId: string): Promise<void> {
        if (this.stopped) return;
        if (!this.deps.enabled()) {
            if (!this.disabledLogged) {
                this.disabledLogged = true;
                this.log(
                    "disabled by historian.host_runner.enabled=false; queued runs are left for another claimant",
                );
            }
            return;
        }
        this.disabledLogged = false;
        // `v` is read by the module: a request without it, or with a version this
        // module does not serve, is a bad request rather than something quietly
        // given v1 semantics.
        const response = await this.deps.call({
            method: "historian.pending",
            sessionId: routeSessionId,
            body: { v: 1 },
        });
        const refusal = refusalOf(response);
        if (refusal !== null) {
            // The lane is scoped to the caller's project binding. A refusal here is
            // a wiring fault, not a race, so say it once rather than every pass.
            if (this.pendingRefusalLogged !== refusal) {
                this.pendingRefusalLogged = refusal;
                this.log(`the module refused this host's poll: ${refusal}`);
            }
            return;
        }
        this.pendingRefusalLogged = null;
        const runs = readPendingRuns(response);
        for (const run of runs) {
            if (this.stopped || !this.deps.enabled()) return;
            // One claim per session in flight: the module admits one firing per
            // session, so a second claim here would buy a completion whose report
            // could never be published.
            if (this.active.has(run.sessionId)) continue;
            if (run.deadlineMs > 0 && run.deadlineMs - this.now() <= CLAIM_START_MARGIN_MS) {
                continue;
            }
            const claim = await this.claim(run);
            // A refusal means somebody else won or the run moved on. Both are answered
            // the same way: take the next run, never re-present this attempt.
            if (!claim) continue;
            // stop() may have run while the claim was on the wire. It only aborts runs
            // already started, so starting this one now would pay for a completion
            // after shutdown. Leave it unreported, as stop() leaves every claim it
            // abandons: the lease lapses and hands the run to the next claimant.
            if (this.stopped) {
                this.log(`run ${claim.runId} left for the lease: this host is stopping`);
                return;
            }
            // Started, not awaited. This is the head-of-line rule: a fold for one
            // session runs for minutes and must not delay claiming another's.
            this.start(claim);
        }
    }

    private async claim(run: HistorianHostPendingRun): Promise<HistorianHostClaim | null> {
        let response: unknown;
        try {
            response = await this.deps.call({
                method: "historian.claim",
                sessionId: run.sessionId,
                body: {
                    v: 1,
                    run_id: run.runId,
                    claimant_instance_id: this.deps.claimantInstanceId,
                },
            });
        } catch (error) {
            this.log(`claim for ${run.runId} could not be sent: ${describeError(error)}`);
            return null;
        }
        const refusal = refusalOf(response);
        if (refusal !== null) {
            this.log(`claim for ${run.runId} refused: ${refusal}`);
            return null;
        }
        const claim = readClaim(response);
        if (!claim) {
            this.log(`claim for ${run.runId} answered with a body this host cannot read`);
            return null;
        }
        if (claim.modelChain.length === 0) {
            // Nothing to run it on. Report it rather than sitting on the claim: the
            // module turns this into the same no-models failure its own lane reports.
            this.log(`claim for ${claim.runId} carries no model chain`);
            void this.report(claim, {
                error: { code: "no_models", message: "host runner has no model to run this on" },
            });
            return null;
        }
        return claim;
    }

    private start(claim: HistorianHostClaim): void {
        const abort = new AbortController();
        const run: ActiveRun = { claim, abort, settled: Promise.resolve() };
        // Registered before the completion starts so the next iteration of the poll
        // already sees this session as taken.
        this.active.set(claim.sessionId, run);
        run.settled = this.execute(claim, abort)
            .catch((error) => {
                this.log(`run ${claim.runId} ended unexpectedly: ${describeError(error)}`);
            })
            .finally(() => {
                if (this.active.get(claim.sessionId) === run) this.active.delete(claim.sessionId);
            });
    }

    private async execute(claim: HistorianHostClaim, abort: AbortController): Promise<void> {
        const invocations: HistorianHostInvocation[] = [];
        const budgetMs = Math.max(1, claim.awaitBudgetMs);
        const heartbeat = this.startHeartbeat(claim, abort);
        // The claim is never held past the budget the module handed out. Past it the
        // module has stopped waiting, so continuing would only spend provider time on
        // an answer nobody will read.
        const cancelDeadline = this.schedule(() => {
            abort.abort(new Error(`historian host run ${claim.runId} exceeded its await budget`));
        }, budgetMs);
        try {
            const completion = await this.runCompletion(claim, budgetMs, abort.signal, invocations);
            if (heartbeat.claimOver) return;
            await this.report(claim, {
                output: { text: completion.text, length_capped: completion.lengthCapped },
                invocations,
            });
        } catch (error) {
            // The module already said this claim is over — replaced, or on a run it
            // has stopped waiting for. Either way the report would be refused before
            // it was read, so the only thing left to do is stop.
            if (heartbeat.claimOver) {
                this.log(`run ${claim.runId} dropped: the module ended this claim`);
                return;
            }
            // Shutting down is not a fold failure. Reporting one would abandon the
            // firing and arm the module's failure cooldown for something no model
            // did; letting the lease lapse instead hands the same run to the next
            // claimant and the fold still lands.
            if (this.stopped) {
                this.log(`run ${claim.runId} left for the lease: this host is stopping`);
                return;
            }
            await this.report(claim, {
                error: {
                    code: failureCode(error, abort.signal.aborted),
                    message: describeError(error),
                },
                invocations,
            });
        } finally {
            cancelDeadline();
            heartbeat.stop();
        }
    }

    /**
     * Say the claim is still alive, and notice when it is not.
     *
     * A refusal here is terminal for this run whatever its code says. The module
     * has three reasons to refuse: the token was replaced (`superseded_token`),
     * nobody holds the run (`not_claimed`), or the run itself outlived its
     * deadline (`run_expired` / `not_pending`). All three mean the same thing to a
     * claimant — the completion in flight can no longer be delivered, so stop
     * paying for it and do not send a report.
     */
    private startHeartbeat(
        claim: HistorianHostClaim,
        abort: AbortController,
    ): { stop: () => void; readonly claimOver: boolean } {
        const intervalMs = Math.max(1_000, claim.heartbeatIntervalMs);
        let cancel: (() => void) | null = null;
        let stopped = false;
        const state = { claimOver: false };
        const beat = async (): Promise<void> => {
            if (stopped) return;
            let response: unknown;
            try {
                response = await this.deps.call({
                    method: "historian.heartbeat",
                    sessionId: claim.sessionId,
                    body: { v: 1, run_id: claim.runId, token: claim.token },
                });
            } catch (error) {
                // A heartbeat that could not be sent is not evidence the claim is gone;
                // the module's lease is generous enough to survive a missed beat.
                this.log(`heartbeat for ${claim.runId} could not be sent: ${describeError(error)}`);
                if (!stopped) cancel = this.schedule(() => void beat(), intervalMs);
                return;
            }
            const refusal = refusalOf(response);
            if (refusal !== null) {
                state.claimOver = true;
                stopped = true;
                this.log(`heartbeat for ${claim.runId} refused: ${refusal}; abandoning this claim`);
                abort.abort(new Error(`historian host claim ${claim.runId} was ${refusal}`));
                return;
            }
            if (!stopped) cancel = this.schedule(() => void beat(), intervalMs);
        };
        cancel = this.schedule(() => void beat(), intervalMs);
        return {
            stop: () => {
                stopped = true;
                cancel?.();
            },
            get claimOver() {
                return state.claimOver;
            },
        };
    }

    /**
     * Why the claim's prompt cannot be sent to `key`, or null when it fits or the
     * model's window is unknown (the prompt then goes out unguarded).
     */
    private admissionFailure(claim: HistorianHostClaim, key: string | undefined): string | null {
        if (!key) return null;
        const [provider, ...parts] = key.split("/");
        const known = resolveKnownHistorianContextLimit(key);
        const learned =
            provider && parts.length
                ? getSdkWindowGeometry(provider, parts.join("/"))?.derivation.window
                : undefined;
        const window =
            known === undefined
                ? learned
                : learned === undefined
                  ? known
                  : Math.min(known, learned);
        if (window === undefined && !this.unknownWindows.has(key)) {
            this.unknownWindows.add(key);
            this.log(`producer window unknown for ${key}: sending unguarded`);
        }
        const output =
            provider && parts.length ? getSdkOutputLimit(provider, parts.join("/")) : undefined;
        const producerLimits = resolveHistorianProducerLimits(key);
        const context =
            producerLimits.context ?? (producerLimits.input === undefined ? window : undefined);
        const reserve = historianProducerReserve(context, undefined, output);
        const failure = producerPromptFailureReason({
            sourceLocal: estimateTokens(claim.user),
            systemLocal: estimateTokens(claim.system),
            toolsLocal: 0,
            modelKey: key,
            contextLimitTokens: context,
            inputLimitTokens: producerLimits.input,
            maxOutputTokens: reserve,
        });
        return failure ? `${key}: ${failure}` : null;
    }

    private async runCompletion(
        claim: HistorianHostClaim,
        budgetMs: number,
        signal: AbortSignal,
        invocations: HistorianHostInvocation[],
    ): Promise<{ text: string; lengthCapped: boolean }> {
        const binding = this.deps.openExecutor(claim.sessionId);
        if (!binding) {
            throw new Error(`no hidden completion carrier for session ${claim.sessionId}`);
        }
        const { executor, sessionDirectory } = binding;
        const [head, ...rest] = claim.modelChain;
        const configuredAttemptMs = claim.historianTimeoutMs ?? this.deps.attemptTimeoutMs?.();
        const attemptMs =
            typeof configuredAttemptMs === "number" && configuredAttemptMs > 0
                ? Math.min(budgetMs, configuredAttemptMs)
                : budgetMs;
        // Admit the prompt before opening a child: when no model in the chain can
        // hold it, every attempt would be refused, and opening first left one more
        // hidden session behind per refused claim.
        const admissionFailures = claim.modelChain.map((model) =>
            this.admissionFailure(claim, model),
        );
        if (
            admissionFailures.length > 0 &&
            admissionFailures.every((failure) => failure !== null)
        ) {
            throw new Error(admissionFailures[0] ?? "historian prompt does not fit any model");
        }
        const handle = await executor.open({
            parentSessionId: claim.sessionId,
            agent: "historian",
            kind: "historian",
            system: claim.system,
            model: head,
            configuredModels: claim.modelChain,
            timeoutMs: budgetMs,
            ...(typeof this.deps.maxOutputTokens === "number" && this.deps.maxOutputTokens > 0
                ? { maxOutputTokens: this.deps.maxOutputTokens }
                : {}),
            title: `magic-context-historian-${claim.runId}`,
            directory: sessionDirectory,
        });
        let promptSettled = false;
        // When the current model's attempt started. The retry helper times the
        // carrier's `attempt` call; a carrier that returns from `attempt` at once and
        // waits inside `collect` would escape that timeout, so `collect` is held to
        // whatever is left of the same per-attempt window.
        let attemptStartedAt = Date.now();
        const withVariant = (model: string) => {
            const qualifier = this.deps.resolveVariant?.(model);
            return qualifier ? { model, qualifier } : model;
        };
        let attemptModel = head;
        let attemptRecorded = false;
        const recordAttempt = (completion?: HiddenCompletion, error?: unknown): void => {
            if (attemptRecorded) return;
            attemptRecorded = true;
            const split = attemptModel.indexOf("/");
            const token = (value: number | undefined): number =>
                typeof value === "number" && Number.isFinite(value)
                    ? Math.max(0, Math.floor(value))
                    : 0;
            invocations.push({
                provider_id:
                    completion?.providerId ?? (split >= 0 ? attemptModel.slice(0, split) : null),
                model_id:
                    completion?.modelId ??
                    (split >= 0 ? attemptModel.slice(split + 1) : attemptModel),
                started_at: attemptStartedAt,
                ended_at: Date.now(),
                status: error
                    ? signal.aborted
                        ? "aborted"
                        : failedInvocationStatus(error)
                    : completion?.text?.trim()
                      ? "completed"
                      : "empty",
                input_tokens: token(completion?.usage.input),
                output_tokens: token(completion?.usage.output),
                cache_read_tokens: token(completion?.usage.cacheRead),
                cache_write_tokens: token(completion?.usage.cacheWrite),
                error: error ? describeError(error) : null,
            });
        };
        try {
            if (!handle.id) throw new Error("hidden completion carrier returned no session id");
            const run = await promptSyncWithValidatedOutputRetry(
                // The carrier owns dispatch and output reading, so the SDK client is
                // never consulted — a completion-only host does not need one.
                undefined as never,
                {
                    path: { id: handle.id },
                    cacheTail: "skip",
                    query: { directory: sessionDirectory },
                    body: {
                        agent: "historian",
                        system: claim.system,
                        ...modelBodyField(withVariant(head)),
                        parts: [{ type: "text", text: claim.user, synthetic: true }],
                    },
                },
                {
                    transport: Object.assign(
                        (request: Parameters<typeof executor.attempt>[1]) => {
                            const model = request.body?.model;
                            const key =
                                model?.providerID && model?.modelID
                                    ? `${model.providerID}/${model.modelID}`
                                    : head;
                            attemptStartedAt = Date.now();
                            attemptModel = key;
                            attemptRecorded = false;
                            try {
                                const failure = this.admissionFailure(claim, key);
                                if (failure) throw new Error(failure);
                                return executor.attempt(handle, request).catch((error: unknown) => {
                                    recordAttempt(undefined, error);
                                    throw error;
                                });
                            } catch (error) {
                                recordAttempt(undefined, error);
                                throw error;
                            }
                        },
                        { childSessionId: handle.childSessionId },
                    ),
                    timeoutMs: attemptMs,
                    signal,
                    fallbackModels: rest.map(withVariant),
                    // Rust supplies the complete allowed chain; provider suggestions are not entries.
                    allowModelSuggestions: false,
                    callContext: `historian-host:${claim.runId}`,
                    fetchOutput: () =>
                        withinAttempt(
                            executor.collect(handle, 50),
                            attemptStartedAt + attemptMs - Date.now(),
                            attemptMs,
                            signal,
                        ).catch((error: unknown) => {
                            recordAttempt(undefined, error);
                            throw error;
                        }),
                    validateOutput: (completion) => {
                        const text = completion.text;
                        // A model that answered with nothing has failed, so the next
                        // model in the chain gets the same prompt. A length-capped
                        // document is deliberately NOT rejected here: the module refuses
                        // it with the same rule it applies to its own producer, and
                        // swallowing it would trade that precise refusal for a vague one.
                        if (!text?.trim()) {
                            const error = new Error("historian host completion returned no output");
                            recordAttempt(completion, error);
                            throw error;
                        }
                        recordAttempt(completion);
                        return { text, lengthCapped: completion.lengthCapped === true };
                    },
                },
            );
            promptSettled = true;
            return run.validated;
        } catch (error) {
            recordAttempt(undefined, error);
            throw error;
        } finally {
            await executor.close(handle, {
                promptSettled,
                privacySensitive: true,
                context: `[historian-host] ${claim.runId}`,
                log: (message: string) => this.log(message),
            });
        }
    }

    /**
     * Hand the module the terminal report.
     *
     * Exactly one is sent per claim and it is never resent. `{ok: true}` means the
     * module took the text, not that a fold landed: validation and the publish CAS
     * can still refuse it, and the fold is observed on a later pass either way.
     */
    private async report(
        claim: HistorianHostClaim,
        body: (
            | { output: { text: string; length_capped: boolean } }
            | { error: { code: string; message: string } }
        ) & { invocations?: HistorianHostInvocation[] },
    ): Promise<void> {
        let response: unknown;
        try {
            response = await this.deps.call({
                method: "historian.complete",
                sessionId: claim.sessionId,
                body: { v: 1, run_id: claim.runId, token: claim.token, ...body },
            });
        } catch (error) {
            this.log(`report for ${claim.runId} could not be sent: ${describeError(error)}`);
            return;
        }
        const refusal = refusalOf(response);
        if (refusal !== null) {
            this.log(`report for ${claim.runId} refused: ${refusal}`);
            return;
        }
        const publish =
            isRecord(response) && typeof response.publish === "string"
                ? response.publish
                : "immediate";
        this.log(`report for ${claim.runId} accepted (publish=${publish})`);
    }

    private schedule(callback: () => void, delayMs: number): () => void {
        if (this.deps.schedule) return this.deps.schedule(callback, delayMs);
        const timer = setTimeout(callback, delayMs);
        // Never hold the process open for a poll or a heartbeat.
        (timer as unknown as { unref?: () => void }).unref?.();
        return () => clearTimeout(timer);
    }

    /**
     * Look again on a timer, a bounded number of times.
     *
     * Runs are queued by transform passes, so the pass is the clock this loop is
     * really tied to. The timer exists for the run queued by a pass that has since
     * ended, and it stops once it has asked a few times and found nothing, rather
     * than spinning forever on an idle project.
     */
    private armIdle(routeSessionId: string): void {
        this.cancelIdle();
        if (this.stopped) return;
        if (this.active.size === 0 && this.idlePollsLeft <= 0) return;
        this.idlePollsLeft -= 1;
        this.idleCancel = this.schedule(() => {
            this.idleCancel = null;
            void this.poll(routeSessionId);
        }, this.deps.idleIntervalMs ?? IDLE_INTERVAL_MS);
    }

    private cancelIdle(): void {
        this.idleCancel?.();
        this.idleCancel = null;
    }
}

/**
 * Build the loop for one host.
 *
 * The only host-specific part is the hidden completion carrier. A host that
 * already owns one (the OpenCode 2 child carrier, or a Pi runner) passes it in
 * and the loop uses it unchanged; a host that does not gets the OpenCode 1 child
 * session carrier built here from its SDK client. Nothing else about the loop
 * differs per host, which is the point: the module sees one claimant protocol
 * whoever is serving.
 */
export function createHistorianHostRunner(args: {
    call: HistorianHostRunnerDeps["call"];
    db: Database;
    client: PluginContext["client"] | undefined;
    /** The host's own carrier, when it has one. */
    hiddenCompletionExecutor?: HiddenCompletionExecutor;
    /** Where this session's completion should run, for carriers that need a directory. */
    sessionDirectory(sessionId: string): string;
    enabled(): boolean;
    maxOutputTokens?: number;
    attemptTimeoutMs?(): number | undefined;
    resolveVariant?(model: string): string | undefined;
    now?(): number;
    log?(message: string): void;
    idleIntervalMs?: number;
    schedule?(callback: () => void, delayMs: number): () => void;
}): HistorianHostRunner {
    return new HistorianHostRunner({
        call: args.call,
        // Persisted once per installation in context.db: every process of one install
        // presents the same id, before and after a restart. It is diagnostic only; the
        // claim CAS and the attempt-scoped token are what keep two processes apart.
        claimantInstanceId: ensureInstallInstanceId(args.db),
        openExecutor: (sessionId) => {
            const sessionDirectory = args.sessionDirectory(sessionId);
            const executor =
                args.hiddenCompletionExecutor ??
                (args.client
                    ? createV1HiddenCompletionExecutor(args.client, args.db, sessionDirectory)
                    : undefined);
            return executor ? { executor, sessionDirectory } : undefined;
        },
        enabled: args.enabled,
        ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
        ...(args.attemptTimeoutMs ? { attemptTimeoutMs: args.attemptTimeoutMs } : {}),
        ...(args.resolveVariant ? { resolveVariant: args.resolveVariant } : {}),
        ...(args.now ? { now: args.now } : {}),
        ...(args.log ? { log: args.log } : {}),
        ...(args.idleIntervalMs !== undefined ? { idleIntervalMs: args.idleIntervalMs } : {}),
        ...(args.schedule ? { schedule: args.schedule } : {}),
    });
}

export const __historianHostRunnerTest = {
    CLAIM_START_MARGIN_MS,
    IDLE_INTERVAL_MS,
    IDLE_POLLS_AFTER_PASS,
    readPendingRuns,
    readClaim,
    refusalOf,
    failureCode,
};
