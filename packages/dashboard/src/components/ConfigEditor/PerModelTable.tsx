import { createMemo, createSignal, For, Show } from "solid-js";
import { configDefault } from "./config-schema";
import HelpPopover from "./HelpPopover";
import ModelSelect from "./ModelSelect";
import {
  addModelRow,
  editModelCell,
  modelValues,
  overrideModels,
  PER_MODEL_KEYS,
  type PerModelKey,
  type PerModelValues,
  removeModelRow,
} from "./per-model-overrides";

const COLUMNS: Record<
  PerModelKey,
  { label: string; description: string; unset?: string; min?: number; max?: number }
> = {
  keep_reasoning_tokens: {
    label: "Keep reasoning tokens",
    description:
      "Keep whole reasoning steps newest first, only on passes that already rebuild the cache. Newest and exempt steps count but always stay. Blank uses fixed 10,000 tokens.",
    unset: "Default: 10000",
    min: 0,
    max: 1000000,
  },
  cache_ttl: {
    label: "Cache TTL",
    description: "Provider prompt-cache lifetime that Magic Context assumes.",
  },
  execute_threshold_percentage: {
    label: "Execute Threshold %",
    description:
      "Context usage percentage (20–90) at which queued drops execute. The safe-window cap is 90%.",
    min: 20,
    max: 90,
  },
  execute_threshold_tokens: {
    label: "Execute Threshold (tokens)",
    description:
      "Optional absolute-tokens threshold. When set for a model, overrides the percentage above. Clamped to 90% of the context limit at runtime.",
    unset: "Unset: use percentage",
    min: 5000,
    max: 2000000,
  },
  output_reserve: {
    label: "Output Reserve",
    description:
      "Reserve output tokens from the shared context window. Set 0 to disable the reservation. User-level only.",
    unset: "Derived from model window",
    min: 0,
  },
};

export default function PerModelTable(props: {
  values: PerModelValues;
  onChange: (patch: PerModelValues) => void;
  models: string[];
  userScope: boolean;
}) {
  const [draftRows, setDraftRows] = createSignal<string[]>([]);
  const [adding, setAdding] = createSignal(false);
  const keys = () => PER_MODEL_KEYS.filter((key) => props.userScope || key !== "output_reserve");
  const rows = createMemo(() =>
    addRows(
      overrideModels(Object.fromEntries(keys().map((key) => [key, props.values[key]]))),
      draftRows(),
    ),
  );
  const placeholder = (key: PerModelKey, inherit: boolean) => {
    const value = inherit
      ? (modelValues(props.values[key]).default ?? configDefault(key))
      : configDefault(key);
    return value === undefined ? COLUMNS[key].unset : `Default: ${String(value)}`;
  };
  const input = (key: PerModelKey, model: string) => (
    <input
      class="config-input"
      aria-label={`${model === "default" ? "Default" : model} ${COLUMNS[key].label}`}
      type={key === "cache_ttl" ? "text" : "number"}
      min={COLUMNS[key].min}
      max={COLUMNS[key].max}
      step={1}
      value={String(modelValues(props.values[key])[model] ?? "")}
      placeholder={placeholder(key, model !== "default")}
      onInput={(event) => {
        if (model !== "default") setDraftRows(rows());
        props.onChange({
          [key]: editModelCell(props.values[key], key, model, event.currentTarget.value),
        });
      }}
    />
  );
  return (
    <>
      <div class="config-defaults">
        <For each={keys()}>
          {(key) => (
            <div class="config-field">
              <div class="config-field-header">
                <span class="config-field-label">{COLUMNS[key].label}</span>
                <Show when={key === "cache_ttl"}>
                  <HelpPopover topic="cache_ttl" label="Cache TTL" />
                </Show>
                <code class="config-field-key">{key}.default</code>
              </div>
              <span class="config-field-desc">{COLUMNS[key].description}</span>
              {input(key, "default")}
              <Show
                when={
                  key === "output_reserve" &&
                  Object.keys(modelValues(props.values[key])).some((name) => name !== "default") &&
                  modelValues(props.values[key]).default === undefined
                }
              >
                <p class="config-table-note">
                  Output Reserve overrides require a numeric default in the config schema. Set a
                  default above before saving; a derived fallback cannot be stored in a model map.
                </p>
              </Show>
            </div>
          )}
        </For>
      </div>
      <details class="config-overrides">
        <summary>
          Per-model overrides <span class="config-field-desc">{rows().length} models</span>
        </summary>
        <div class="config-table-toolbar">
          <p>Blank cells use the defaults above.</p>
          <button type="button" class="btn sm" onClick={() => setAdding(!adding())}>
            {adding() ? "Cancel" : "+ Add model"}
          </button>
        </div>
        <Show when={adding()}>
          <ModelSelect
            models={props.models.filter((model) => !rows().includes(model))}
            value={undefined}
            placeholder="Select or type a model ID"
            onChange={(model) => {
              if (model) setDraftRows(addModelRow(rows(), model));
              setAdding(false);
            }}
          />
        </Show>
        <div class="config-table-wrap">
          <table class="config-model-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <For each={keys()}>
                  {(key) => (
                    <th scope="col">
                      {COLUMNS[key].label}
                      <code class="config-field-key">{key}</code>
                    </th>
                  )}
                </For>
                <th scope="col">Remove</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(model) => (
                  <tr>
                    <td class="mono">{model}</td>
                    <For each={keys()}>{(key) => <td>{input(key, model)}</td>}</For>
                    <td>
                      <button
                        type="button"
                        class="config-icon-btn"
                        aria-label={`Remove overrides for ${model}`}
                        onClick={() => {
                          const patch = removeModelRow(props.values, model);
                          if (!props.userScope) delete patch.output_reserve;
                          props.onChange(patch);
                          setDraftRows(rows().filter((row) => row !== model));
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={rows().length === 0}>
          <p class="config-table-note">
            No model overrides. Add a model to customize its settings.
          </p>
        </Show>
      </details>
    </>
  );
}

function addRows(stored: string[], drafts: string[]): string[] {
  return [...new Set([...stored, ...drafts])];
}
