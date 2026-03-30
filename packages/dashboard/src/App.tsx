import { createSignal, createResource, Show, onMount, onCleanup } from "solid-js";
import type { NavSection, DbHealth } from "./lib/types";
import { getDbHealth, getAvailableModels } from "./lib/api";
import { checkForUpdate, installAndRelaunch } from "./lib/updater";
import Sidebar from "./components/Layout/Sidebar";
import StatusBar from "./components/Layout/StatusBar";
import MemoryBrowser from "./components/MemoryBrowser/MemoryBrowser";
import SessionViewer from "./components/SessionViewer/SessionViewer";
import CacheDiagnostics from "./components/CacheDiagnostics/CacheDiagnostics";
import DreamerPanel from "./components/DreamerPanel/DreamerPanel";
import ConfigEditor from "./components/ConfigEditor/ConfigEditor";
import LogViewer from "./components/LogViewer/LogViewer";

const MODELS_CACHE_KEY = "mc_dashboard_models_cache";
const UPDATE_POLL_INTERVAL = 10 * 60 * 1000; // 10 minutes

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
  const [updateVersion, setUpdateVersion] = createSignal<string | null>(null);
  const [updateInstalling, setUpdateInstalling] = createSignal(false);
  const [updateDismissed, setUpdateDismissed] = createSignal(false);

  // Background model refresh
  onMount(() => {
    getAvailableModels().then((fresh) => {
      setAvailableModels(fresh);
      try { localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(fresh)); } catch {}
    }).catch(() => { /* keep cached */ });
  });

  // Background update polling
  let updateInterval: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    const poll = () => {
      if (updateVersion()) return; // already found
      checkForUpdate().then((version) => {
        if (version) setUpdateVersion(version);
      });
    };
    // Check immediately, then every 10 minutes
    poll();
    updateInterval = setInterval(poll, UPDATE_POLL_INTERVAL);
  });
  onCleanup(() => { if (updateInterval) clearInterval(updateInterval); });

  const handleInstall = async () => {
    setUpdateInstalling(true);
    await installAndRelaunch();
    // If relaunch fails, reset state
    setUpdateInstalling(false);
  };

  return (
    <div class="app-shell">
      <Sidebar active={activeSection()} onNavigate={setActiveSection} />

      <main class="content">
        {/* Update toast */}
        <Show when={updateVersion() && !updateDismissed()}>
          <div class="update-toast">
            <div class="update-toast-content">
              <span class="update-toast-icon">⬆</span>
              <div class="update-toast-text">
                <strong>Update available</strong>
                <span>v{updateVersion()} is ready to install</span>
              </div>
            </div>
            <div class="update-toast-actions">
              <button
                class="btn primary sm"
                disabled={updateInstalling()}
                onClick={handleInstall}
              >
                {updateInstalling() ? "Installing..." : "Install & Restart"}
              </button>
              <button
                class="btn sm"
                onClick={() => setUpdateDismissed(true)}
              >
                Later
              </button>
            </div>
          </div>
        </Show>

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
