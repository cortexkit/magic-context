import { createSignal, For, Show } from "solid-js";
import ModelSelect from "./ModelSelect";

interface PerModelFieldProps {
  label: string;
  configKey: string;
  description: string;
  value: unknown;
  onChange: (value: unknown) => void;
  models: string[];
  /** Input type for values */
  inputType: "text" | "slider";
  /** Slider config (when inputType=slider) */
  sliderConfig?: { min: number; max: number; step: number; suffix: string; defaultValue: number };
  /** Default value placeholder */
  defaultPlaceholder: string;
  /** When true, emit { default, ...overrides } object even when only default is set.
   *  Required for fields whose schema forbids a bare-scalar form (e.g. execute_threshold_tokens). */
  alwaysObject?: boolean;
  /** When set, text input values are coerced to numbers on save (blank → undefined). */
  numericText?: boolean;
}

/**
 * Renders a config field that supports both scalar and { default, "model-key": value } shapes.
 * Shows a default value input + per-model overrides with add/remove.
 */
export default function PerModelField(props: PerModelFieldProps) {
  const [addingModel, setAddingModel] = createSignal(false);

  // Normalize value to { default, ...overrides } shape
  const normalized = (): {
    defaultVal: string | number | undefined;
    overrides: Record<string, string | number>;
  } => {
    const v = props.value;
    if (v == null) return { defaultVal: undefined, overrides: {} };
    if (typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const { default: def, ...rest } = obj;
      const overrides: Record<string, string | number> = {};
      for (const [k, val] of Object.entries(rest)) {
        if (typeof val === "string" || typeof val === "number") overrides[k] = val;
      }
      return { defaultVal: def as string | number | undefined, overrides };
    }
    // Scalar
    return { defaultVal: v as string | number, overrides: {} };
  };

  const hasOverrides = () => Object.keys(normalized().overrides).length > 0;

  // Coerce text inputs to numbers when numericText is set. Blank → undefined.
  const coerce = (val: string | number | undefined): string | number | undefined => {
    if (val === undefined || val === "") return undefined;
    if (props.numericText && typeof val === "string") {
      const n = Number(val);
      return Number.isFinite(n) ? n : val;
    }
    return val;
  };

  // Build the full config value from default + overrides.
  // When alwaysObject is true (schema forbids bare scalar), always emit object shape,
  // omitting undefined default so { "model": N } stays valid.
  const buildValue = (
    defaultVal: string | number | undefined,
    overrides: Record<string, string | number>,
  ) => {
    const hasDefault = defaultVal !== undefined && defaultVal !== "";
    if (props.alwaysObject) {
      if (!hasDefault && Object.keys(overrides).length === 0) return undefined;
      return hasDefault ? { default: defaultVal, ...overrides } : { ...overrides };
    }
    if (Object.keys(overrides).length === 0) return defaultVal;
    return { default: defaultVal, ...overrides };
  };

  const setDefault = (val: string | number | undefined) => {
    const { overrides } = normalized();
    props.onChange(buildValue(coerce(val), overrides));
  };

  const setOverride = (model: string, val: string | number) => {
    const { defaultVal, overrides } = normalized();
    const coerced = coerce(val);
    if (coerced === undefined) return;
    props.onChange(buildValue(defaultVal, { ...overrides, [model]: coerced }));
  };

  const removeOverride = (model: string) => {
    const { defaultVal, overrides } = normalized();
    const { [model]: _, ...rest } = overrides;
    props.onChange(buildValue(defaultVal, rest));
  };

  const addOverride = (model: string) => {
    const { defaultVal, overrides } = normalized();
    let defVal: string | number;
    if (props.inputType === "slider") {
      defVal = props.sliderConfig?.defaultValue ?? 65;
    } else if (props.numericText) {
      // For numeric text inputs (e.g. execute_threshold_tokens) seed a safe numeric value.
      // Prefer the current default if numeric; else use the placeholder if parseable; else 0.
      const asNum = typeof defaultVal === "number" ? defaultVal : Number(defaultVal);
      if (Number.isFinite(asNum) && asNum > 0) {
        defVal = asNum;
      } else {
        const phNum = Number(props.defaultPlaceholder);
        defVal = Number.isFinite(phNum) && phNum > 0 ? phNum : 0;
      }
    } else {
      defVal = defaultVal ?? props.defaultPlaceholder;
    }
    props.onChange(buildValue(defaultVal, { ...overrides, [model]: defVal }));
    setAddingModel(false);
  };

  // Models not yet in overrides
  const availableModels = () => {
    const used = new Set(Object.keys(normalized().overrides));
    return props.models.filter((m) => !used.has(m));
  };

  return (
    <div class="config-field">
      <div class="config-field-header">
        <span class="config-field-label">{props.label}</span>
        <span class="config-field-key">{props.configKey}</span>
      </div>
      <span class="config-field-desc">{props.description}</span>

      {/* Default value */}
      <div class="per-model-row">
        <span class="per-model-label">Default</span>
        {props.inputType === "slider" && props.sliderConfig ? (
          <div class="range-slider-container" style={{ flex: "1" }}>
            <input
              class="range-slider"
              type="range"
              min={props.sliderConfig.min}
              max={props.sliderConfig.max}
              step={props.sliderConfig.step}
              value={
                normalized().defaultVal != null
                  ? Number(normalized().defaultVal)
                  : props.sliderConfig.defaultValue
              }
              onInput={(e) => setDefault(Number(e.currentTarget.value))}
            />
            <span class="range-slider-value">
              {normalized().defaultVal != null
                ? Number(normalized().defaultVal)
                : props.sliderConfig.defaultValue}
              {props.sliderConfig.suffix}
            </span>
          </div>
        ) : (
          <input
            class="config-input"
            type="text"
            style={{ flex: "1" }}
            value={String(normalized().defaultVal ?? "")}
            placeholder={props.defaultPlaceholder}
            onInput={(e) => setDefault(e.currentTarget.value || undefined)}
          />
        )}
      </div>

      {/* Per-model overrides */}
      <Show when={hasOverrides()}>
        <div class="per-model-overrides">
          <For each={Object.entries(normalized().overrides)}>
            {([model, val]) => (
              <div class="per-model-row">
                <span class="per-model-model mono">{model}</span>
                {props.inputType === "slider" && props.sliderConfig ? (
                  <div class="range-slider-container" style={{ flex: "1" }}>
                    <input
                      class="range-slider"
                      type="range"
                      min={props.sliderConfig.min}
                      max={props.sliderConfig.max}
                      step={props.sliderConfig.step}
                      value={Number(val)}
                      onInput={(e) => setOverride(model, Number(e.currentTarget.value))}
                    />
                    <span class="range-slider-value">
                      {Number(val)}
                      {props.sliderConfig.suffix}
                    </span>
                  </div>
                ) : (
                  <input
                    class="config-input"
                    type="text"
                    style={{ flex: "1" }}
                    value={String(val)}
                    onInput={(e) => setOverride(model, e.currentTarget.value)}
                  />
                )}
                <button
                  type="button"
                  class="btn sm danger"
                  onClick={() => removeOverride(model)}
                  title="Remove override"
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Add override */}
      <Show when={addingModel()}>
        <div style={{ "margin-top": "6px" }}>
          <ModelSelect
            models={availableModels()}
            value={undefined}
            onChange={(v) => {
              if (v) addOverride(v);
            }}
            placeholder="— Select model for override —"
          />
        </div>
      </Show>
      <button
        type="button"
        class="btn sm"
        style={{ "margin-top": "6px", "align-self": "flex-start" }}
        onClick={() => setAddingModel(!addingModel())}
      >
        {addingModel() ? "Cancel" : "+ Per-model override"}
      </button>
    </div>
  );
}
