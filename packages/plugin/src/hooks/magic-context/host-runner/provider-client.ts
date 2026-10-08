import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sessionLog } from "../../../shared/logger";
import type { RustModeModuleClient } from "../rust-mode-transform";
import {
    checkAnswerFence,
    encodedBytes,
    encodeHookRequest,
    encodeStatusPage,
    issueRequest,
    MAX_REQUEST_BYTES,
    type RunnerRecord,
    type StatusPage,
    type StatusRequestControl,
    statusPages,
} from "./record";

export type ProviderMethod =
    | "transform.declare"
    | "transform.hook"
    | "compaction.setup"
    | "compaction.step";

// JavaScript numbers cannot losslessly represent the full Rust u64 domain. Reject
// unsafe integers rather than silently rounding them; real ordinals, timestamps,
// versions and budgets stay far below 2^53. Decoding is still not permission to
// apply a view: the record's fence, version and structural checks must also pass.
const u64 = z.number().refine((n) => Number.isSafeInteger(n) && n >= 0);
// Part identities are opaque UTF-8 bytes, not a character-count or JSON-escape budget.
const subjectPartSchema = z.string().refine((part) => part.length > 0 && encodedBytes(part) <= 256);
const unservedSubjectsSchema = z.array(
    z
        .object({
            subject_mid: z.string(),
            hook: z.enum(["pre_user", "post_assistant", "post_tool"]),
            subject_part: subjectPartSchema.optional(),
        })
        .passthrough(),
);
const u32 = z.number().int().min(0).max(0xffff_ffff);
const object = z.record(z.string(), z.unknown());
const phase = z.enum(["mutate", "validate", "approve"]);
const opName = z.enum(["prepend", "append", "replace"]);
const unavailablePolicy = z.enum(["pass", "refuse"]);
const subscriptionSchema = z
    .object({
        hook: z.enum(["pre_user", "post_assistant", "pre_tool", "post_tool"]),
        phase: phase.optional(),
        tools: z.array(z.string()).optional(),
        ops: z.array(opName),
        on_unavailable: unavailablePolicy.optional(),
        budget_ms: u64,
    })
    .passthrough();
const declarationSchema = z.object({ subscriptions: z.array(subscriptionSchema) }).passthrough();
const declareSchema = z
    .object({
        preset: z.string().optional(),
        params: object.default({}),
        composition: object.optional(),
    })
    .passthrough();
const descentSchema = z.object({ lineage_id: z.string(), through_ordinal: u64 }).passthrough();
const newestSchema = z.object({ ordinal: u64, mid: z.string() }).passthrough();
const commonHook = {
    session: z.string(),
    harness: z.string(),
    lineage_id: z.string().optional(),
    preset: z.string().optional(),
    params: object.default({}),
    subject_mid: z.string().optional(),
    subject_ordinal: u64.optional(),
    message: z.unknown().optional(),
    descends_from: descentSchema.optional(),
    subject_part: subjectPartSchema.optional(),
    served_through_ordinal: u64.optional(),
    unserved_subjects: unservedSubjectsSchema.optional(),
    pass_complete: z.boolean().optional(),
};
const hookSchema = z.discriminatedUnion("hook", [
    z
        .object({
            ...commonHook,
            hook: z.literal("pre_user"),
            blocks: z.array(z.string()),
            mark: z.unknown().optional(),
            delivery: z.string().optional(),
        })
        .passthrough(),
    z
        .object({
            ...commonHook,
            hook: z.literal("post_assistant"),
            step_id: z.string(),
            blocks: z.array(z.string()),
        })
        .passthrough(),
    z
        .object({
            ...commonHook,
            hook: z.literal("pre_tool"),
            step_id: z.string(),
            phase,
            tool: z.string(),
            tool_call_id: z.string(),
            call_key: z.string().optional(),
            input: z.unknown(),
        })
        .passthrough(),
    z
        .object({
            ...commonHook,
            hook: z.literal("post_tool"),
            step_id: z.string(),
            tool: z.string(),
            tool_call_id: z.string(),
            call_key: z.string().optional(),
            blocks: z.array(z.string()),
            is_error: z.boolean(),
        })
        .passthrough(),
]);
const modelFields = {
    model: z.string(),
    variant: z.string().optional(),
    context_window: u64.optional(),
    output_limit: u64.optional(),
};
const setupSchema = z
    .object({
        session: z.string(),
        harness: z.string(),
        request_id: z.string(),
        preset: z.string().optional(),
        params: object.default({}),
        composition: object,
        ...modelFields,
        newest: newestSchema.optional(),
        lineage_id: z.string().optional(),
        now: u64,
    })
    .passthrough();
