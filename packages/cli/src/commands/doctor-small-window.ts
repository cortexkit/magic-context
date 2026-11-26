import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPluginConfig } from "@magic-context/core/config";
import { resolveDecisionCalibration } from "@magic-context/core/hooks/magic-context/decision-calibration";
import { resolveExecuteThresholdDetail } from "@magic-context/core/hooks/magic-context/event-resolvers";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import {
    formatSmallWindowCondition,
    reductionPointTokens,
    smallWindowCondition,
} from "@magic-context/core/shared/small-window";
import type { Database } from "@magic-context/core/shared/sqlite";
import { deriveWindowGeometry } from "@magic-context/core/shared/window-geometry";
import { openExistingContextDatabase } from "../lib/database-access";

/** Last known limits of one model, as a running host saved them. */
export interface SavedModelLimit {
    context?: number;
    input?: number;
    output?: number;
}

/** One measured tool set: a model and agent, and the tokens of its tool definitions. */
export interface MeasuredToolSet {
    providerId: string;
    modelId: string;
    agent: string;
    toolDefinitionTokens: number;
}

/** The execute-threshold settings doctor resolves each model's threshold from. */
export interface ThresholdSettings {
    percentage?: number | { default?: number; [model: string]: number | undefined };
    tokens?: { default?: number; [model: string]: number | undefined };
}

/** The default execute threshold when the configuration sets none. */
const DEFAULT_EXECUTE_THRESHOLD = 65;

/**
 * Which configured models are too small for what every request carries: the
 * system prompt and tool definitions alone take more than half of the
 * reduction point (the usable window times the execute threshold). Only models
 * with every number known are reported: the window from the limits a host
 * saved, the system prompt from the newest session measured on that model,
 * and the tool definitions as a host last measured them for one agent. The
 * threshold is resolved the way the plugin resolves it, from the
 * configuration doctor loaded (per-model and token thresholds included), and
 * the line says where it came from. Counts are local tokens scaled by the
 * model's tokenizer ratios, as the plugin shows them.
 */
export function findSmallWindows(input: {
    toolSets: readonly MeasuredToolSet[];
    systemPromptTokens: ReadonlyMap<string, number>;
    limits: ReadonlyMap<string, SavedModelLimit>;
    thresholds?: ThresholdSettings;
}): string[] {
    const lines: string[] = [];
    for (const set of input.toolSets) {
        const key = `${set.providerId}/${set.modelId}`;
        const limit = input.limits.get(key);
        const system = input.systemPromptTokens.get(key);
        if (!limit || system === undefined) continue;
        const usable = deriveWindowGeometry(set.providerId, set.modelId, limit, {
            log: () => {},
        })?.usableSoft;
        if (usable === undefined) continue;
        const threshold = resolveExecuteThresholdDetail(
            (input.thresholds?.percentage ?? DEFAULT_EXECUTE_THRESHOLD) as Parameters<
                typeof resolveExecuteThresholdDetail
            >[0],
            key,
            DEFAULT_EXECUTE_THRESHOLD,
            {
                tokensConfig: input.thresholds?.tokens as NonNullable<
                    Parameters<typeof resolveExecuteThresholdDetail>[3]
                >["tokensConfig"],
                contextLimit: usable,
            },
        );
        const source =
            threshold.mode === "tokens"
                ? "execute_threshold_tokens"
                : input.thresholds?.percentage === undefined
                  ? "the default"
                  : "execute_threshold_percentage";
        const calibration = resolveDecisionCalibration(set.providerId, set.modelId);
        const condition = smallWindowCondition({
            systemPromptTokens: system * calibration.systemRatio,
            toolDefinitionTokens: set.toolDefinitionTokens * calibration.toolsRatio,
            reductionPointTokens: reductionPointTokens(usable, threshold.percentage),
        });
        if (condition)
            lines.push(
                `${formatSmallWindowCondition(condition, `${key} (agent ${set.agent})`)} (Usable window ${usable.toLocaleString("en-US")} tokens, execute threshold ${Math.round(threshold.percentage * 10) / 10}% from ${source}.)`,
            );
    }
    return lines;
}

