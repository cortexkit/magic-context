import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";

interface ModelSelectProps {
  models: string[];
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function ModelSelect(props: ModelSelectProps) {
  const [open, setOpen] = createSignal(false);
  const [search, setSearch] = createSignal("");
  let containerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  // Close on outside click
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false);
    }
  };

  // Register/cleanup listener
  const startListening = () => document.addEventListener("mousedown", handleClickOutside);
  const stopListening = () => document.removeEventListener("mousedown", handleClickOutside);
  onCleanup(stopListening);

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

  const openDropdown = () => {
    setOpen(true);
    setSearch("");
    startListening();
    requestAnimationFrame(() => inputRef?.focus());
  };

  const selectModel = (model: string) => {
    props.onChange(model);
    setOpen(false);
    stopListening();
  };

  const clearSelection = (e: MouseEvent) => {
    e.stopPropagation();
    props.onChange("");
    setOpen(false);
    stopListening();
  };

  const displayValue = () => {
    if (!props.value) return props.placeholder ?? "— Use fallback chain —";
    // Show just model name after provider/
    const slash = props.value.indexOf("/");
    return slash >= 0 ? props.value : props.value;
  };

  const providerOf = (model: string) => {
    const slash = model.indexOf("/");
    return slash >= 0 ? model.substring(0, slash) : "";
  };

  return (
    <div class="model-select" ref={containerRef}>
      {/* Trigger button */}
      <button class="model-select-trigger" onClick={openDropdown} type="button">
        <span class={`model-select-value ${!props.value ? "placeholder" : ""}`}>
          {props.value ? (
            <>
              <span class="model-select-provider">{providerOf(props.value)}/</span>
              {props.value.substring(props.value.indexOf("/") + 1)}
            </>
          ) : (
            displayValue()
          )}
        </span>
        <span class="model-select-actions">
          <Show when={props.value}>
            <button
              type="button"
              class="model-select-clear"
              onClick={clearSelection}
              title="Clear selection"
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
            >
              ✕
            </button>
          </Show>
          <span class="model-select-chevron">▾</span>
        </span>
      </button>

      {/* Dropdown */}
      <Show when={open()}>
        <div class="model-select-dropdown">
          <div class="model-select-search-wrap">
            <input
              ref={inputRef}
              class="model-select-search"
              type="text"
              placeholder="Search models..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setOpen(false);
                  stopListening();
                }
              }}
            />
          </div>
          <div class="model-select-options">
            <For each={grouped()} fallback={<div class="model-select-empty">No models found</div>}>
              {([provider, models]) => (
                <div class="model-select-group">
                  <div class="model-select-group-label">{provider}</div>
                  <For each={models}>
                    {(model) => (
                      <button
                        class={`model-select-option ${props.value === model ? "active" : ""}`}
                        onClick={() => selectModel(model)}
                        type="button"
                      >
                        {model.substring(model.indexOf("/") + 1)}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