const compactionSchema = z
    .object({
        compaction_id: z.string(),
        version: u64,
        range: z.object({ from: u64, to: u64 }).passthrough(),
        replacement: z.array(z.unknown()),
    })
    .passthrough();
const viewIdentity = z.object({ compaction_id: z.string(), version: u64 }).passthrough();
const stepSchema = z
    .object({
        session: z.string(),
        harness: z.string(),
        request_id: z.string(),
        lineage_id: z.string(),
        descends_from: descentSchema.optional(),
        served_through_ordinal: u64.optional(),
        unserved_subjects: unservedSubjectsSchema.optional(),
        step_id: z.string(),
        step_kind: z.string(),
        ...modelFields,
        previous_usage: z
            .object({
                input: u64,
                cache_read: u64,
                cache_write: u64,
                output: u64,
                completed_at: u64,
                finish_reason: z.string(),
            })
            .passthrough()
            .optional(),
        previous_provider_code: z.string().optional(),
        estimate: z.object({ request_tokens: u64, previous_input: u64.optional() }).passthrough(),
        prefix_rebuilding: z.object({ reason: z.string() }).passthrough().optional(),
        newest: newestSchema.optional(),
        last_applied: viewIdentity.optional(),
        last_not_applied: viewIdentity.extend({ reason: z.string() }).optional(),
        after_ordinal: u64.optional(),
        messages: z.array(
            z.object({ ordinal: u64, mid: z.string(), message: z.unknown() }).passthrough(),
        ),
        more: z.boolean().optional(),
        now: u64,
    })
    .passthrough();
const operationSchema = z.discriminatedUnion("op", [
    z
        .object({
            op: z.literal("prepend"),
            block: u32,
            text: z.string(),
            note: z.string().optional(),
        })
        .passthrough(),
    z
        .object({
            op: z.literal("append"),
            block: u32,
            text: z.string(),
            note: z.string().optional(),
        })
        .passthrough(),
    z
        .object({
            op: z.literal("replace"),
            block: u32,
            value: z.string(),
            note: z.string().optional(),
        })
        .passthrough(),
]);
const hookAnswerSchema = z.discriminatedUnion("answer", [
    z.object({ answer: z.literal("pass") }).passthrough(),
    z.object({ answer: z.literal("ops"), ops: z.array(operationSchema) }).passthrough(),
    z
        .object({ answer: z.literal("mutate"), input: z.unknown(), note: z.string().optional() })
        .passthrough(),
    z.object({ answer: z.literal("deny"), text: z.string() }).passthrough(),
    z
        .object({
            answer: z.literal("ask"),
            ask: z
                .object({
                    prompt: z.string(),
                    options: z.array(z.string()).optional(),
                    expires_at_ms: u64,
                    on_expiry: z.literal("deny"),
                    material_damage: z.boolean(),
                    late_execution: z.enum(["execute", "notify_only"]),
                })
                .passthrough(),
        })
        .passthrough(),
]);
const refusalSchema = z
    .object({
        answer: z.literal("refuse"),
        request_id: z.string(),
        code: z.string(),
        reason: z.string(),
        provider_code: z.string().optional(),
        detail: z.object({ history_gap_from: u64.optional() }).passthrough().optional(),
    })
    .passthrough();
