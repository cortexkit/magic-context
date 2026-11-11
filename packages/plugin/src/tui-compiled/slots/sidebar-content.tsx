import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, on, onCleanup } from "opentui:runtime-module:solid-js";
import packageJson from "../../../package.json";
import { loadSidebarSnapshot } from "../data/context-db";
import { directoryForSession } from "../data/session-directory";
import { computeEffectiveOrder, DEFAULT_SLOT_ORDER, PLUGIN_KEY, readTuiPreferencesFileSync, resolveMagicContextPrefs } from "../../shared/tui-preferences";
import { createSidebarController } from "./sidebar-controller";
import { SidebarPanel, sidebarTheme } from "./sidebar-panel";
import { buildSidebarView } from "./sidebar-view";

// Module-level hook so the upgrade/recomp dialog can kick the sidebar into its
// fast recomp self-poll the INSTANT the user confirms — without waiting for a
// parent-session message event (the RPC upgrade/recomp call fires none). The
// mounted SidebarContent registers its refresh here.
let activeRecompPollKick = null;
let activeSidebarRefresh = null;
export function kickRecompProgressRefresh() {
  activeRecompPollKick?.();
}

/** Ask the mounted sidebar to fetch an out-of-band status update now. */
export function refreshSidebarSnapshot() {
  activeSidebarRefresh?.();
}
const REFRESH_DEBOUNCE_MS = 150;
// Ages such as "Last run 12m ago" are worked out from the clock, so the panel
// redraws them each minute even when no event arrives.
const CLOCK_TICK_MS = 60_000;
const SidebarContent = props => {
  const [snapshot, setSnapshot] = createSignal(null);
  // Collapse state + section visibility prefs live in the controller (plugin
  // closure), so they survive view-switch remounts and persist across restarts
  // via ~/.config/opencode/tui-preferences.jsonc. Read reactively below.
  let refreshTimer;
  // Self-sustaining poll while a recomp/upgrade is running. Recomp work
  // happens in CHILD sessions whose message events are filtered out of the
  // subscription below, so without this the progress bar would freeze until
  // the next parent-session message. Active only during recomp/migration;
  // stops itself once the phase goes terminal/absent (dogfood 2026-05-30).
  let recompPollTimer;
  const RECOMP_POLL_MS = 1200;
  // Robust recomp poll state. The loop MUST survive a failed/slow snapshot
  // fetch — the server is busy doing the historian LLM call during a recomp,
  // so a poll can reject or return a stale (pre-recomp) cached snapshot. The
  // OLD loop reattached the next timer only inside `.then()`, so any rejection
  // killed it and the bar froze mid-pass (dogfood 2026-05-30). This version
  // reschedules on BOTH success and failure, keyed on `recompActive`, and only
  // stops on a terminal phase, a bounded "never started" probe window, or the
  // entry vanishing after we'd seen it active.
  let recompActive = false;
  let recompSawPhase = false;
  let recompPollCount = 0;
  let recompConsecutiveAbsent = 0;
  let recompSessionId = null;
  let snapshotRequestSequence = 0;
  const RECOMP_PROBE_MAX = 12; // ~15s for the server's "Starting…" to land
  // After we've SEEN an active phase, a momentarily absent snapshot is almost
  // always transient — the server's sticky cache serves a pre-recomp snapshot
  // (no recompProgress) during the token-quiet recomp window, or a concurrent
  // BEGIN-IMMEDIATE publish makes the snapshot DB read throw → bare empty. The
  // entry is held until terminal + a 30s grace, so we keep polling through many
  // absents and only give up after a long run of them (entry truly gone but we
  // somehow missed "done"). This was the freeze: the old logic stopped on the
  // FIRST absent-after-active (dogfood 2026-05-30).
  const RECOMP_ABSENT_GIVEUP = 40; // ~48s of continuous absence → stop
  const RECOMP_MAX_POLLS = 1500; // ~30min absolute safety cap

  const refresh = () => {
    const sid = props.sessionID();
    if (!sid) return;
    const sequence = ++snapshotRequestSequence;
    const directory = directoryForSession(props.api.state.session?.get?.(sid)?.directory, props.api.state.path.directory ?? "");
    void loadSidebarSnapshot(sid, directory).then(data => {
      // Guard against a session switch while this load was in flight:
      // painting session A's snapshot into the now-active session B shows
      // the wrong session's numbers until B's own refresh resolves.
      if (props.sessionID() !== sid || sequence !== snapshotRequestSequence) return;
      setSnapshot(data);
      try {
        props.api.renderer.requestRender();
      } catch {
        // Ignore render errors
      }
      // If a recomp/upgrade is running (detected via any refresh, e.g.
      // a /ctx-recomp command not started from the dialog), make sure
      // the dedicated poll loop is running.
      const phase = data?.recompProgress?.phase;
      if ((phase === "recomp" || phase === "migration") && !recompActive) {
        kickRecompPoll();
      } else if (recompActive && recompSessionId === sid) {
        scheduleRecompTick();
      }
    }).catch(() => {
      // A one-shot refresh failure is non-fatal. If it superseded a fast
      // poll request, keep that poll moving for the captured session.
      if (recompActive && recompSessionId === sid && props.sessionID() === sid) {
        scheduleRecompTick();
      }
    });
  };
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  };
  const stopRecompPoll = () => {
    recompActive = false;
    recompSessionId = null;
    snapshotRequestSequence += 1;
    if (recompPollTimer) clearTimeout(recompPollTimer);
    recompPollTimer = undefined;
  };
  const scheduleRecompTick = () => {
    if (!recompActive) return;
    if (recompPollTimer) clearTimeout(recompPollTimer);
    recompPollTimer = setTimeout(recompTick, RECOMP_POLL_MS);
  };
  function recompTick() {
    const sid = recompSessionId;
    if (!recompActive || !sid || props.sessionID() !== sid) {
      stopRecompPoll();
      return;
    }
    recompPollCount += 1;
    if (recompPollCount > RECOMP_MAX_POLLS) {
      stopRecompPoll();
      return;
    }
    const sequence = ++snapshotRequestSequence;
    const directory = directoryForSession(props.api.state.session?.get?.(sid)?.directory, props.api.state.path.directory ?? "");
    void loadSidebarSnapshot(sid, directory).then(data => {
      if (!recompActive || recompSessionId !== sid || props.sessionID() !== sid || sequence !== snapshotRequestSequence) return;
      const phase = data?.recompProgress?.phase;
      // While a recomp is known-active, a transient snapshot that lost
      // recompProgress (sticky cache / busy-DB empty) must NOT wipe the
      // visible bar — carry the last good progress forward so it stays
      // stable until a real update or the terminal state lands.
      const prevProgress = snapshot()?.recompProgress;
      const merged = !phase && recompSawPhase && prevProgress ? {
        ...data,
        recompProgress: prevProgress
      } : data;
      setSnapshot(merged);
      try {
        props.api.renderer.requestRender();
      } catch {
        // ignore render errors
      }
      if (phase === "recomp" || phase === "migration") {
        recompSawPhase = true;
        recompConsecutiveAbsent = 0;
        scheduleRecompTick();
      } else if (phase === "done" || phase === "failed" || phase === "skipped") {
        // Terminal state rendered — stop. The server keeps "done"/
        // "skipped" for a grace window and "failed" until the next run,
        // so the outcome stays visible without further polling.
        stopRecompPoll();
      } else {
        // Phase absent this poll.
        recompConsecutiveAbsent += 1;
        if (!recompSawPhase) {
          // Still waiting for the server's first "Starting…".
          if (recompPollCount < RECOMP_PROBE_MAX) scheduleRecompTick();else {
            stopRecompPoll();
          }
        } else if (recompConsecutiveAbsent < RECOMP_ABSENT_GIVEUP) {
          // Seen it active — absent is almost certainly the sticky
          // cache / a transient snapshot read. Keep polling so we
          // still catch the terminal state. DON'T overwrite the
          // last good progress snapshot with this transient empty.
          scheduleRecompTick();
        } else {
          // Long continuous absence — the entry is genuinely gone.
          stopRecompPoll();
        }
      }
    }).catch(() => {
      // A failed fetch must not kill the loop, but a response from a
      // superseded session or sequence must not restart it either.
      if (recompActive && recompSessionId === sid && props.sessionID() === sid && sequence === snapshotRequestSequence) scheduleRecompTick();
    });
  }

  // Kick the resilient recomp poll loop on dialog confirm (or when a refresh
  // first detects an active recomp). The server emits an immediate "Starting…"
  // entry; the probe window covers the brief RPC race before it lands.
  function kickRecompPoll() {
    const sid = props.sessionID();
    if (!sid) return;
    if (recompActive && recompSessionId === sid) return;
    stopRecompPoll();
    recompActive = true;
    recompSessionId = sid;
    recompSawPhase = false;
    recompPollCount = 0;
    recompConsecutiveAbsent = 0;
    recompTick();
  }
  activeRecompPollKick = kickRecompPoll;
  activeSidebarRefresh = refresh;
  onCleanup(() => {
    if (refreshTimer) clearTimeout(refreshTimer);
    stopRecompPoll();
    if (activeRecompPollKick === kickRecompPoll) activeRecompPollKick = null;
    if (activeSidebarRefresh === refresh) activeSidebarRefresh = null;
  });

  // Refresh on session change
  createEffect(on(props.sessionID, () => {
    stopRecompPoll();
    setSnapshot(null);
    refresh();
  }));

  // Subscribe to events for live updates
  createEffect(on(props.sessionID, sessionID => {
    const unsubs = [props.api.event.on("message.updated", event => {
      if (event.properties.info.sessionID !== sessionID) return;
      scheduleRefresh();
    }), props.api.event.on("session.updated", event => {
      if (event.properties.info.id !== sessionID) return;
      scheduleRefresh();
    }), props.api.event.on("message.removed", event => {
      if (event.properties.sessionID !== sessionID) return;
      scheduleRefresh();
    })];
    onCleanup(() => {
      for (const unsub of unsubs) unsub();
    });
  }, {
    defer: false
  }));
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
  onCleanup(() => clearInterval(clock));
  const view = createMemo(() => buildSidebarView(snapshot(), props.controller.prefs().sections, now()));
  return _$createComponent(SidebarPanel, {
    get view() {
      return view();
    },
    get collapsed() {
      return props.controller.collapsed();
    },
    get onToggle() {
      return props.controller.toggleCollapsed;
    },
    get theme() {
      return sidebarTheme(props.theme);
    },
    get label() {
      return props.controller.prefs().header.label;
    },
    get version() {
      return `v${packageJson.version}`;
    },
    get now() {
      return now();
    }
  });
};
export function createSidebarContentSlot(api) {
  // Seed synchronously at slot construction so the sidebar renders at its
  // final collapse state + order on the first paint (no async flicker). The
  // controller lives here in the factory closure for the plugin lifetime, so
  // collapse state and live pref reloads survive sidebar_content remounts.
  const seedRoot = readTuiPreferencesFileSync();
  const controller = createSidebarController(resolveMagicContextPrefs(seedRoot));
  const effectiveOrder = computeEffectiveOrder(seedRoot, PLUGIN_KEY, DEFAULT_SLOT_ORDER);
  return {
    order: effectiveOrder,
    dispose: controller.dispose,
    slots: {
      sidebar_content: (ctx, value) => {
        const theme = createMemo(() => ctx.theme.current);
        return _$createComponent(SidebarContent, {
          api: api,
          sessionID: () => value.session_id,
          get theme() {
            return theme();
          },
          controller: controller
        });
      }
    }
  };
}