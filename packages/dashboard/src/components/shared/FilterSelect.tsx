import { createSignal, For, Show, onCleanup } from "solid-js";

interface FilterOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Compact inline style for table cells etc. */
  compact?: boolean;
}

export default function FilterSelect(props: FilterSelectProps) {
  const [open, setOpen] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setOpen(false);
    }
  };

  const startListening = () => document.addEventListener("mousedown", handleClickOutside);
  const stopListening = () => document.removeEventListener("mousedown", handleClickOutside);
  onCleanup(stopListening);

  const selectedLabel = () => {
    if (!props.value) return props.placeholder ?? "All";
    const opt = props.options.find((o) => o.value === props.value);
    return opt?.label ?? props.value;
  };

  const select = (value: string) => {
    props.onChange(value);
    setOpen(false);
    stopListening();
  };

  return (
    <div class={`fsel ${props.compact ? "fsel-compact" : ""}`} ref={containerRef}>
      <button
        class="fsel-trigger"
        onClick={() => { setOpen(!open()); if (!open()) stopListening(); else startListening(); }}
        type="button"
      >
        <span class={`fsel-value ${!props.value ? "placeholder" : ""}`}>
          {selectedLabel()}
        </span>
        <span class="fsel-chevron">▾</span>
      </button>

      <Show when={open()}>
        <div class="fsel-dropdown">
          <For each={props.options}>
            {(opt) => (
              <button
                class={`fsel-option ${props.value === opt.value ? "active" : ""}`}
                onClick={() => select(opt.value)}
                type="button"
              >
                {opt.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
