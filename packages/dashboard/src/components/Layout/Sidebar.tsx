import type { NavSection } from "../../lib/types";

const NAV_ITEMS: { id: NavSection; icon: string; label: string }[] = [
  { id: "memories", icon: "🧠", label: "Mem" },
  { id: "sessions", icon: "📜", label: "Hist" },
  { id: "cache", icon: "📊", label: "Cache" },
  { id: "dreamer", icon: "🌙", label: "Dream" },
  { id: "user-memories", icon: "👤", label: "User" },
  { id: "config", icon: "⚙️", label: "Config" },
  { id: "logs", icon: "📋", label: "Logs" },
];

interface Props {
  active: NavSection;
  onNavigate: (section: NavSection) => void;
}

export default function Sidebar(props: Props) {
  return (
    <nav class="nav">
      {NAV_ITEMS.map((item) => (
        <button
          type="button"
          class={`nav-item ${props.active === item.id ? "active" : ""}`}
          onClick={() => props.onNavigate(item.id)}
          title={item.label}
        >
          <span style={{ "font-size": "18px" }}>{item.icon}</span>
          <span class="nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
