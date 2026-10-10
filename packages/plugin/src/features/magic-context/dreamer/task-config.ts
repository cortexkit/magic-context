import type { DreamerConfig } from "../../../config/schema/magic-context";
import { type ModelHarness, resolveDreamerTaskModel } from "../../../shared/model-resolution";
import {
    CANONICAL_DREAM_TASKS,
    DREAM_TOOL_LOOP_TOKEN_BUDGETS,
    type DreamTaskName,
} from "./task-registry";
import type { DreamTaskRuntimeConfig } from "./task-scheduler";

/**
 * Resolve the full per-task runtime config the scheduler consumes from the
 * validated dreamer config: each task's schedule + its effective model chain
 * (task override → dreamer-level default), thinking level, timeout, and
 * task-specific params. One place owns the inheritance rule.
 */
export function buildDreamTaskRuntimeConfigs(
    dreamer: unknown,
    harness: ModelHarness,
    language?: string,
): DreamTaskRuntimeConfig[] {
    return CANONICAL_DREAM_TASKS.map((task) => {
        const resolved = resolveDreamerTaskModel({
            config: { dreamer },
            harness,
            task,
        });
        return {
            task,
            // Scheduling is intentionally outside the harness block. An omitted
            // schedule stays disabled until the schema supplies its default.
            schedule: resolved.schedule ?? "",
            model: resolved.primary,
            fallbackModels: resolved.fallbacks,
            thinkingLevel:
                harness === "pi"
                    ? (resolved.primary?.qualifier as DreamTaskRuntimeConfig["thinkingLevel"])
                    : undefined,
            language,
            timeoutMinutes: resolved.timeoutMinutes ?? 20,
            tokenBudget:
                task in DREAM_TOOL_LOOP_TOKEN_BUDGETS
                    ? ((dreamer as DreamerConfig | undefined)?.tasks?.[task]?.token_budget ??
                      DREAM_TOOL_LOOP_TOKEN_BUDGETS[
                          task as keyof typeof DREAM_TOOL_LOOP_TOKEN_BUDGETS
                      ])
                    : undefined,
            promotionThreshold: resolved.promotionThreshold,
            docsMaxTokens:
                task === "maintain-docs"
                    ? ((dreamer as DreamerConfig | undefined)?.tasks?.["maintain-docs"]
                          ?.max_tokens ?? 12000)
                    : undefined,
            retrospectiveRecencyDays:
                task === "retrospective"
                    ? ((dreamer as DreamerConfig | undefined)?.tasks?.retrospective?.recency_days ??
                      30)
                    : undefined,
        };
    });
}

/**
 * The collection privacy gate (Option C): user-behavior observation candidates
 * are stored during historian runs ONLY when the user has scheduled the
 * review-user-memories task (schedule != ""). Replaces the v1
 * `user_memories.enabled` flag, which both gated collection AND review.
 */
export function userMemoryCollectionEnabled(dreamer: DreamerConfig | undefined): boolean {
    const schedule = dreamer?.tasks?.["review-user-memories"]?.schedule;
    return typeof schedule === "string" && schedule.trim() !== "";
}

/** The promotion threshold for user-memory review (collection + review share it). */
export function userMemoryPromotionThreshold(dreamer: DreamerConfig | undefined): number {
    return dreamer?.tasks?.["review-user-memories"]?.promotion_threshold ?? 3;
}

/** True when a task is scheduled (schedule != ""). Generic enable check. */
export function dreamTaskScheduled(
    dreamer: DreamerConfig | undefined,
    task: keyof NonNullable<DreamerConfig["tasks"]>,
): boolean {
    const schedule = dreamer?.tasks?.[task]?.schedule;
    return typeof schedule === "string" && schedule.trim() !== "";
}

/** Names of the tasks the user has scheduled (schedule != ""), in canonical order. */
export function enabledDreamTasks(dreamer: DreamerConfig | undefined): DreamTaskName[] {
    if (!dreamer?.tasks) return [];
    return CANONICAL_DREAM_TASKS.filter((t) => dreamer.tasks[t]?.schedule?.trim());
}

/** A compact `/ctx-status`-style schedule summary, e.g.
 *  "verify 0 3 * * *, curate 0 4 * * 0" — or "manual-only" when nothing is
 *  scheduled. */
export function summarizeDreamSchedule(dreamer: DreamerConfig | undefined): string {
    const enabled = enabledDreamTasks(dreamer);
    if (enabled.length === 0) return "manual-only";
    return enabled.map((t) => `${t} ${dreamer?.tasks[t]?.schedule}`).join(", ");
}
