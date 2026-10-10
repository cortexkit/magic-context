import { createMemo, createSignal, For, Show } from "solid-js";
import FloatingLayer from "./FloatingLayer";
import { commitTypedModelValue, getTypedModelSelection } from "./model-selection";

export { commitTypedModelValue, getTypedModelSelection } from "./model-selection";

interface ModelSelectProps {
  models: string[];
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
}

export default function ModelSelect(props: ModelSelectProps) {
  const [open, setOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  let triggerRef!: HTMLButtonElement;
  let inputRef: HTMLInputElement | undefined;

  // Group models by provider
  const grouped = createMemo(() => {
    const q = search().toLowerCase();
    const filtered = q ? props.models.filter((m) => m.toLowerCase().includes(q)) : props.models;

    const groups: Record<string, string[]> = {};
    for (const m of filtered) {
      const slash = m.indexOf("/");
      const provider = slash >= 0 ? m.substring(0, slash) : "other";
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(m);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  });

  const typedSelection = createMemo(() => getTypedModelSelection(search(), props.models));
  const typedModel = () => typedSelection().model;
  const showTypedModelOption = () => {
    const selection = typedSelection();
    return selection.model !== null && !selection.isListed;
  };

  const openDropdown = () => {
    setOpen(true);
    setSearch("");
    requestAnimationFrame(() => inputRef?.focus());
  };

  const selectModel = (model: string) => {
    props.onChange(model);
    setOpen(false);
    triggerRef.focus();
  };

  const clearSelection = (e: MouseEvent) => {
    e.stopPropagation();
    props.onChange("");
    setOpen(false);
  };

  const commitTypedModel = () => commitTypedModelValue(search(), props.models, selectModel);

  // Normalize values at the component boundary because asynchronous form-state
  // refreshes can briefly provide a non-string value before the next render.
  const valueStr = createMemo(() => (typeof props.value === "string" ? props.value : ""));

  const displayValue = () => {
    const v = valueStr();
    if (!v) return props.placeholder ?? "— Use fallback chain —";
    return v;
  };

  const providerOf = (model: string) => {
    const slash = model.indexOf("/");
    return slash >= 0 ? model.substring(0, slash) : "";
  };

  const modelName = (model: string) => {
    const slash = model.indexOf("/");
    return slash >= 0 ? model.substring(slash + 1) : model;
  };

  return (
    <div class="model-select">
      {/* Trigger button */}
      <button
        ref={triggerRef}
        class="model-select-trigger"
        onClick={openDropdown}
        type="button"
        aria-label={props.label}
        aria-expanded={open()}
        aria-haspopup="dialog"
        title={displayValue()}
      >
        <span class={`model-select-value ${!valueStr() ? "placeholder" : ""}`}>
          {valueStr() ? (
            <>
              <Show when={providerOf(valueStr())}>
                {(provider) => <span class="model-select-provider">{provider()}/</span>}
              </Show>
              {modelName(valueStr())}
            </>
          ) : (
            displayValue()
          )}
        </span>
        <span class="model-select-actions">
          <span class="model-select-chevron">▾</span>
        </span>
      </button>
      <Show when={props.value}>
        <button
          type="button"
          class="model-select-clear"
          onClick={clearSelection}
          aria-label={`Clear ${props.label ?? "model selection"}`}
        >
          ✕
        </button>
      </Show>

      {/* Dropdown */}
      <Show when={open()}>
        <FloatingLayer anchor={triggerRef} onClose={() => setOpen(false)}>
          <div role="dialog" aria-label={props.label ?? "Select model"}>
            <div class="model-select-search-wrap">
              <input
                ref={inputRef}
                class="model-select-search"
                type="text"
                placeholder="Search or type provider/model..."
                value={search()}
                onInput={(e) => setSearch(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setOpen(false);
                    triggerRef.focus();
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    commitTypedModel();
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    e.currentTarget
                      .closest('[role="dialog"]')
                      ?.querySelector<HTMLButtonElement>("button")
                      ?.focus();
                  }
                }}
              />
            </div>
            <div class="model-select-options">
              <For each={grouped()}>
                {([provider, models]) => (
                  <div class="model-select-group">
                    <div class="model-select-group-label">{provider}</div>
                    <For each={models}>
                      {(model) => (
                        <button
                          class={`model-select-option ${props.value === model ? "active" : ""}`}
                          onClick={() => selectModel(model)}
                          type="button"
                          title={model}
                        >
                          {modelName(model)}
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
              <Show when={showTypedModelOption()}>
                <button
                  class="model-select-option"
                  onClick={() => {
                    const model = typedModel();
                    if (model) selectModel(model);
                  }}
                  type="button"
                >
                  Use "{typedModel()}"
                </button>
              </Show>
              <Show when={typedSelection().hint}>
                {(hint) => <div class="model-select-empty">{hint()}</div>}
              </Show>
              <Show when={grouped().length === 0 && !typedModel() && !typedSelection().hint}>
                <div class="model-select-empty">Search models or type a model id</div>
              </Show>
            </div>
          </div>
        </FloatingLayer>
      </Show>
    </div>
  );
}
