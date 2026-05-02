import type { Harness } from "../lib/types";

interface HarnessBadgeProps {
  harness: Harness;
}

export default function HarnessBadge(props: HarnessBadgeProps) {
  const isPi = () => props.harness === "pi";

  return (
    <span
      class={`pill ${isPi() ? "purple" : "amber"}`}
      title={isPi() ? "Pi" : "OpenCode"}
      style={{ "font-size": "9px", "line-height": "1.3", "text-transform": "uppercase" }}
    >
      {isPi() ? "Pi" : "OC"}
    </span>
  );
}
