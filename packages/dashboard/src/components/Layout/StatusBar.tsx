import { Show } from "solid-js";
import { formatBytes } from "../../lib/api";
import type { DbHealth } from "../../lib/types";

interface Props {
  health: DbHealth | undefined;
}

export default function StatusBar(props: Props) {
  const dbStatus = () => {
    if (!props.health) return { label: "Loading...", color: "amber" };
    if (!props.health.exists) return { label: "DB: not found", color: "red" };
    return { label: `DB: ${formatBytes(props.health.size_bytes)}`, color: "green" };
  };

  const count = (name: string) => {
    return props.health?.table_counts.find((t) => t.table_name === name)?.row_count ?? 0;
  };

  return (
    <div class="status-bar">
      <div class="status-item">
        <span class={`status-dot ${dbStatus().color}`} />
        <span>{dbStatus().label}</span>
      </div>
      <Show when={props.health?.exists}>
        <div class="status-item">
          <span>{count("memories")} memories</span>
        </div>
        <div class="status-item">
          <span>{count("compartments")} compartments</span>
        </div>
        <div class="status-item">
          <span>{count("session_facts")} facts</span>
        </div>
        <div class="status-item">
          <span>{count("notes")} notes</span>
        </div>
      </Show>
    </div>
  );
}