function readToolSets(db: Database): MeasuredToolSet[] {
    try {
        const rows = db
            .prepare(
                "SELECT provider_id AS providerId, model_id AS modelId, agent_name AS agent, SUM(token_count) AS tokens FROM tool_definition_measurements GROUP BY provider_id, model_id, agent_name ORDER BY provider_id, model_id, agent_name",
            )
            .all() as Array<{ providerId: string; modelId: string; agent: string; tokens: number }>;
        return rows.map((row) => ({
            providerId: row.providerId,
            modelId: row.modelId,
            agent: row.agent,
            toolDefinitionTokens: Number(row.tokens) || 0,
        }));
    } catch {
        // No measurements recorded yet.
        return [];
    }
}

function readSystemPromptTokens(db: Database): Map<string, number> {
    const latest = new Map<string, number>();
    try {
        const rows = db
            .prepare(
                "SELECT last_observed_model_key AS modelKey, system_prompt_tokens AS tokens FROM session_meta WHERE system_prompt_tokens > 0 AND last_observed_model_key IS NOT NULL AND last_observed_model_key != '' ORDER BY last_response_time ASC",
            )
            .all() as Array<{ modelKey: string; tokens: number }>;
        // Ascending order: the newest session for each model is set last.
        for (const row of rows) latest.set(row.modelKey, Number(row.tokens));
    } catch {
        // An older store without these columns has nothing to report.
    }
    return latest;
}

/** The limits every host saved (`model-context-limits-<host>.json`), merged. */
function readSavedLimits(storageDir: string): Map<string, SavedModelLimit> {
    const limits = new Map<string, SavedModelLimit>();
    let files: string[] = [];
    try {
        files = readdirSync(storageDir).filter(
            (name) => name.startsWith("model-context-limits-") && name.endsWith(".json"),
        );
    } catch {
        return limits;
    }
    for (const file of files) {
        try {
            const saved = JSON.parse(readFileSync(join(storageDir, file), "utf8")) as Record<
                string,
                | number
                | {
                      limit?: number;
                      contextLimit?: number;
                      inputLimit?: number;
                      outputLimit?: number;
                  }
            >;
            for (const [key, value] of Object.entries(saved)) {
                if (limits.has(key)) continue;
                limits.set(
                    key,
                    typeof value === "number"
                        ? { context: value }
                        : {
                              context: value.contextLimit ?? value.limit,
                              input: value.inputLimit,
                              output: value.outputLimit,
                          },
                );
            }
        } catch {
            // An unreadable file contributes nothing.
        }
    }
    return limits;
}

/** The execute-threshold settings of the configuration in force here. */
function configuredThresholds(): ThresholdSettings {
    const config = loadPluginConfig(process.cwd()) as {
        execute_threshold_percentage?: ThresholdSettings["percentage"];
        execute_threshold_tokens?: ThresholdSettings["tokens"];
    };
    return {
        percentage: config.execute_threshold_percentage,
        tokens: config.execute_threshold_tokens,
    };
}

/**
 * Doctor's report of models whose usable window is too small, read from the
 * shared store and the limits hosts saved. Needs no running host. Read-only.
 */
export function diagnoseSmallWindows(
    storageDir = getMagicContextStorageDir(),
    thresholds: ThresholdSettings = configuredThresholds(),
): string[] {
    const path = join(storageDir, "context.db");
    if (!existsSync(path)) return [];
    const db = openExistingContextDatabase(path, { readonly: true });
    if (!db) return [];
    try {
        return findSmallWindows({
            toolSets: readToolSets(db),
            systemPromptTokens: readSystemPromptTokens(db),
            limits: readSavedLimits(storageDir),
            thresholds,
        });
    } finally {
        db.close();
    }
}
