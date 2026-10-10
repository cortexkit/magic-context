import { createSignal, Index, Show } from "solid-js";

import { describeCron, isValidCronShape } from "../../lib/cron";
import { configDefault } from "./config-schema";
import { patchTaskConfig, scheduleSummary, toggledSchedule } from "./dreamer-schedule";
import type { TaskMeta } from "./dreamer-task-data";
import { TASKS } from "./dreamer-task-data";
import type { Harness, ModelEntry } from "./harness-model-data";
import { modelEntryWithModel, modelId } from "./harness-model-data";

export type { TaskMeta } from "./dreamer-task-data";
export { TASKS } from "./dreamer-task-data";

export interface DreamTaskConfig {
  schedule?: string;
  promotion_threshold?: number;
  [key: string]: unknown;
}

export interface DreamTaskModelConfig {
  model?: ModelEntry;
  variant?: string;
  thinking_level?: string;
  [key: string]: unknown;
}

type TasksValue = Record<string, DreamTaskConfig> | undefined;
type ModelTasksValue = Record<string, DreamTaskModelConfig> | undefined;

import ModelSelect from "./ModelSelect";
import VariantSelect from "./VariantSelect";

const PRESETS: { label: string; cron: string }[] = [
  { label: "Nightly (3am)", cron: "0 3 * * *" },
  { label: "Weekly (Sun 4am)", cron: "0 4 * * 0" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Disabled", cron: "" },
];
const CUSTOM = "__custom__";

function isPresetCron(cron: string): boolean {
  return PRESETS.some((p) => p.cron === cron);
}

function promotionThresholdDefault(taskName: string): number | undefined {
  return configDefault(`dreamer.tasks.${taskName}.promotion_threshold`) as number | undefined;
}

function promotionThresholdDescription(taskName: string): string {
  return taskName === "promote-primers"
    ? "Promotion threshold (2–20 recurring source days, default 2)"
    : "Promotion threshold (2–20 observations, default 3)";
}

interface DreamerTasksFieldProps {
  value: TasksValue;
  onChange: (tasks: Record<string, DreamTaskConfig>) => void;
  harness: Harness;
  modelTasks: ModelTasksValue;
  onModelTasksChange: (tasks: Record<string, DreamTaskModelConfig> | undefined) => void;
  models: string[];
  variants?: Record<string, string[]>;
}

export default function DreamerTasksField(props: DreamerTasksFieldProps) {
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const previousSchedules = new Map<string, string>();
  const [customMode, setCustomMode] = createSignal<Set<string>>(
    new Set(
      TASKS.filter((meta) => {
        const schedule = props.value?.[meta.name]?.schedule ?? meta.defaultSchedule;
        return schedule.trim() !== "" && !isPresetCron(schedule);
      }).map((meta) => meta.name),
    ),
  );
  const inCustomMode = (name: string) => customMode().has(name);
  const setTaskCustom = (name: string, on: boolean) =>
    setCustomMode((previous) => {
      const next = new Set(previous);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const taskCfg = (meta: TaskMeta): DreamTaskConfig => {
    const stored = props.value?.[meta.name];
    return {
      schedule: stored?.schedule ?? meta.defaultSchedule,
      promotion_threshold: stored?.promotion_threshold,
    };
  };
  const modelCfg = (name: string): DreamTaskModelConfig => props.modelTasks?.[name] ?? {};

  // Scheduling stays in dreamer.tasks, while model resolution lives under the
  // selected harness. Start from stored objects so advanced fields survive edits.
  const updateSchedule = (name: string, patch: Partial<DreamTaskConfig>): void => {
    const current = props.value?.[name]?.schedule;
    if (patch.schedule === "" && current?.trim()) previousSchedules.set(name, current);
    const next = patchTaskConfig(props.value, name, patch);
    if (patch.schedule?.trim()) previousSchedules.set(name, patch.schedule);
    props.onChange(next);
  };

  const updateModel = (name: string, patch: Partial<DreamTaskModelConfig>) => {
    const next: Record<string, DreamTaskModelConfig> = { ...(props.modelTasks ?? {}) };
    const entry = { ...(next[name] ?? {}), ...patch };
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key];
    }
    if (Object.keys(entry).length === 0) delete next[name];
    else next[name] = entry;
    props.onModelTasksChange(Object.keys(next).length > 0 ? next : undefined);
  };

  const qualifierLabel = () => (props.harness === "opencode" ? "Variant" : "Thinking level");
  const qualifierKey = () => (props.harness === "opencode" ? "variant" : "thinking_level");

  return (
    <div class="config-table-wrap" data-harness={props.harness}>
      <table class="config-task-table">
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Schedule</th>
            <th scope="col">Model override</th>
            <th scope="col">On/off</th>
          </tr>
        </thead>
        <tbody>
          <Index each={TASKS}>
            {(meta) => {
              const cfg = () => taskCfg(meta());
              const taskModel = () => modelCfg(meta().name);
              const schedule = () => cfg().schedule ?? "";
              const enabled = () => schedule().trim() !== "";
              const selectValue = () =>
                inCustomMode(meta().name) || (schedule().trim() !== "" && !isPresetCron(schedule()))
                  ? CUSTOM
                  : schedule();
              return (
                <>
                  <tr
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("[data-task-control]")) return;
                      setExpanded(expanded() === meta().name ? null : meta().name);
                    }}
                  >
                    <td>
                      <button
                        type="button"
                        class="config-schedule-btn"
                        aria-expanded={expanded() === meta().name}
                        aria-controls={`task-detail-${meta().name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpanded(expanded() === meta().name ? null : meta().name);
                        }}
                      >
                        {meta().label}
                      </button>
                      <code class="config-field-key">{meta().name}</code>
                      <span class="config-field-desc">{meta().description}</span>
                    </td>
                    <td>{scheduleSummary(schedule())}</td>
                    <td data-task-control>
                      <ModelSelect
                        models={props.models}
                        value={modelId(taskModel().model)}
                        onChange={(next) =>
                          updateModel(meta().name, {
                            model: modelEntryWithModel(
                              taskModel().model,
                              props.harness,
                              next || undefined,
                            ),
                          })
                        }
                        placeholder="Use harness model"
                      />
                    </td>
                    <td data-task-control>
                      <label class="toggle-switch">
                        <input
                          type="checkbox"
                          aria-label={`Enable ${meta().label}`}
                          checked={enabled()}
                          onChange={(event) => {
                            if (enabled()) previousSchedules.set(meta().name, schedule());
                            updateSchedule(meta().name, {
                              schedule: toggledSchedule(
                                event.currentTarget.checked,
                                previousSchedules.get(meta().name),
                                meta().defaultSchedule,
                              ),
                            });
                          }}
                        />
                        <span class="toggle-slider" />
                      </label>
                    </td>
                  </tr>
                  <Show when={expanded() === meta().name}>
                    <tr class="config-task-detail" id={`task-detail-${meta().name}`}>
                      <td colSpan={4}>
                        <div class="config-task-edit-grid">
                          <div>
                            <span class="config-field-label">Schedule</span>
                            <code class="config-field-key">
                              dreamer.tasks.{meta().name}.schedule
                            </code>
                            <div class="select-wrap">
                              <select
                                class="config-input config-select"
                                value={selectValue()}
                                onChange={(event) => {
                                  const next = event.currentTarget.value;
                                  if (next === CUSTOM) {
                                    setTaskCustom(meta().name, true);
                                    if (schedule().trim() === "") {
                                      updateSchedule(meta().name, {
                                        schedule: toggledSchedule(
                                          true,
                                          previousSchedules.get(meta().name),
                                          meta().defaultSchedule,
                                        ),
                                      });
                                    }
                                  } else {
                                    setTaskCustom(meta().name, false);
                                    updateSchedule(meta().name, { schedule: next });
                                  }
                                }}
                              >
                                <Index each={PRESETS}>
                                  {(preset) => (
                                    <option value={preset().cron}>{preset().label}</option>
                                  )}
                                </Index>
                                <option value={CUSTOM}>Custom cron…</option>
                              </select>
                            </div>
                            <input
                              class="config-input"
                              aria-label={`${meta().label} cron`}
                              type="text"
                              classList={{ "config-input-invalid": !isValidCronShape(schedule()) }}
                              value={schedule()}
                              placeholder="Empty: disabled"
                              onInput={(event) =>
                                updateSchedule(meta().name, { schedule: event.currentTarget.value })
                              }
                            />
                            <span class="config-field-desc">
                              minute · hour · day of month · month · weekday
                            </span>
                            <span
                              class="dreamer-cron-human"
                              classList={{ invalid: !isValidCronShape(schedule()) }}
                            >
                              {isValidCronShape(schedule())
                                ? describeCron(schedule())
                                : "Invalid cron — need 5 fields in range"}
                            </span>
                          </div>
                          <div class="dreamer-task-param">
                            <span class="config-field-label">
                              Task {qualifierLabel().toLowerCase()}
                            </span>
                            <code class="config-field-key">
                              dreamer.{props.harness}.tasks.{meta().name}.{qualifierKey()}
                            </code>
                            <VariantSelect
                              harness={props.harness}
                              model={modelId(taskModel().model)}
                              variants={props.variants}
                              label={`Task ${qualifierLabel().toLowerCase()}`}
                              value={taskModel()[qualifierKey()] as string | undefined}
                              onChange={(value) =>
                                updateModel(meta().name, { [qualifierKey()]: value })
                              }
                            />
                          </div>
                          <Show when={promotionThresholdDefault(meta().name) !== undefined}>
                            <div class="dreamer-task-param">
                              <span class="config-field-desc">
                                {promotionThresholdDescription(meta().name)}
                              </span>
                              <code class="config-field-key">
                                dreamer.tasks.{meta().name}.promotion_threshold
                              </code>
                              <input
                                class="config-input"
                                type="number"
                                min={2}
                                max={20}
                                value={cfg().promotion_threshold ?? ""}
                                placeholder={`Default: ${promotionThresholdDefault(meta().name)}`}
                                onInput={(event) =>
                                  updateSchedule(meta().name, {
                                    promotion_threshold: event.currentTarget.value
                                      ? Number(event.currentTarget.value)
                                      : undefined,
                                  })
                                }
                              />
                            </div>
                          </Show>
                        </div>
                      </td>
                    </tr>
                  </Show>
                </>
              );
            }}
          </Index>
        </tbody>
      </table>
    </div>
  );
}
