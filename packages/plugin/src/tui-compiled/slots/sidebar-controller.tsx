import { createSignal } from "opentui:runtime-module:solid-js";
import { PLUGIN_KEY, queueTuiPreferenceUpdate, readTuiPreferencesFile, resolveMagicContextPrefs, watchTuiPreferences } from "../../shared/tui-preferences";

// This file has no JSX. It is a .tsx file so the TUI build compiles it and binds
// `solid-js` to the host's runtime; a .ts file is copied verbatim and would load
// a second Solid copy whose signals the host never observes.

// The TUI may unmount and remount sidebar_content when the user switches views
// (main -> subagent -> main). A remount re-runs the component body, so a signal
// created inside the component would reset to its seed. The controller lives in
// the slot-factory closure (plugin/process lifetime) and owns the durable
// prefs/collapse signals plus the single shared file watcher, so collapse state
// and live pref reloads survive remounts. No Solid effects/memos here — those
// need an owner.
export function createSidebarController(initialPrefs) {
  const [prefs, setPrefs] = createSignal(initialPrefs);
  const seedCollapsed = initialPrefs.rememberCollapsed && initialPrefs.collapsed != null ? initialPrefs.collapsed : initialPrefs.startCollapsed;
  const [collapsed, setCollapsed] = createSignal(seedCollapsed);
  let lastPersistedCollapsed = initialPrefs.collapsed;
  let lastApplied = JSON.stringify(initialPrefs);

  // Collapse echo guard: lastPersistedCollapsed advances only once our own
  // write lands, so a watcher echo of the value we just wrote is rejected by
  // the `!==` check and cannot revert a user click.
  const stopWatchingPreferences = watchTuiPreferences(() => {
    void (async () => {
      const next = resolveMagicContextPrefs(await readTuiPreferencesFile());
      const serialized = JSON.stringify(next);
      if (serialized === lastApplied) return;
      lastApplied = serialized;
      setPrefs(next);
      if (next.rememberCollapsed && next.collapsed != null && next.collapsed !== lastPersistedCollapsed) {
        lastPersistedCollapsed = next.collapsed;
        setCollapsed(next.collapsed);
      }
    })();
  });
  function toggleCollapsed() {
    const next = !collapsed();
    setCollapsed(next);
    if (prefs().rememberCollapsed) {
      void queueTuiPreferenceUpdate(PLUGIN_KEY, ["collapsed"], next).then(() => {
        lastPersistedCollapsed = next;
      });
    }
  }
  return {
    prefs,
    collapsed,
    toggleCollapsed,
    dispose: stopWatchingPreferences
  };
}