const setupAnswerSchema = z.discriminatedUnion("answer", [
    z
        .object({
            answer: z.literal("ready"),
            request_id: z.string(),
            initial: compactionSchema,
            stability: z.array(z.object({ index: u32, rank: u32 }).passthrough()).optional(),
            call_when: object.optional(),
        })
        .passthrough(),
    refusalSchema,
]);
const stepAnswerSchema = z.discriminatedUnion("answer", [
    z.object({ answer: z.literal("noop"), request_id: z.string() }).passthrough(),
    z
        .object({
            answer: z.literal("compaction_message"),
            request_id: z.string(),
            compaction: compactionSchema,
            coverage: z.object({ end_mid: z.string(), ordinal: u64 }).passthrough().optional(),
        })
        .passthrough(),
    z
        .object({
            answer: z.literal("wait"),
            request_id: z.string(),
            reason: z.string(),
            bound_ms: u64,
        })
        .passthrough(),
    refusalSchema,
]);
const requestSchemas = {
    "transform.declare": declareSchema,
    "transform.hook": hookSchema,
    "compaction.setup": setupSchema,
    "compaction.step": stepSchema,
};
const answerSchemas = {
    "transform.declare": declarationSchema,
    "transform.hook": hookAnswerSchema,
    "compaction.setup": setupAnswerSchema,
    "compaction.step": stepAnswerSchema,
};
export type ProviderRequests = { [K in ProviderMethod]: z.infer<(typeof requestSchemas)[K]> };
export type ProviderAnswers = { [K in ProviderMethod]: z.infer<(typeof answerSchemas)[K]> };

/** Lenient fields, closed discriminants. Validation/application belongs to the record and adapter. */
export function decodeProviderRequest<K extends ProviderMethod>(
    method: K,
    value: unknown,
): ProviderRequests[K] {
    return requestSchemas[method].parse(value) as ProviderRequests[K];
}
export function decodeProviderAnswer<K extends ProviderMethod>(
    method: K,
    value: unknown,
): ProviderAnswers[K] {
    return answerSchemas[method].parse(value) as ProviderAnswers[K];
}
export function encodeProviderRequest<K extends ProviderMethod>(
    method: K,
    params: ProviderRequests[K],
): string {
    decodeProviderRequest(method, params);
    return JSON.stringify({ method, params });
}

export interface FrozenProviderPlan {
    readonly preset?: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly subscriptions: readonly z.infer<typeof subscriptionSchema>[];
    readonly compaction_budget_ms: number;
}

/** Copy once at admission, not on ordinary passes. Restarts hydrate this same frozen data. */
export function freezeProviderPlan(
    declaration: ProviderAnswers["transform.declare"],
    item: { preset?: string; params: Record<string, unknown>; compaction_budget_ms?: number },
): FrozenProviderPlan {
    declarationSchema.parse(declaration);
    u64.parse(item.compaction_budget_ms ?? 2000);
    const plan: FrozenProviderPlan = JSON.parse(
        JSON.stringify({
            ...item,
            subscriptions: declaration.subscriptions,
            compaction_budget_ms: item.compaction_budget_ms ?? 2000,
        }),
    );
    function freeze(value: unknown): void {
        if (value && typeof value === "object") {
            for (const child of Object.values(value)) freeze(child);
            Object.freeze(value);
        }
    }
    for (const sub of plan.subscriptions) {
        if (
            sub.budget_ms <= 0 ||
            (sub.hook === "post_assistant" && sub.on_unavailable === "refuse")
        )
            throw new Error("Invalid frozen provider subscription");
    }
    if (plan.compaction_budget_ms <= 0) throw new Error("Invalid compaction budget");
    freeze(plan);
    return plan;
}

export interface ProviderFence {
    request_id: string;
    newest: number;
    lineage_id: string;
    deadline_ms: number;
}
export type ProviderResult<A> =
    | { status: "answered"; answer: A; request_id: string; arrived_ms: number }
    | {
          status: "unavailable";
          request_id?: string;
          reason:
              | "timeout"
              | "aborted"
              | "transport"
              | "invalid_answer"
              | "late"
              | "superseded_request"
              | "oversize"
              | "unexpected_wait"
              | "unexpected_compaction"
              | "in_flight";
          error?: unknown;
          on_unavailable?: "pass" | "refuse";
          /** H4 durably exits before switching this pass to the full-request path. */
          exit_reason?: "provider_message_too_large";
      };
