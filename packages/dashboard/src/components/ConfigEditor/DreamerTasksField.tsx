import { createSignal, Index, Show } from "solid-js";
import { describeCron, isValidCronShape } from "../../lib/cron";
import ModelSelect from "./ModelSelect";

/**
 * Dreamer v2 per-task editor.
 *
 * Replaces the retired v1 single `schedule` window + `user_memories` /
 * `pin_key_files` blocks. Each canonical task gets its own cron schedule
 * (preset picker + custom escape), an optional per-task model override, and the
 * task-specific params (promotion_threshold for review-user-memories).
 *
 * Self-contained (the dashboard does not import @magic-context/core); the task
 * list, default schedules, and presets mirror the plugin's Zod schema. Plugin-
 * side validation is authoritative on load — the inline cron check here is only
 * for immediate UX feedback.
 */

export interface DreamTaskConfig {
  schedule?: string;
  model?: string;
  promotion_threshold?: number;
  [key: string]: unknown;
}

type TasksValue = Record<string, DreamTaskConfig> | undefined;

export interface TaskMeta {
  name: string;
  label: string;
  description: string;
  defaultSchedule: string;
}

// Mirrors CANONICAL_DREAM_TASKS + DEFAULT_TASK_SCHEDULES in the plugin schema.
export const TASKS: TaskMeta[] = [
  {
    name: "map-memories",
    label: "Map memories",
    description: "Maps each memory to its backing files so verify knows what to re-check",
    defaultSchedule: "0 2 * * *",
  },
  {
    name: "verify",
    label: "Verify changed memories",
    description: "Checks changed-file memories against code and fixes/removes stale ones",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "verify-broad",
    label: "Verify all memories",
    description: "Periodic full re-check of the whole memory pool (catches drift)",
    defaultSchedule: "0 4 * * 0",
  },
  {
    name: "curate",
    label: "Curate memories",
    description: "Deduplicates, tightens, and prunes the memory pool",
    defaultSchedule: "0 4 * * 0",
  },
  {
    name: "compress-cues",
    label: "Compress mural cues",
    description:
      "Compresses each overflow memory into a mural cue (the mural image renders deterministically)",
    defaultSchedule: "0 4 * * *",
  },
  {
    name: "classify-memories",
    label: "Classify memories",
    description: "Scores memory importance, scope, and shareability",
    defaultSchedule: "0 6 * * *",
  },
  {
    name: "retrospective",
    label: "Retrospective",
    description: "Learns from moments you had to correct or re-explain, and records the lesson",
    defaultSchedule: "0 5 * * *",
  },
  {
    name: "maintain-docs",
    label: "Maintain docs",
    description: "Keep ARCHITECTURE.md / STRUCTURE.md in sync",
    defaultSchedule: "",
  },
  {
    name: "evaluate-smart-notes",
    label: "Evaluate smart notes",
    description: "Surface smart notes whose conditions are now met",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "review-user-memories",
    label: "Review user memories",
    description: "Promote recurring behaviors into your user profile",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "promote-primers",
    label: "Promote primers",
    description: "Promote recurring project questions into Primers",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "refresh-primers",
    label: "Refresh primers",
    description: "Refresh answers for active project Primers",
    defaultSchedule: "0 3 * * *",
  },
  {
    name: "distill-skill-memory",
    label: "Distill skill memory",
    description: "Opt-in: distills per-skill memory (merge/prune/promote)",
    defaultSchedule: "",
  },
];

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
  if (taskName === "review-user-memories") return 3;
  if (taskName === "promote-primers") return 2;
  return undefined;
}

function promotionThresholdDescription(taskName: string): string {
  return taskName === "promote-primers"
    ? "Promotion threshold (2–20 recurring source days, default 2)"
    : "Promotion threshold (2–20 observations, default 3)";
}

interface DreamerTasksFieldProps {
  value: TasksValue;
  onChange: (tasks: Record<string, DreamTaskConfig>) => void;
  models: string[];
}

