import { createMemo, createSignal, For, Show } from "solid-js";
import FloatingLayer from "../shared/FloatingLayer";
import { pickerAccessibleName, pickerSelectedText } from "./a11y-state";

export interface PickerOption {
  value: string;
  label: string;
}

export default function SearchPicker(props: {
  label: string;
  value: string | undefined;
  options: readonly PickerOption[];
  onChange: (value: string | undefined) => void;
  allowCustom?: boolean;
  emptyLabel?: string;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  let trigger!: HTMLButtonElement;
  const filtered = createMemo(() =>
    props.options.filter((option) => option.label.toLowerCase().includes(query().toLowerCase())),
  );
  const choose = (value: string | undefined) => {
    props.onChange(value);
    setOpen(false);
    trigger.focus();
  };
  const displayValue = () => selectedText() ?? emptyText();
  const selectedText = () => pickerSelectedText(props.options, props.value);
  const emptyText = () => props.emptyLabel ?? "Use harness default";
  return (
    <div class="search-picker">
      <button
        ref={trigger}
        type="button"
        class="model-select-trigger"
        aria-label={pickerAccessibleName(props.label, selectedText(), emptyText())}
        aria-expanded={open()}
        aria-haspopup="dialog"
        title={displayValue()}
        onClick={() => {
          setQuery("");
          setOpen(!open());
        }}
      >
        <span class="model-select-value">{displayValue()}</span>
        <span class="model-select-chevron">▾</span>
      </button>
      <Show when={open()}>
        <FloatingLayer anchor={trigger} onClose={() => setOpen(false)}>
          <div role="dialog" aria-label={props.label}>
            <div class="model-select-search-wrap">
              <input
                ref={(input) => requestAnimationFrame(() => input.focus())}
                class="model-select-search"
                aria-label={`Search ${props.label}`}
                placeholder="Search…"
                value={query()}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    const exact = props.options.find((option) => option.value === query());
                    if (exact || props.allowCustom) choose(query().trim() || undefined);
                    else if (filtered().length === 1) choose(filtered()[0].value);
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    event.currentTarget
                      .closest('[role="dialog"]')
                      ?.querySelector<HTMLButtonElement>("button")
                      ?.focus();
                  }
                }}
              />
            </div>
            <div class="model-select-options">
              <button type="button" class="model-select-option" onClick={() => choose(undefined)}>
                {emptyText()}
              </button>
              <For each={filtered()}>
                {(option) => (
                  <button
                    type="button"
                    class="model-select-option"
                    onClick={() => choose(option.value)}
                  >
                    {option.label}
                  </button>
                )}
              </For>
              <Show
                when={
                  props.allowCustom &&
                  query().trim() &&
                  !props.options.some((option) => option.value === query().trim())
                }
              >
                <button
                  type="button"
                  class="model-select-option"
                  onClick={() => choose(query().trim())}
                >
                  Use “{query().trim()}”
                </button>
              </Show>
            </div>
          </div>
        </FloatingLayer>
      </Show>
    </div>
  );
}