export interface ProviderClientOptions {
    moduleClient: Pick<RustModeModuleClient, "call">;
    sessionId: string;
    projectRoot: string;
    harness: "opencode" | "opencode2";
    /** Must durably write the fence; a failure refuses the turn, never raw passthrough. */
    persistFence: (fence: ProviderFence) => Promise<void>;
    /** Globally fresh, including after restart; each encoded id must fit requestIdBytes. */
    newRequestId?: () => string;
    requestIdBytes?: number;
    now?: () => number;
    engineBudgetMs?: number;
}
export type HostHookSubject =
    | { hook: "pre_user"; blocks: string[]; mark?: unknown; delivery?: string }
    | { hook: "post_assistant"; step_id: string; blocks: string[] }
    | {
          hook: "post_tool";
          step_id: string;
          tool: string;
          tool_call_id: string;
          call_key?: string;
          blocks: string[];
          is_error: boolean;
      };
export type SetupInputs = Pick<
    ProviderRequests["compaction.setup"],
    "model" | "variant" | "context_window" | "output_limit" | "composition" | "newest"
>;
export type StepInputs = Pick<
    ProviderRequests["compaction.step"],
    | "step_id"
    | "step_kind"
    | "model"
    | "variant"
    | "context_window"
    | "output_limit"
    | "previous_usage"
    | "previous_provider_code"
    | "estimate"
    | "prefix_rebuilding"
    | "newest"
>;
export type PageResult = ProviderResult<ProviderAnswers["compaction.step"]> & { page: StatusPage };

/**
 * The client installs only issued fences. It never changes served bytes, cursor,
 * burn lists or views. H4 persists answers and uses H1's application checks before
 * serving them. A timed-out transport may finish remotely; its answer is ignored.
 */