export default function DreamerTasksField(props: DreamerTasksFieldProps) {
  // Explicit "custom cron" mode per task. Derived-from-value snapped the dropdown
  // back to a preset the instant Custom seeded a preset-shaped cron, so the input
  // never appeared. This signal makes Custom a sticky, user-chosen mode.
  const [customMode, setCustomMode] = createSignal<Set<string>>(
    new Set(
      TASKS.filter((meta) => {
        const s = props.value?.[meta.name]?.schedule ?? meta.defaultSchedule;
        return s.trim() !== "" && !isPresetCron(s);
      }).map((meta) => meta.name),
    ),
  );
  const inCustomMode = (name: string) => customMode().has(name);
  const setTaskCustom = (name: string, on: boolean) =>
    setCustomMode((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  // Resolve a task's effective config for DISPLAY (stored override, else schema
  // defaults). Only reads the fields the UI renders — never used as the basis for
  // what gets persisted (see `update`, which preserves the full stored object).
  const taskCfg = (meta: TaskMeta): DreamTaskConfig => {
    const stored = props.value?.[meta.name];
    return {
      schedule: stored?.schedule ?? meta.defaultSchedule,
      model: stored?.model,
      promotion_threshold: stored?.promotion_threshold,
    };
  };

  // Merge a partial change into a task, emitting the FULL tasks record so the
  // plugin always sees every task explicitly (avoids "some default, some set"
  // ambiguity once the user touches the dashboard). CRITICAL: each task entry is
  // built from its STORED object (spread first), so advanced per-task keys the UI
  // doesn't render — timeout_minutes, fallback_models, thinking_level, and any
  // future field — survive an edit instead of being whitelisted away.
  const update = (name: string, patch: Partial<DreamTaskConfig>): void => {
    const next: Record<string, DreamTaskConfig> = {};
    const canonicalNames = new Set(TASKS.map((task) => task.name));
    for (const [taskName, taskConfig] of Object.entries(props.value ?? {})) {
      if (!canonicalNames.has(taskName)) next[taskName] = { ...taskConfig };
    }
    for (const meta of TASKS) {
      const stored = props.value?.[meta.name];
      // Start from the full stored object (preserve unknown keys), default the
      // schedule for a never-stored task, then apply the patch to the edited row.
      const entry: DreamTaskConfig = {
        ...(stored ?? {}),
        schedule: stored?.schedule ?? meta.defaultSchedule,
      };
      if (meta.name === name) Object.assign(entry, patch);
      // Normalize: schedule must always be a string; drop any key set to undefined
      // by the patch (e.g. clearing the model) without touching untouched keys.
      entry.schedule = entry.schedule ?? "";
      for (const key of Object.keys(entry)) {
        if (entry[key] === undefined) delete entry[key];
      }
      next[meta.name] = entry;
    }
    props.onChange(next);
  };

  return (
    <div class="dreamer-tasks">
      <Index each={TASKS}>
        {(meta) => {
          const cfg = () => taskCfg(meta());
          const schedule = () => cfg().schedule ?? "";
          const enabled = () => schedule().trim() !== "";
          // The dropdown shows CUSTOM when the user picked custom mode OR the
          // stored cron isn't a preset (and isn't empty). Custom mode is sticky.
          const selectValue = () =>
            inCustomMode(meta().name) || (schedule().trim() !== "" && !isPresetCron(schedule()))
              ? CUSTOM
              : schedule();
          return (
            <div class="dreamer-task-row">
              <div class="dreamer-task-head">
                <span class="config-field-label">{meta().label}</span>
                <span class="config-field-desc">
                  <code>{meta().name}</code> — {meta().description}
                </span>
              </div>
              <div class="dreamer-task-controls">
                <div class="select-wrap">
                  <select
                    class="config-input config-select"
                    value={selectValue()}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      if (v === CUSTOM) {
                        // Enter sticky custom mode; seed the input with the
                        // current cron (or a sane default) so it's never blank.
                        setTaskCustom(meta().name, true);
                        if (schedule().trim() === "") {
                          update(meta().name, { schedule: "0 3 * * *" });
                        }
                      } else {
                        setTaskCustom(meta().name, false);
                        update(meta().name, { schedule: v });
                      }
                    }}
                  >
                    <Index each={PRESETS}>
                      {(p) => <option value={p().cron}>{p().label}</option>}
                    </Index>
                    <option value={CUSTOM}>Custom cron…</option>
                  </select>
                </div>
                <ModelSelect
                  models={props.models}
                  value={cfg().model}
                  onChange={(v) => update(meta().name, { model: v || undefined })}
                  placeholder="— inherit dreamer model —"
                />
              </div>
              <Show when={selectValue() === CUSTOM}>
                <div class="dreamer-cron-custom">
                  <input
                    class="config-input"
                    classList={{ "config-input-invalid": !isValidCronShape(schedule()) }}
                    type="text"
                    value={schedule()}
                    placeholder="0 3 * * *  (min hour day month weekday)"
                    onInput={(e) => update(meta().name, { schedule: e.currentTarget.value })}
                  />
                  <span
                    class="dreamer-cron-human"
                    classList={{ invalid: !isValidCronShape(schedule()) }}
                  >
                    {isValidCronShape(schedule())
                      ? describeCron(schedule())
                      : "Invalid cron — need 5 fields: min hour day month weekday"}
                  </span>
                </div>
              </Show>
              {/* Task-specific params, shown only when scheduled. */}
              <Show when={enabled() && promotionThresholdDefault(meta().name) !== undefined}>
                <div class="dreamer-task-param">
                  <span class="config-field-desc">
                    {promotionThresholdDescription(meta().name)}
                  </span>
                  <input
                    class="config-input"
                    type="number"
                    min={2}
                    max={20}
                    value={cfg().promotion_threshold ?? promotionThresholdDefault(meta().name) ?? 3}
                    onInput={(e) =>
                      update(meta().name, {
                        promotion_threshold: Number(e.currentTarget.value),
                      })
                    }
                  />
                </div>
              </Show>
            </div>
          );
        }}
      </Index>
    </div>
  );
}
