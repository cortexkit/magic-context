import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import { createMemo } from "opentui:runtime-module:solid-js";
import { StatusDialog } from "./dialogs/status-dialog";
import { createSidebarContentSlot, kickRecompProgressRefresh, refreshSidebarSnapshot } from "./slots/sidebar-content";
import { closeRpc, getAnnouncement, getCompartmentCount, getRpcGeneration, initRpcClient, loadEmbedDetail, loadStatusDetail, loadToastDurationMs, markAnnounced, requestRecomp } from "./data/context-db";
import { directoryForSession } from "./data/session-directory";
import { startNotificationSocket, stopNotificationSocket } from "./data/notification-socket";
import { isCompactionEnabled } from "../config/agent-disable";
import { loadPluginConfig } from "../config";
import { detectConflicts } from "../shared/conflict-detector";
import { fixConflicts } from "../shared/conflict-fixer";
const DEFAULT_TOAST_DURATION_MS = 5000;
let unifiedToastDurationMs = DEFAULT_TOAST_DURATION_MS;
async function refreshToastDurationMs() {
  try {
    const resolved = await loadToastDurationMs();
    if (typeof resolved === "number" && Number.isFinite(resolved)) {
      unifiedToastDurationMs = resolved;
    }
  } catch {
    // Keep the current value; the next poll/startup can retry.
  }
}
function getToastDurationMs() {
  return unifiedToastDurationMs;
}
function showToast(api, input) {
  const duration = typeof input.durationOverrideMs === "number" && Number.isFinite(input.durationOverrideMs) ? input.durationOverrideMs : getToastDurationMs();
  // toast_duration_ms = 0 disables Magic Context toasts entirely. An explicit
  // positive per-call override (e.g. restart-required) still shows; only a
  // non-positive effective duration suppresses the toast.
  if (!(duration > 0)) {
    return;
  }
  api.ui.toast({
    message: input.message,
    variant: input.variant,
    duration
  });
}
function showConflictDialog(api, directory, reasons, conflicts) {
  api.ui.dialog.replace(() => _$createComponent(api.ui.DialogConfirm, {
    title: "\u26A0\uFE0F Magic Context Disabled",
    get message() {
      return `${reasons.join("\n")}\n\nFix these conflicts automatically?`;
    },
    onConfirm: () => {
      const actions = fixConflicts(directory, conflicts);
      const actionSummary = actions.length > 0 ? actions.map(a => `• ${a}`).join("\n") : "No changes needed";
      // DialogConfirm calls dialog.clear() after onConfirm, so defer the next dialog
      setTimeout(() => {
        api.ui.dialog.replace(() => _$createComponent(api.ui.DialogAlert, {
          title: "\u2705 Configuration Fixed",
          message: `${actionSummary}\n\nPlease restart OpenCode for changes to take effect.`,
          onConfirm: () => {
            showToast(api, {
              message: "Restart OpenCode to enable Magic Context",
              variant: "warning",
              durationOverrideMs: 10_000
            });
          }
        }));
      }, 50);
    },
    onCancel: () => {
      showToast(api, {
        message: "Magic Context remains disabled. Run: npx @cortexkit/opencode-magic-context@latest doctor",
        variant: "warning"
      });
    }
  }));
}
function fmt(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
function fmtBytes(n) {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${Math.round(n / 1_024)} KB`;
  return `${n} B`;
}
function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
function getSessionId(api) {
  try {
    const route = api.route.current;
    if (route?.name === "session" && route.params?.sessionID) {
      return route.params.sessionID;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * The directory whose Magic Context server owns this session, which is not
 * necessarily the directory the TUI started in (see `directoryForSession`).
 */
function sessionDirectory(api, sessionId) {
  let reported;
  try {
    reported = api.state.session.get(sessionId)?.directory;
  } catch {
    // Session state not available yet: fall back to the startup directory.
  }
  return directoryForSession(reported, api.state.path.directory ?? "");
}
function getModelKeyFromMessages(api, sessionId) {
  try {
    const msgs = api.state.session.messages(sessionId);
    // Find the last assistant message with model info
    // AssistantMessage has providerID/modelID as top-level fields
    // UserMessage has model: { providerID, modelID }
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role === "assistant" && msg.providerID && msg.modelID) {
        return `${msg.providerID}/${msg.modelID}`;
      }
      if (msg.role === "user") {
        const model = msg.model;
        if (model?.providerID && model?.modelID) {
          return `${model.providerID}/${model.modelID}`;
        }
      }
    }
  } catch {
    // messages not available
  }
  return undefined;
}
async function showRecompDialog(api, targetSessionId = getSessionId(api)) {
  const sessionId = targetSessionId;
  if (!sessionId) {
    showToast(api, {
      message: "No active session",
      variant: "warning"
    });
    return false;
  }
  const countResult = await getCompartmentCount(sessionId, sessionDirectory(api, sessionId));
  // Ack only after the dialog is actually shown for the same active session;
  // route switches while the RPC detail load is in flight must leave it pending.
  if (getSessionId(api) !== sessionId) return false;
  if (!countResult.ok) {
    showToast(api, {
      message: "Unable to load recomp details",
      variant: "error"
    });
    return false;
  }
  const count = countResult.count;
  api.ui.dialog.replace(() => _$createComponent(api.ui.DialogConfirm, {
    title: "\u26A0\uFE0F Recomp Confirmation",
    get message() {
      return [count === 0 ? "This session has no compartments yet — recomp will build them from raw history." : `You have ${count} compartments.`, "", "Recomp will rebuild the compressed history from raw history. Saved memories are not changed.", "This may take a long time and consume significant tokens.", "", "Proceed?"].join("\n");
    },
    onConfirm: async () => {
      const requested = await requestRecomp(sessionId, sessionDirectory(api, sessionId));
      if (!requested) {
        showToast(api, {
          message: "Recomp request failed",
          variant: "error"
        });
        return;
      }
      kickRecompProgressRefresh();
      showToast(api, {
        message: "Recomp requested — historian will start shortly",
        variant: "info"
      });
    },
    onCancel: () => {
      showToast(api, {
        message: "Recomp cancelled",
        variant: "info",
        durationOverrideMs: 3000
      });
    }
  }));
  return true;
}
async function showStatusDialog(api, targetSessionId = getSessionId(api)) {
  const sessionId = targetSessionId;
  if (!sessionId) {
    showToast(api, {
      message: "No active session",
      variant: "warning"
    });
    return false;
  }
  const directory = sessionDirectory(api, sessionId);
  const modelKey = getModelKeyFromMessages(api, sessionId);
  const result = await loadStatusDetail(sessionId, directory, modelKey);
  if (getSessionId(api) !== sessionId) return false;
  // A result without a usable snapshot still opens the dialog: it shows the
  // "status unavailable" view naming the reason (RPC error, a directory the
  // server keeps no state for, missing fields, a server/UI version
  // difference) instead of a toast that disappears.
  api.ui.dialog.replace(() => _$createComponent(StatusDialog, {
    api: api,
    status: result
  }));
  return true;
}
const EmbedDialog = props => {
  const theme = createMemo(() => props.api.theme.current);
  const t = () => theme();
  const lines = () => props.detail.statusText.split("\n");
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box"),
      _el$3 = _$createElement("text"),
      _el$4 = _$createElement("b");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "paddingLeft", 2);
    _$setProp(_el$, "paddingRight", 2);
    _$setProp(_el$, "paddingTop", 1);
    _$setProp(_el$, "paddingBottom", 1);
    _$insertNode(_el$2, _el$3);
    _$setProp(_el$2, "justifyContent", "center");
    _$setProp(_el$2, "width", "100%");
    _$setProp(_el$2, "marginBottom", 1);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$4, _$createTextNode(`Embedding`));
    _$insert(_el$, () => lines().map(line => (() => {
      var _el$6 = _$createElement("text");
      _$insert(_el$6, line);
      _$effect(_$p => _$setProp(_el$6, "fg", t().text, _$p));
      return _el$6;
    })()), null);
    _$effect(_$p => _$setProp(_el$3, "fg", t().accent, _$p));
    return _el$;
  })();
};
async function showEmbedDialog(api, targetSessionId = getSessionId(api)) {
  const sessionId = targetSessionId;
  if (!sessionId) {
    api.ui.toast({
      message: "No active session",
      variant: "warning"
    });
    return false;
  }
  const directory = sessionDirectory(api, sessionId);
  const detail = await loadEmbedDetail(sessionId, directory);
  if (getSessionId(api) !== sessionId) return false;
  api.ui.dialog.replace(() => _$createComponent(EmbedDialog, {
    api: api,
    detail: detail
  }));
  return true;
}
function showResultDialog(api, title, message) {
  api.ui.dialog.replace(() => _$createComponent(api.ui.DialogAlert, {
    title: title,
    message: message,
    onConfirm: () => {}
  }));
  return true;
}
function probeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim() || "unknown error";
}
function probeVersion(api) {
  try {
    const version = api.app?.version;
    return typeof version === "string" && version.length > 0 ? version : "unavailable";
  } catch {
    return "unavailable";
  }
}
function renderTuiProbeHostArm(api, result) {
  try {
    api.ui.dialog.replace(() => {
      try {
        const element = _$createComponent(api.ui.DialogAlert, {
          title: "Magic Context TUI probe: host arm",
          message: "Host-owned dialog probe is rendering. It will be replaced after 500ms.",
          onConfirm: () => {}
        });
        result.hostConstructed = true;
        return element;
      } catch (error) {
        result.hostThrew = probeErrorMessage(error);
        return null;
      }
    });
  } catch (error) {
    result.hostThrew ??= probeErrorMessage(error);
  }
}
function renderTuiProbeCustomArm(api, result) {
  try {
    api.ui.dialog.replace(() => {
      try {
        return (() => {
          var _el$7 = _$createElement("box"),
            _el$8 = _$createElement("text");
          _$insertNode(_el$7, _el$8);
          _$insertNode(_el$8, _$createTextNode(`probe`));
          return _el$7;
        })();
      } catch (error) {
        result.customThrew = probeErrorMessage(error);
        return null;
      }
    });
  } catch (error) {
    result.customThrew ??= probeErrorMessage(error);
  }
}
async function waitForTuiProbeHostPaint(api, result) {
  if (result.hostThrew !== null) {
    result.hostPainted = false;
    result.hostPaint = "not_reached_host_threw";
    return;
  }
  let renderer;
  try {
    renderer = api.renderer;
  } catch {
    // Older hosts may not expose a renderer paint signal.
  }
  if (!renderer || typeof renderer.once !== "function") {
    await new Promise(resolve => setTimeout(resolve, 500));
    result.hostPainted = null;
    result.hostPaint = "no_frame_signal_after_500ms_visual_confirmation_required";
    return;
  }
  await new Promise(resolve => {
    let settled = false;
    const onFrame = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      renderer.removeListener?.("frame", onFrame);
      result.hostPainted = true;
      result.hostPaint = "observed_renderer_frame";
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      renderer?.removeListener?.("frame", onFrame);
      result.hostPainted = null;
      result.hostPaint = "no_frame_after_500ms_visual_confirmation_required";
      resolve();
    }, 500);
    try {
      renderer.once("frame", onFrame);
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      renderer.removeListener?.("frame", onFrame);
      result.hostPainted = null;
      result.hostPaint = `frame_signal_error_${probeErrorMessage(error)}`;
      resolve();
    }
  });
}
function tuiProbeSummary(result) {
  return [`host_constructed=${String(result.hostConstructed)}`, `host_threw=${result.hostThrew ?? "false"}`, `custom_threw=${result.customThrew ?? "false"}`, `opencode_version=${result.opencodeVersion}`, `host_painted=${result.hostPainted === null ? "unknown" : String(result.hostPainted)}`, `host_paint=${result.hostPaint}`];
}
function reportTuiProbe(api, result) {
  const lines = tuiProbeSummary(result);
  for (const line of lines) {
    console.error(`[mc-probe] ${line}`);
  }
  const summary = lines.join("\n");
  if (result.customThrew === null) {
    try {
      api.ui.dialog.replace(() => (() => {
        var _el$0 = _$createElement("box"),
          _el$1 = _$createElement("text");
        _$insertNode(_el$0, _el$1);
        _$insert(_el$1, summary);
        return _el$0;
      })());
      return;
    } catch (error) {
      console.error(`[mc-probe] summary_custom_threw=${probeErrorMessage(error)}`);
    }
  }
  if (result.hostThrew === null) {
    try {
      api.ui.dialog.replace(() => _$createComponent(api.ui.DialogAlert, {
        title: "Magic Context TUI probe",
        message: summary,
        onConfirm: () => {}
      }));
      return;
    } catch (error) {
      console.error(`[mc-probe] summary_host_threw=${probeErrorMessage(error)}`);
    }
  }
  console.error("[mc-probe] summary_rendered=console_only");
}
async function runTuiProbe(api) {
  const result = {
    hostConstructed: false,
    hostThrew: null,
    customThrew: null,
    opencodeVersion: probeVersion(api),
    hostPainted: null,
    hostPaint: "not_checked"
  };
  renderTuiProbeHostArm(api, result);
  await waitForTuiProbeHostPaint(api, result);
  renderTuiProbeCustomArm(api, result);
  reportTuiProbe(api, result);
}

/**
 * Register Magic Context command palette entries, preferring the v1.14.42+
 * `keymap.registerLayer` API and falling back to the legacy
 * `api.command.register` for older hosts.
 *
 * The `keymap.registerLayer` shape uses `name`/`title`/`run`/`namespace`
 * (see `@opencode-ai/plugin/tui` types) and is what the host's own legacy
 * command-shim translates into. Calling it directly skips the deprecation
 * warning and works without depending on the (now-deprecated) `api.command`
 * namespace existing at all.
 *
 * Version coverage:
 *   1.14.0–1.14.41 — `api.command.register` only
 *   1.14.42–1.14.43 — both surfaces broken (api.command removed, keymap landed
 *                     but with bugs); plugins crash on init either way
 *   1.14.44+        — `api.keymap.registerLayer` canonical, `api.command` shim
 */
function registerCommandPaletteEntries(api) {
  const apiAny = api;
  if (typeof apiAny.keymap?.registerLayer === "function") {
    // Audit Finding #2 hardening: even when registerLayer exists as a
    // function, the underlying keymap implementation in OpenCode TUI
    // 1.14.42-1.14.43 can throw at call time. Without the try-catch the
    // `return` below would propagate the throw and the legacy
    // `command.register` fallback path (~20 lines down) would be
    // unreachable. The cost is one debug log on the rare broken-TUI
    // build; the benefit is that older command.register-only TUIs
    // running alongside a partially-broken keymap surface still get
    // their command palette entries.
    try {
      apiAny.keymap.registerLayer({
        commands: [{
          namespace: "palette",
          name: "magic-context.status",
          title: "Magic Context: Status",
          category: "Magic Context",
          run() {
            showStatusDialog(api);
          }
        }, {
          namespace: "palette",
          name: "magic-context.recomp",
          title: "Magic Context: Recomp",
          category: "Magic Context",
          run() {
            showRecompDialog(api);
          }
        }, {
          namespace: "palette",
          name: "ctx-tui-probe",
          title: "Magic Context: TUI Probe",
          category: "Magic Context",
          run() {
            void runTuiProbe(api);
          }
        }],
        bindings: []
      });
      return;
    } catch (err) {
      console.debug("[magic-context-tui] keymap.registerLayer threw; falling back to command.register", err);
      // Fall through to legacy registration.
    }
  }
  if (typeof apiAny.command?.register === "function") {
    apiAny.command.register(() => [{
      title: "Magic Context: Status",
      value: "magic-context.status",
      category: "Magic Context",
      onSelect() {
        showStatusDialog(api);
      }
    }, {
      title: "Magic Context: Recomp",
      value: "magic-context.recomp",
      category: "Magic Context",
      onSelect() {
        showRecompDialog(api);
      }
    }, {
      title: "Magic Context: TUI Probe",
      value: "ctx-tui-probe",
      category: "Magic Context",
      onSelect() {
        void runTuiProbe(api);
      }
    }]);
    return;
  }

  // Neither API surface is present. The TUI host can still load — we only
  // lose the command palette entry points. The sidebar (registered above
  // via api.slots.register) remains visible. Status/Recomp are still
  // reachable through the server-side `/ctx-status` and `/ctx-recomp`
  // slash commands, which the server handler bridges to the TUI dialogs
  // via RPC.
}

/**
 * Show the one-shot "What's new" dialog on TUI startup if the server tells us
 * to. The server is the source of truth: it has the version + features
 * constants AND owns the persistence file. We just render and report back.
 *
 * Failure-tolerant by design — if the server isn't ready or the RPC fails,
 * we silently skip (the next TUI launch will retry).
 */
/**
 * URLs render as plain text. Modern terminals (iTerm2, kitty, WezTerm, Ghostty,
 * recent macOS Terminal) auto-detect URLs and let users Cmd-click; older
 * terminals require manual copy. We tried opentui's `<a href>` JSX intrinsic
 * for application-level OSC 8 clickability, but it's a span-like element that
 * forced text out of opentui's word-wrap mode, causing bullets to bleed past
 * the dialog border. Pure-string children of `<text>` wrap correctly, so the
 * AFT-style DialogAlert + plain string is the right surface here.
 */
async function showStartupAnnouncement(api) {
  try {
    const ann = await getAnnouncement();
    if (!ann.show || !ann.version || !ann.features || ann.features.length === 0) return;
    const title = `Magic Context v${ann.version}`;
    const lines = ["What's new:", "", ...ann.features.map(line => `  • ${line}`)];
    if (ann.footer && ann.footer.trim().length > 0) {
      // Blank-line separator keeps the persistent footer (Discord invite,
      // etc.) visually distinct from the version-specific bullets.
      lines.push("", ann.footer);
    }
    const message = lines.join("\n");
    api.ui.dialog.replace(() => _$createComponent(api.ui.DialogAlert, {
      title: title,
      message: message,
      onConfirm: () => {
        void markAnnounced();
      }
    }), () => {
      // User dismissed via Escape rather than confirming. Mark
      // dismissed anyway — they saw the dialog, that's the contract.
      void markAnnounced();
    });
  } catch {
    // RPC not ready yet (port file missing or transient HTTP failure) —
    // silently skip. The next TUI start re-checks.
  }
}
const tui = async (api, _options, meta) => {
  const directory = api.state.path.directory ?? "";
  // A conflicted installation intentionally has no server. Gate before RPC
  // discovery or socket startup so disabled installs perform no idle work.
  // The resolved MC compaction mode is threaded in explicitly via the same
  // loader + accessor the plugin boot uses, so the TUI never re-derives the
  // compaction decision from directory alone. On config load failure the
  // accessor resolves default-on (mode-on), preserving today's conflict
  // gate rather than silently skipping the check.
  let pluginConfig;
  try {
    pluginConfig = loadPluginConfig(directory);
  } catch {
    // Config load failure: fail toward mode-on (today's behavior) by
    // leaving pluginConfig undefined so isCompactionEnabled defaults true.
  }
  const conflictResult = detectConflicts(directory, {
    compactionEnabled: isCompactionEnabled(pluginConfig ?? {})
  });
  if (conflictResult.hasConflict) {
    showConflictDialog(api, directory, conflictResult.reasons, conflictResult.conflicts);
    return;
  }
  initRpcClient(directory);
  // RPC discovery can outlive the host's plugin-load deadline. Register the
  // sidebar immediately; toast delivery still awaits its own current setting.
  void refreshToastDurationMs();

  // Register sidebar slot
  const sidebarSlot = createSidebarContentSlot(api);
  api.slots.register(sidebarSlot);

  // Register TUI command palette entries (no slash field — slash commands
  // are registered server-side so there's only one /ctx-* registration).
  // The server detects TUI mode and sends dialog requests via RPC instead
  // of sendIgnoredMessage.
  //
  // OpenCode 1.14.42 removed `api.command.register` entirely
  // (anomalyco/opencode#26053). A later patch (1.14.44+) reinstated it as
  // a deprecated shim that translates to `api.keymap.registerLayer`. To
  // work across all hosts (1.14.0–1.14.41 with command-only, the broken
  // 1.14.42–1.14.43, and 1.14.44+ where both exist), we prefer
  // `api.keymap.registerLayer` and fall back to `api.command.register`
  // only when keymap is missing.
  registerCommandPaletteEntries(api);

  // Receive server→TUI notifications (toasts + dialog requests) over a single
  // persistent WebSocket, pushed the instant the server queues them. This
  // replaces the old 500ms HTTP poll whose new-connection-per-tick cost was the
  // source of idle TUI CPU (#200). The socket carries the active session in its
  // hello so the server scopes delivery; here we re-check the active session per
  // notification (it can change between queue and delivery) before acting.
  const handleNotification = async n => {
    const requestedSessionId = getSessionId(api);
    const generation = getRpcGeneration();
    // A session-scoped notification only applies while we're viewing that
    // session; global (session-less) ones always apply. Returning false leaves
    // it unacked so a TUI on the right session (or a later switch back) still
    // gets it.
    if (n.sessionId !== undefined && n.sessionId !== requestedSessionId) {
      return false;
    }
    if (n.type === "toast") {
      const p = n.payload;
      await refreshToastDurationMs();
      showToast(api, {
        message: String(p.message ?? ""),
        variant: p.variant ?? "info",
        durationOverrideMs: typeof p.duration === "number" && Number.isFinite(p.duration) ? p.duration : undefined
      });
      return true;
    }
    if (n.type !== "action") return false;
    const action = n.payload?.action;
    const stillActive = () => getRpcGeneration() === generation && getSessionId(api) === requestedSessionId;
    if (action === "show-status-dialog") {
      return stillActive() && (await showStatusDialog(api, requestedSessionId));
    }
    if (action === "show-recomp-dialog") {
      return stillActive() && (await showRecompDialog(api, requestedSessionId));
    }
    if (action === "show-embed-dialog") {
      return stillActive() && (await showEmbedDialog(api, requestedSessionId));
    }
    if (action === "refresh-sidebar") {
      if (!stillActive()) return false;
      refreshSidebarSnapshot();
      return true;
    }
    if (action === "wrapup-progress-kick") {
      // /ctx-wrapup blocks its command turn and fires no message events, so
      // the sidebar poll would never notice the run. Kick the fast progress
      // poll (same loop the recomp dialog kicks). The start toast arrives
      // separately via the ignored-message notification path.
      if (!stillActive()) return false;
      kickRecompProgressRefresh();
      return true;
    }
    if (action === "show-flush-dialog") {
      const flushMsg = String(n.payload?.message ?? "Flushed.");
      return stillActive() && showResultDialog(api, "Flush", flushMsg);
    }
    if (action === "show-result-dialog") {
      const title = String(n.payload?.title ?? "Magic Context");
      const body = String(n.payload?.message ?? "");
      return stillActive() && showResultDialog(api, title, body);
    }
    return false;
  };
  startNotificationSocket({
    getSessionId: () => getSessionId(api),
    // Follow the shown session's own server, whose commands push its dialogs.
    getSessionDirectory: () => {
      const sessionId = getSessionId(api);
      return sessionId ? sessionDirectory(api, sessionId) : null;
    },
    onNotification: handleNotification
  });

  // Clean up on dispose
  api.lifecycle.onDispose(() => {
    sidebarSlot.dispose();
    stopNotificationSocket();
    closeRpc();
  });

  // Show one-shot release announcement after conflict gate.
  // Fire-and-forget: if the server isn't ready or RPC fails, the next TUI
  // launch will retry. Dialog only appears once per ANNOUNCEMENT_VERSION
  // (persisted via mark-announced RPC writing last_announced_version).
  void showStartupAnnouncement(api);
};
const id = "opencode-magic-context";
export default {
  id,
  tui
};