export class ProviderClient {
    private busy = false;
    private readonly now: () => number;
    private readonly newId: () => string;
    private readonly idBytes: number;
    constructor(private readonly options: ProviderClientOptions) {
        this.now = options.now ?? Date.now;
        this.newId = options.newRequestId ?? randomUUID;
        this.idBytes = options.requestIdBytes ?? 38; // JSON string quotes around a UUID
        if (
            !Number.isSafeInteger(this.idBytes) ||
            this.idBytes < 3 ||
            this.idBytes > MAX_REQUEST_BYTES
        )
            throw new Error("Invalid request id byte budget");
    }
    private budget(ms: number): number {
        const engineBudget = this.options.engineBudgetMs ?? 2000;
        if (
            !Number.isSafeInteger(ms) ||
            ms <= 0 ||
            !Number.isSafeInteger(engineBudget) ||
            engineBudget <= 0
        )
            throw new Error("Invalid provider budget");
        return Math.min(ms, engineBudget);
    }
    private unservedSubjects<M>(record: RunnerRecord<M>) {
        // Validate and snapshot the burn identities without touching message content.
        // An absent list names no burns; empty lists are omitted from encoded calls.
        return record.unserved_subjects.length
            ? unservedSubjectsSchema.parse(record.unserved_subjects)
            : undefined;
    }
    private id(): string {
        const id = this.newId();
        if (!id || encodedBytes(JSON.stringify(id)) > this.idBytes)
            throw new Error("Provider request id exceeds reserved byte budget");
        return id;
    }
    private async exclusive<A>(run: () => Promise<ProviderResult<A>>): Promise<ProviderResult<A>> {
        if (this.busy) return { status: "unavailable", reason: "in_flight" };
        this.busy = true;
        try {
            return await run();
        } finally {
            this.busy = false;
        }
    }
    private async fence<M>(
        record: RunnerRecord<M>,
        id: string,
        budget: number,
    ): Promise<ProviderFence> {
        const fence = {
            request_id: id,
            newest: record.next_ordinal - 1,
            lineage_id: record.lineage_id,
            deadline_ms: this.now() + budget,
        };
        if (record.pipeline_exit || record.issued?.request_id === id)
            throw new Error("Invalid provider fence");
        const previousFence = record.issued;
        await this.options.persistFence(fence);
        if (
            record.lineage_id !== fence.lineage_id ||
            record.next_ordinal - 1 !== fence.newest ||
            record.issued !== previousFence ||
            record.pipeline_exit
        )
            throw new Error("Runner changed while persisting fence");
        issueRequest(record, id, fence.deadline_ms);
        return fence;
    }
    private async send<K extends ProviderMethod, M>(
        method: K,
        encoded: string,
        id: string,
        deadline: number,
        record?: RunnerRecord<M>,
        signal?: AbortSignal,
    ): Promise<ProviderResult<ProviderAnswers[K]>> {
        if (encodedBytes(encoded) > MAX_REQUEST_BYTES)
            return { status: "unavailable", request_id: id, reason: "oversize" };
        const remaining = deadline - this.now();
        if (remaining <= 0) return { status: "unavailable", request_id: id, reason: "timeout" };
        if (signal?.aborted) return { status: "unavailable", request_id: id, reason: "aborted" };
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => {
            onAbort = () => {
                abort.abort(signal?.reason);
                reject({ reason: "aborted" });
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            timer = setTimeout(() => {
                abort.abort();
                reject({ reason: "timeout" });
            }, remaining);
        });
        try {
            // The transport already supports pre-encoded JSON. Its historical method
            // union predates provider operations; this cast changes types, not routing.
            const response = await Promise.race([
                cancelled,
                this.options.moduleClient.call({
                    sessionId: this.options.sessionId,
                    projectRoot: this.options.projectRoot,
                    method: method as Parameters<RustModeModuleClient["call"]>[0]["method"],
                    body: new TextEncoder().encode(encoded),
                    signal: abort.signal,
                    timeoutMs: remaining,
                    generationSensitive: true,
                }),
            ]);
            const arrived = this.now();
            const rejection = record
                ? checkAnswerFence(record, id, arrived)
                : arrived >= deadline
                  ? "late"
                  : undefined;
            if (rejection) return { status: "unavailable", request_id: id, reason: rejection };
            let answer: ProviderAnswers[K];
            try {
                answer = decodeProviderAnswer(method, response);
            } catch (error) {
                return { status: "unavailable", request_id: id, reason: "invalid_answer", error };
            }
            if (
                (method === "compaction.step" || method === "compaction.setup") &&
                (answer as { request_id: string }).request_id !== id
            )
                return { status: "unavailable", request_id: id, reason: "superseded_request" };
            return { status: "answered", answer, request_id: id, arrived_ms: arrived };
        } catch (error) {
            const reason = abort.signal.aborted
                ? signal?.aborted
                    ? "aborted"
                    : "timeout"
                : "transport";
            return { status: "unavailable", request_id: id, reason, error };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    }
    declare(
        inputs: ProviderRequests["transform.declare"],
        budgetMs = 2000,
        signal?: AbortSignal,
    ): Promise<ProviderResult<ProviderAnswers["transform.declare"]>> {
        return this.exclusive(() => {
            // Declaration is pure config, so it has no conversation identity/fence.
            const id = this.id();
            return this.send(
                "transform.declare",
                encodeProviderRequest("transform.declare", inputs),
                id,
                this.now() + this.budget(budgetMs),
                undefined,
                signal,
            );
        });
    }
    setup<M>(
        record: RunnerRecord<M, FrozenProviderPlan>,
        inputs: SetupInputs,
        signal?: AbortSignal,
    ): Promise<ProviderResult<ProviderAnswers["compaction.setup"]>> {
        return this.exclusive(async () => {
            const id = this.id();
            const encoded = encodeProviderRequest("compaction.setup", {
                ...inputs,
                session: this.options.sessionId,
                harness: this.options.harness,
                request_id: id,
                lineage_id: record.lineage_id,
                preset: record.plan.preset,
                params: record.plan.params,
                now: this.now(),
            });
            if (encodedBytes(encoded) > MAX_REQUEST_BYTES)
                return { status: "unavailable", reason: "oversize" };
            const fence = await this.fence(
                record,
                id,
                this.budget(record.plan.compaction_budget_ms),
            );
            return this.send("compaction.setup", encoded, id, fence.deadline_ms, record, signal);
        });
    }
    hook<M>(
        record: RunnerRecord<M, FrozenProviderPlan>,
        subject: HostHookSubject & {
            subject_mid: string;
            subject_ordinal: number;
            subject_part?: string;
        },
        ingest: string,
        passComplete?: true,
        signal?: AbortSignal,
    ): Promise<ProviderResult<ProviderAnswers["transform.hook"]>> {
        return this.exclusive(async () => {
            const subscription = record.plan.subscriptions.find(
                (sub) =>
                    sub.hook === subject.hook &&
                    (!sub.tools ||
                        (subject.hook === "post_tool" && sub.tools.includes(subject.tool))),
            );
            if (!subscription) throw new Error("Hook not in frozen provider plan");
            const policy =
                subscription.on_unavailable ??
                (subject.hook === "post_assistant" ? "pass" : "refuse");
            const budget = this.budget(subscription.budget_ms);
            const id = this.id();
            const control = {
                ...subject,
                session: this.options.sessionId,
                harness: this.options.harness,
                lineage_id: record.lineage_id,
                request_id: id,
                preset: record.plan.preset,
                params: record.plan.params,
                served_through_ordinal: record.served_through_ordinal,
                unserved_subjects: this.unservedSubjects(record),
                descends_from: record.descends_from,
                pass_complete: passComplete,
                budget_ms: budget,
                on_unavailable: policy,
            };
            decodeProviderRequest("transform.hook", control);
            const encoded = encodeHookRequest(control, ingest);
            if (encodedBytes(encoded) > MAX_REQUEST_BYTES)
                return { status: "unavailable", reason: "oversize", on_unavailable: policy };
            const fence = await this.fence(record, id, budget);
            const result = await this.send(
                "transform.hook",
                encoded,
                id,
                fence.deadline_ms,
                record,
                signal,
            );
            if (result.status === "unavailable") return { ...result, on_unavailable: policy };
            if (result.answer.answer !== "pass" && result.answer.answer !== "ops")
                return {
                    status: "unavailable",
                    request_id: id,
                    reason: "invalid_answer",
                    on_unavailable: policy,
                };
            if (
                result.answer.answer === "ops" &&
                result.answer.ops.some(
                    (op) => !subscription.ops.includes(op.op) || op.block >= subject.blocks.length,
                )
            )
                return {
                    status: "unavailable",
                    request_id: id,
                    reason: "invalid_answer",
                    on_unavailable: policy,
                };
            return result;
        });
    }
    private controls<M>(
        record: RunnerRecord<M, FrozenProviderPlan>,
        inputs: StepInputs,
    ): StatusRequestControl {
        const control = {
            ...inputs,
            session: this.options.sessionId,
            harness: this.options.harness,
            request_id: "x".repeat(this.idBytes - 2),
            model: inputs.model,
            now: this.now(),
            preset: record.plan.preset,
            params: record.plan.params,
            last_applied: {
                compaction_id: record.view.compaction_id,
                version: record.view.version,
            },
            last_not_applied: record.last_not_applied,
            descends_from: record.descends_from,
            unserved_subjects: this.unservedSubjects(record),
        };
        // Validate status metadata alone: known ingest and served content must never
        // be read or reserialized just to check identities, numbers or extensions.
        decodeProviderRequest("compaction.step", {
            ...control,
            lineage_id: record.lineage_id,
            served_through_ordinal: record.served_through_ordinal,
            after_ordinal: record.after_ordinal,
            messages: [],
        });
        return control;
    }
    private planPages<M>(
        record: RunnerRecord<M, FrozenProviderPlan>,
        inputs: StepInputs,
    ): StatusPage[] | Extract<ProviderResult<never>, { status: "unavailable" }> {
        try {
            const pages = statusPages(record, this.controls(record, inputs));
            return pages.map((page) => {
                if (
                    page.control.more === true &&
                    inputs.prefix_rebuilding?.reason === "pipeline_switch"
                ) {
                    // Only the completed bootstrap may request the switch rebuild.
                    // Planning reserves the larger final-page controls before omission.
                    const control = { ...page.control };
                    delete control.prefix_rebuilding;
                    return { ...page, control };
                }
                return page;
            });
        } catch (error) {
            if (
                error instanceof Error &&
                (error.message === "Single-entry status exceeds request cap" ||
                    error.message === "Status control exceeds request cap")
            )
                return {
                    status: "unavailable",
                    reason: "oversize",
                    exit_reason: "provider_message_too_large",
                    error,
                };
            throw error;
        }
    }
    private async page<M>(
        record: RunnerRecord<M, FrozenProviderPlan>,
        page: StatusPage,
        signal?: AbortSignal,
    ): Promise<PageResult> {
        const id = this.id();
        const fence = await this.fence(record, id, this.budget(record.plan.compaction_budget_ms));
        const encoded = encodeStatusPage(record, page);
        const result = await this.send(
            "compaction.step",
            encoded,
            id,
            fence.deadline_ms,
            record,
            signal,
        );
        if (
            result.status === "answered" &&
            result.answer.answer === "compaction_message" &&
            page.control.more === true
        ) {
            // The first page's fence already covers the record's whole newest ordinal,
            // not just this page. Fence/range checks cannot make an intermediate view
            // safe: only the page completing the history may offer an applicable view.
            sessionLog(
                this.options.sessionId,
                "compaction.step refused a view on a continuation page",
                {
                    request_id: id,
                    lineage_id: fence.lineage_id,
                    newest: fence.newest,
                },
            );
            return { status: "unavailable", request_id: id, reason: "unexpected_compaction", page };
        }
        if (
            result.status === "answered" &&
            result.answer.answer === "wait" &&
            page.control.more !== true
        )
            return { status: "unavailable", request_id: id, reason: "unexpected_wait", page };
        return { ...result, page };
    }
    /** Ordinary status calls never re-issue a wait. H4 owns durable answer/application. */
    async step<M>(
        record: RunnerRecord<M, FrozenProviderPlan>,
        inputs: StepInputs,
        signal?: AbortSignal,
    ): Promise<ProviderResult<ProviderAnswers["compaction.step"]> & { page?: StatusPage }> {
        return this.exclusive(async () => {
            const pages = this.planPages(record, inputs);
            if (!Array.isArray(pages)) return pages;
            return this.page(record, pages[0], signal);
        });
    }
    /**
     * Only a continuation wait authorizes the next bootstrap page. onPage must
     * persist the answer and cursor before resolving; a failed write propagates.
     * A protocol violation fails this attempt without completing bootstrap or
     * acknowledging its missing pages; a later pass resumes the durable cursor.
     * No ready notification, bound timer, polling or same-page resend is involved.
     */
    bootstrap<M>(
        record: RunnerRecord<M, FrozenProviderPlan>,
        inputs: StepInputs,
        onPage: (result: PageResult) => Promise<void>,
        signal?: AbortSignal,
    ): Promise<ProviderResult<ProviderAnswers["compaction.step"]> & { page?: StatusPage }> {
        return this.exclusive(async () => {
            const pages = this.planPages(record, inputs);
            if (!Array.isArray(pages)) return pages;
            for (const page of pages) {
                const result = await this.page(record, page, signal);
                await onPage(result);
                if (result.status === "unavailable" || result.answer.answer !== "wait")
                    return result;
            }
            throw new Error("Bootstrap wait without a continuation page");
        });
    }
}
