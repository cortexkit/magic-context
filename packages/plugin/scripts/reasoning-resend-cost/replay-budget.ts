import { readFileSync } from "node:fs";
import { reasoningBudgetCutoff, reasoningStepCost } from "../../src/hooks/magic-context/reasoning-budget";

export interface NumericReasoningStep {
    route: string;
    model: string;
    order: number;
    reported?: number;
    text_estimate?: number;
    encrypted: boolean;
}

/** Numeric snapshots only. Never discovers, opens, copies, or migrates a host store. */
export function replayReasoningBudget(input: unknown, budget = 10_000) {
    if (!Array.isArray(input)) throw new Error("Expected an array of numeric reasoning steps");
    const allowed = new Set(["route", "model", "order", "reported", "text_estimate", "encrypted"]);
    const groups = new Map<string, NumericReasoningStep[]>();
    for (const raw of input) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid numeric step");
        const step = raw as NumericReasoningStep;
        if (Object.keys(raw).some(key => !allowed.has(key)) || typeof step.route !== "string" || typeof step.model !== "string" || !Number.isInteger(step.order) || step.order < 0 || typeof step.encrypted !== "boolean" || [step.reported, step.text_estimate].some(n => n !== undefined && (!Number.isFinite(n) || n < 0))) throw new Error("Invalid numeric step: no text, payloads, signatures, identifiers, or unknown fields permitted");
        const key = `${step.route}/${step.model}`;
        const group = groups.get(key) ?? [];
        group.push(step);
        groups.set(key, group);
    }
    return [...groups].map(([route, steps]) => {
        steps.sort((a, b) => a.order - b.order);
        if (steps.some((step, i) => i > 0 && step.order === steps[i - 1].order)) throw new Error(`Duplicate order for ${route}`);
        const costs = steps.map(step => reasoningStepCost(step.reported, step.text_estimate ?? 0, step.encrypted));
        const checkpoints = costs.map((_, index) => {
            const current = costs.slice(0, index + 1);
            const cutoff = reasoningBudgetCutoff(current.map((cost, i) => ({ tag: i + 1, cost, exempt: i === index })), budget);
            const kept = current.slice(cutoff);
            const age = current.slice(-50);
            return { order: steps[index].order, budget_kept_tokens: kept.reduce((a, b) => a + b, 0), budget_kept_steps: kept.length, age50_kept_tokens: age.reduce((a, b) => a + b, 0), age50_kept_steps: age.length };
        });
        return { route, budget, checkpoints };
    });
}

if (import.meta.main) {
    const path = process.argv[2];
    if (!path || /\.(?:db|sqlite)(?:$|-)/i.test(path)) throw new Error("Pass a sanitized numeric JSON snapshot, not a database");
    console.log(JSON.stringify(replayReasoningBudget(JSON.parse(readFileSync(path, "utf8"))), null, 2));
}
