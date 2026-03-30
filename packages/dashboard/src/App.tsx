import { createSignal, createResource, Show, onMount } from "solid-js";
import type { NavSection, DbHealth } from "./lib/types";
import { getDbHealth, getAvailableModels } from "./lib/api";
import Sidebar from "./components/Layout/Sidebar";
import StatusBar from "./components/Layout/StatusBar";
import MemoryBrowser from "./components/MemoryBrowser/MemoryBrowser";
import SessionViewer from "./components/SessionViewer/SessionViewer";
import CacheDiagnostics from "./components/CacheDiagnostics/CacheDiagnostics";
import DreamerPanel from "./components/DreamerPanel/DreamerPanel";
import ConfigEditor from "./components/ConfigEditor/ConfigEditor";
import LogViewer from "./components/LogViewer/LogViewer";

const MODELS_CACHE_KEY = "mc_dashboard_models_cache";

function loadCachedModels(): string[] {
  try {
    const raw = localStorage.getItem(MODELS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export default function App() {
  const [activeSection, setActiveSection] = createSignal<NavSection>("memories");
  const [health] = createResource(getDbHealth);
  const [availableModels, setAvailableModels] = createSignal<string[]>(loadCachedModels());

  // Background refresh — never blocks UI
  onMount(() => {
    getAvailableModels().then((fresh) => {
      setAvailableModels(fresh);
      try { localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(fresh)); } catch {}
    }).catch(() => { /* keep cached */ });
  });

  return (
    <div class="app-shell">
      <Sidebar active={activeSection()} onNavigate={setActiveSection} />

      <main class="content">
        <Show when={activeSection() === "memories"}>
          <MemoryBrowser />
        </Show>
        <Show when={activeSection() === "sessions"}>
          <SessionViewer />
        </Show>
        <Show when={activeSection() === "cache"}>
          <CacheDiagnostics />
        </Show>
        <Show when={activeSection() === "dreamer"}>
          <DreamerPanel />
        </Show>
        <Show when={activeSection() === "config"}>
          <ConfigEditor models={availableModels()} />
        </Show>
        <Show when={activeSection() === "logs"}>
          <LogViewer />
        </Show>
      </main>

      <StatusBar health={health()} />
    </div>
  );
}
