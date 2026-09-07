import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "opentui:runtime-module:solid-js";
import packageJson from "../../../package.json";
import { badgeTextColor } from "../badge-contrast";
import { loadSidebarSnapshot } from "../data/context-db";
import { formatThresholdPercent } from "../../shared/format-threshold";
import { compactionOffSidebarRows, nativeCompactionContextLabel } from "../compaction-off";
import { computeEffectiveOrder, DEFAULT_SLOT_ORDER, PLUGIN_KEY, queueTuiPreferenceUpdate, readTuiPreferencesFile, readTuiPreferencesFileSync, resolveMagicContextPrefs, watchTuiPreferences } from "../../shared/tui-preferences";

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
const SINGLE_BORDER = {
  type: "single"
};
const REFRESH_DEBOUNCE_MS = 150;
// The TUI may unmount and remount sidebar_content when the user switches views
// (main -> subagent -> main). A remount re-runs the component body, so a signal
// created inside the component would reset to its seed. The controller lives in
// the slot-factory closure (plugin/process lifetime) and owns the durable
// prefs/collapse signals plus the single shared file watcher, so collapse state
// and live pref reloads survive remounts. No Solid effects/memos here — those
// need an owner; the poll-interval effect stays inside the component.
function createSidebarController(initialPrefs) {
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
function compactTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

/**
 * Sidebar form of the tail-hygiene reading: the reclaimable share and the
 * two masses it is computed from, in the same compact token unit as the
 * breakdown rows so the value fits beside its label at sidebar width. The
 * long, unit-spelled form stays in the status dialog.
 */
function hygieneValue(status) {
  return `${(status.severity * 100).toFixed(1)}% · ${compactTokens(status.u)}/${compactTokens(status.t)}`;
}
function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Text progress bar, e.g. [██████░░░░] for the recomp/upgrade live indicator.
function progressBar(fraction, width = 14) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

// Token breakdown segment colors (hardcoded hex values)
const COLORS = {
  // Cool / structured — injected by the plugin into message[0]
  system: "#c084fc",
  // Purple
  docs: "#22d3ee",
  // Cyan — <project-docs>
  compartments: "#60a5fa",
  // Blue
  facts: "#fbbf24",
  // Yellow/orange
  memories: "#34d399",
  // Green
  profile: "#a3e635",
  // Lime — <user-profile>
  // Warm / user-facing — regular chat and tool traffic. Grouped visually
  // by hue family so the user reads them as a related block.
  conversation: "#f87171",
  // Red
  toolCalls: "#fb923c",
  // Orange
  toolDefs: "#f472b6" // Pink
};
// Segmented token breakdown bar with legend
const TokenBreakdown = props => {
  // The bar is rendered as a flex row of colored boxes, each with
  // flexGrow=tokens and flexBasis=0. opentui distributes the parent
  // container's full width proportionally, so the bar always fills the
  // sidebar regardless of terminal size. No hardcoded width is needed —
  // this fixes both the over-wide bar that wrapped onto a second line on
  // narrow sidebars (issue #90) and the under-wide bar that left empty
  // space on the right on wide sidebars.
  const segments = createMemo(() => {
    const s = props.snapshot;
    const total = s.inputTokens || 1;
    const result = [];

    // System Prompt (purple)
    if (s.systemPromptTokens > 0) {
      result.push({
        key: "sys",
        tokens: s.systemPromptTokens,
        color: COLORS.system,
        label: "System"
      });
    }

    // Docs (cyan) — injected <project-docs> block (ARCHITECTURE/STRUCTURE)
    if (s.docsTokens > 0) {
      result.push({
        key: "docs",
        tokens: s.docsTokens,
        color: COLORS.docs,
        label: "Docs"
      });
    }

    // Compartments (blue)
    if (s.compartmentTokens > 0) {
      result.push({
        key: "comp",
        tokens: s.compartmentTokens,
        color: COLORS.compartments,
        label: "Compartments"
      });
    }

    // Facts (yellow/orange)
    if (s.factTokens > 0) {
      result.push({
        key: "fact",
        tokens: s.factTokens,
        color: COLORS.facts,
        label: "Facts"
      });
    }

    // Memories (green)
    if (s.memoryTokens > 0) {
      result.push({
        key: "mem",
        tokens: s.memoryTokens,
        color: COLORS.memories,
        label: "Memories"
      });
    }

    // User Profile (lime) — injected <user-profile> block (promoted user memories)
    if (s.profileTokens > 0) {
      result.push({
        key: "profile",
        tokens: s.profileTokens,
        color: COLORS.profile,
        label: "User Profile"
      });
    }

    // Conversation = real user/assistant text/reasoning/images
    // (excludes injected session-history and excludes tool call I/O).
    //
    // Always show this row even when conversationTokens === 0. The
    // calibrator's residual-distribution math (tokenizer-calibration.ts)
    // can round it down to zero when toolCallsLocal massively dominates
    // conversationLocal — that's a calibration artifact, not a real
    // "zero conversation". Suppressing the row leaves the legend looking
    // truncated, which is more confusing than showing a 0% line. The
    // segment is also skipped in the bar at 0 width because the segment
    // builder uses `Math.max(1, ...)` only when tokens > 0 (see
    // segmentWidths), so the visual bar stays correct either way.
    result.push({
      key: "conv",
      tokens: s.conversationTokens,
      color: COLORS.conversation,
      label: "Conversation"
    });

    // Tool Calls = tool_use/tool_result/tool/tool-invocation parts in messages
    // (actionable — users can reduce via ctx_reduce)
    if (s.toolCallTokens > 0) {
      result.push({
        key: "tool-calls",
        tokens: s.toolCallTokens,
        color: COLORS.toolCalls,
        label: "Tool Calls"
      });
    }

    // Tool Definitions = measured description + JSON-schema parameters for
    // each tool OpenCode sends in the `tools` request parameter, populated
    // by the `tool.definition` plugin hook keyed by {provider, model, agent}.
    // Zero until the first turn measures the active agent's tool set.
    if (s.toolDefinitionTokens > 0) {
      result.push({
        key: "tool-defs",
        tokens: s.toolDefinitionTokens,
        color: COLORS.toolDefs,
        label: "Tool Defs"
      });
    }
    return result;
  });
  const totalTokens = createMemo(() => props.snapshot.inputTokens || 1);

  // Render-time segments for the bar. Zero-token segments are filtered out
  // entirely (no flex weight, no rendered box) so they don't claim any
  // width. Non-zero segments still get a Math.max(1, ...) floor on
  // flexGrow so very small contributions remain visible as a thin sliver.
  // The legend rows below show every segment (including zeros) for table
  // stability — only the bar prunes them.
  const barSegments = createMemo(() => segments().filter(seg => seg.tokens > 0));
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$2, "width", "100%");
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "height", 1);
    _$insert(_el$2, () => barSegments().map(seg => (() => {
      var _el$3 = _$createElement("box");
      _$setProp(_el$3, "flexBasis", 0);
      _$setProp(_el$3, "height", 1);
      _$effect(_p$ => {
        var _v$ = seg.key,
          _v$2 = Math.max(1, seg.tokens),
          _v$3 = seg.color;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "key", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "flexGrow", _v$2, _p$.t));
        _v$3 !== _p$.a && (_p$.a = _$setProp(_el$3, "backgroundColor", _v$3, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$3;
    })()));
    _$insert(_el$, (() => {
      var _c$ = _$memo(() => !!!props.collapsed);
      return () => _c$() && (() => {
        var _el$4 = _$createElement("box");
        _$setProp(_el$4, "flexDirection", "column");
        _$setProp(_el$4, "marginTop", 0);
        _$insert(_el$4, () => segments().map(seg => {
          const pct = (seg.tokens / totalTokens() * 100).toFixed(0);
          return (() => {
            var _el$5 = _$createElement("box"),
              _el$6 = _$createElement("text"),
              _el$7 = _$createElement("text"),
              _el$8 = _$createTextNode(` (`),
              _el$9 = _$createTextNode(`%)`);
            _$insertNode(_el$5, _el$6);
            _$insertNode(_el$5, _el$7);
            _$setProp(_el$5, "width", "100%");
            _$setProp(_el$5, "flexDirection", "row");
            _$setProp(_el$5, "justifyContent", "space-between");
            _$insert(_el$6, () => seg.label);
            _$insertNode(_el$7, _el$8);
            _$insertNode(_el$7, _el$9);
            _$insert(_el$7, () => compactTokens(seg.tokens), _el$8);
            _$insert(_el$7, pct, _el$9);
            _$effect(_p$ => {
              var _v$4 = seg.key,
                _v$5 = seg.color,
                _v$6 = props.theme.textMuted;
              _v$4 !== _p$.e && (_p$.e = _$setProp(_el$5, "key", _v$4, _p$.e));
              _v$5 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$5, _p$.t));
              _v$6 !== _p$.a && (_p$.a = _$setProp(_el$7, "fg", _v$6, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$5;
          })();
        }));
        return _el$4;
      })();
    })(), null);
    return _el$;
  })();
};
const StatRow = props => {
  const fg = createMemo(() => {
    if (props.warning) return props.theme.warning;
    if (props.accent) return props.theme.accent;
    if (props.dim) return props.theme.textMuted;
    return props.theme.text;
  });
  return (() => {
    var _el$0 = _$createElement("box"),
      _el$1 = _$createElement("text"),
      _el$10 = _$createElement("text"),
      _el$11 = _$createElement("b");
    _$insertNode(_el$0, _el$1);
    _$insertNode(_el$0, _el$10);
    _$setProp(_el$0, "width", "100%");
    _$setProp(_el$0, "flexDirection", "row");
    _$setProp(_el$0, "justifyContent", "space-between");
    _$insert(_el$1, () => props.label);
    _$insertNode(_el$10, _el$11);
    _$insert(_el$11, () => props.value);
    _$effect(_p$ => {
      var _v$7 = props.theme.textMuted,
        _v$8 = fg();
      _v$7 !== _p$.e && (_p$.e = _$setProp(_el$1, "fg", _v$7, _p$.e));
      _v$8 !== _p$.t && (_p$.t = _$setProp(_el$10, "fg", _v$8, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$0;
  })();
};
const SectionHeader = props => (() => {
  var _el$12 = _$createElement("box"),
    _el$13 = _$createElement("text"),
    _el$14 = _$createElement("b");
  _$insertNode(_el$12, _el$13);
  _$setProp(_el$12, "width", "100%");
  _$setProp(_el$12, "marginTop", 1);
  _$insertNode(_el$13, _el$14);
  _$insert(_el$14, () => props.title);
  _$effect(_$p => _$setProp(_el$13, "fg", props.theme.text, _$p));
  return _el$12;
})();

// Live recomp / session-upgrade progress. Renders while an upgrade runs (and
// briefly after it finishes) so a multi-minute rebuild is visible instead of a
// single missed toast (dogfood 2026-05-30).
const RecompProgressSection = props => {
  // CRITICAL: read `props.progress` reactively on every access — do NOT
  // destructure it into a local `const p = props.progress` at creation time.
  // The parent keeps THIS component instance mounted as the phase advances
  // (recomp → migration → done), so a frozen `p` would render the
  // creation-time phase forever — the sidebar stuck on "upgrading / Running
  // historian (pass 1)…" even though the upgrade finished. Each accessor below
  // tracks the parent signal so the label/bar/note update live (root cause of
  // the dogfood 2026-05-30 "recomp upgrading stays" freeze).
  const phase = () => props.progress.phase;
  const fraction = () => props.progress.totalMessages > 0 ? props.progress.processedMessages / props.progress.totalMessages : 0;
  const pct = () => Math.round(fraction() * 100);

  // "Recomp" vs "Upgrade" vs "Embed" wording follows the flow that started this
  // run, so a plain /ctx-recomp never renders as an "Upgrade" (dogfood 2026-06-04).
  const verb = () => props.progress.kind === "upgrade" ? "Upgrade" : props.progress.kind === "embed" ? "Embed" : props.progress.kind === "wrapup" ? "Wrapup" : "Recomp";
  const activeText = () => props.progress.kind === "upgrade" ? "upgrading ⟳" : props.progress.kind === "embed" ? "embedding ⟳" : props.progress.kind === "wrapup" ? "wrapping ⟳" : "comparting ⟳";
  const label = createMemo(() => {
    switch (props.progress.phase) {
      case "recomp":
        return {
          text: activeText(),
          color: props.theme.warning
        };
      case "migration":
        return {
          text: "Migrating memories ⟳",
          color: props.theme.warning
        };
      case "done":
        return {
          text: `✓ ${verb()} complete`,
          color: props.theme.success ?? props.theme.accent
        };
      case "skipped":
        // Neutral terse status next to the bold verb header; the full,
        // self-contained reason (lease-busy "try again shortly" vs a
        // partial-stall "run /ctx-embed start again") renders on its own
        // line below. Don't re-prepend verb here (it's already the bold
        // header — doing so read as "EmbedEmbed"), and don't hardcode
        // "retry shortly" (wrong for a partial stall).
        return {
          text: "stopped",
          color: props.theme.textMuted
        };
      case "failed":
        return {
          text: `✗ ${verb()} failed`,
          color: props.theme.error
        };
    }
  });
  return [(() => {
    var _el$15 = _$createElement("box"),
      _el$16 = _$createElement("text"),
      _el$17 = _$createElement("b"),
      _el$18 = _$createElement("text");
    _$insertNode(_el$15, _el$16);
    _$insertNode(_el$15, _el$18);
    _$setProp(_el$15, "width", "100%");
    _$setProp(_el$15, "marginTop", 1);
    _$setProp(_el$15, "flexDirection", "row");
    _$setProp(_el$15, "justifyContent", "space-between");
    _$insertNode(_el$16, _el$17);
    _$insert(_el$17, verb);
    _$insert(_el$18, () => label().text);
    _$effect(_p$ => {
      var _v$9 = props.theme.text,
        _v$0 = label().color;
      _v$9 !== _p$.e && (_p$.e = _$setProp(_el$16, "fg", _v$9, _p$.e));
      _v$0 !== _p$.t && (_p$.t = _$setProp(_el$18, "fg", _v$0, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$15;
  })(), _$memo(() => _$memo(() => !!(phase() === "recomp" && props.progress.totalMessages > 0))() && (() => {
    var _el$19 = _$createElement("box"),
      _el$20 = _$createElement("text"),
      _el$21 = _$createElement("text"),
      _el$22 = _$createTextNode(`%`);
    _$insertNode(_el$19, _el$20);
    _$insertNode(_el$19, _el$21);
    _$setProp(_el$19, "width", "100%");
    _$setProp(_el$19, "flexDirection", "row");
    _$setProp(_el$19, "justifyContent", "space-between");
    _$insert(_el$20, () => progressBar(fraction()));
    _$insertNode(_el$21, _el$22);
    _$insert(_el$21, pct, _el$22);
    _$effect(_p$ => {
      var _v$1 = props.theme.accent,
        _v$10 = props.theme.textMuted;
      _v$1 !== _p$.e && (_p$.e = _$setProp(_el$20, "fg", _v$1, _p$.e));
      _v$10 !== _p$.t && (_p$.t = _$setProp(_el$21, "fg", _v$10, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$19;
  })()), _$memo(() => _$memo(() => !!((phase() === "recomp" || phase() === "migration") && props.progress.note))() && (() => {
    var _el$23 = _$createElement("text");
    _$insert(_el$23, () => props.progress.note);
    _$effect(_$p => _$setProp(_el$23, "fg", props.theme.textMuted, _$p));
    return _el$23;
  })()), _$memo(() => _$memo(() => !!(phase() === "recomp" && props.progress.kind !== "embed"))() && _$createComponent(StatRow, {
    get theme() {
      return props.theme;
    },
    label: "Compartments",
    get value() {
      return `${props.progress.compartmentsCreated} (${props.progress.passCount} pass${props.progress.passCount === 1 ? "" : "es"})`;
    },
    dim: true
  })), _$memo(() => _$memo(() => !!(phase() === "recomp" && props.progress.kind === "embed"))() && _$createComponent(StatRow, {
    get theme() {
      return props.theme;
    },
    label: "Compartments",
    get value() {
      return `${props.progress.processedMessages}/${props.progress.totalMessages} embedded`;
    },
    dim: true
  })), _$memo(() => _$memo(() => !!((phase() === "failed" || phase() === "skipped") && props.progress.message))() && (() => {
    var _el$24 = _$createElement("text");
    _$insert(_el$24, () => props.progress.message);
    _$effect(_$p => _$setProp(_el$24, "fg", props.theme.textMuted, _$p));
    return _el$24;
  })())];
};
const SidebarContent = props => {
  const [snapshot, setSnapshot] = createSignal(null);
  // Collapse state + section visibility prefs live in the controller (plugin
  // closure), so they survive view-switch remounts and persist across restarts
  // via ~/.config/opencode/tui-preferences.jsonc. Read reactively.
  const collapsed = props.controller.collapsed;
  const sections = () => props.controller.prefs().sections;
  const headerLabel = () => props.controller.prefs().header.label;
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
    const directory = props.api.state.path.directory ?? "";
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
    const directory = props.api.state.path.directory ?? "";
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
  const s = createMemo(() => snapshot());
  const compactionOff = () => s()?.compaction_enabled === false;
  const contextSummaryColor = createMemo(() => {
    if (compactionOff()) return props.theme.accent;
    const usage = s()?.usagePercentage ?? 0;
    if (usage >= 80) return props.theme.error;
    if (usage >= 65) return props.theme.warning;
    return props.theme.accent;
  });
  return (() => {
    var _el$25 = _$createElement("box"),
      _el$26 = _$createElement("box"),
      _el$27 = _$createElement("box"),
      _el$28 = _$createElement("text"),
      _el$29 = _$createElement("b"),
      _el$30 = _$createElement("text"),
      _el$31 = _$createTextNode(`v`);
    _$insertNode(_el$25, _el$26);
    _$setProp(_el$25, "width", "100%");
    _$setProp(_el$25, "flexDirection", "column");
    _$setProp(_el$25, "border", SINGLE_BORDER);
    _$setProp(_el$25, "paddingTop", 1);
    _$setProp(_el$25, "paddingBottom", 1);
    _$setProp(_el$25, "paddingLeft", 1);
    _$setProp(_el$25, "paddingRight", 1);
    _$insertNode(_el$26, _el$27);
    _$insertNode(_el$26, _el$30);
    _$setProp(_el$26, "flexDirection", "row");
    _$setProp(_el$26, "justifyContent", "space-between");
    _$setProp(_el$26, "alignItems", "center");
    _$setProp(_el$26, "onMouseDown", () => props.controller.toggleCollapsed());
    _$insertNode(_el$27, _el$28);
    _$setProp(_el$27, "paddingLeft", 1);
    _$setProp(_el$27, "paddingRight", 1);
    _$insertNode(_el$28, _el$29);
    _$insert(_el$29, () => collapsed() ? "▶ " : "▼ ", null);
    _$insert(_el$29, headerLabel, null);
    _$insertNode(_el$30, _el$31);
    _$insert(_el$30, () => packageJson.version, null);
    _$insert(_el$25, (() => {
      var _c$2 = _$memo(() => !!s()?.lastTransformError);
      return () => _c$2() && (() => {
        var _el$32 = _$createElement("box"),
          _el$33 = _$createElement("text"),
          _el$34 = _$createTextNode(`⚠ `);
        _$insertNode(_el$32, _el$33);
        _$setProp(_el$32, "marginTop", 1);
        _$setProp(_el$32, "width", "100%");
        _$insertNode(_el$33, _el$34);
        _$insert(_el$33, () => s().lastTransformError, null);
        _$effect(_$p => _$setProp(_el$33, "fg", props.theme.error, _$p));
        return _el$32;
      })();
    })(), null);
    _$insert(_el$25, (() => {
      var _c$3 = _$memo(() => !!s()?.dreamerProgress);
      return () => _c$3() && (() => {
        var _el$35 = _$createElement("box"),
          _el$36 = _$createElement("text"),
          _el$37 = _$createTextNode(`Dreamer `),
          _el$38 = _$createTextNode(`: `),
          _el$39 = _$createTextNode(`/`),
          _el$40 = _$createTextNode(` processed`);
        _$insertNode(_el$35, _el$36);
        _$setProp(_el$35, "marginTop", 1);
        _$setProp(_el$35, "width", "100%");
        _$insertNode(_el$36, _el$37);
        _$insertNode(_el$36, _el$38);
        _$insertNode(_el$36, _el$39);
        _$insertNode(_el$36, _el$40);
        _$insert(_el$36, () => s().dreamerProgress.task, _el$38);
        _$insert(_el$36, () => s().dreamerProgress.processed, _el$39);
        _$insert(_el$36, () => s().dreamerProgress.total, _el$40);
        _$effect(_$p => _$setProp(_el$36, "fg", props.theme.warning, _$p));
        return _el$35;
      })();
    })(), null);
    _$insert(_el$25, (() => {
      var _c$4 = _$memo(() => !!(s() && s().inputTokens > 0));
      return () => _c$4() && (() => {
        var _el$41 = _$createElement("box");
        _$setProp(_el$41, "flexDirection", "column");
        _$insert(_el$41, (() => {
          var _c$7 = _$memo(() => (s()?.contextLimit ?? 0) > 0);
          return () => _c$7() && (() => {
            var _el$42 = _$createElement("box"),
              _el$43 = _$createElement("text"),
              _el$44 = _$createTextNode(` / `);
            _$insertNode(_el$42, _el$43);
            _$setProp(_el$42, "width", "100%");
            _$setProp(_el$42, "flexDirection", "row");
            _$setProp(_el$42, "justifyContent", "space-between");
            _$insert(_el$42, (() => {
              var _c$9 = _$memo(() => !!compactionOff());
              return () => _c$9() ? (() => {
                var _el$45 = _$createElement("text"),
                  _el$46 = _$createElement("b");
                _$insertNode(_el$45, _el$46);
                _$insert(_el$46, () => nativeCompactionContextLabel(s()));
                _$effect(_$p => _$setProp(_el$45, "fg", contextSummaryColor(), _$p));
                return _el$45;
              })() : (() => {
                var _el$47 = _$createElement("text"),
                  _el$48 = _$createElement("b"),
                  _el$49 = _$createTextNode(`%`),
                  _el$50 = _$createTextNode(` / `),
                  _el$51 = _$createTextNode(`%`);
                _$insertNode(_el$47, _el$48);
                _$insertNode(_el$47, _el$50);
                _$insertNode(_el$47, _el$51);
                _$insertNode(_el$48, _el$49);
                _$insert(_el$48, () => s().usagePercentage.toFixed(1), _el$49);
                _$insert(_el$47, () => formatThresholdPercent(s().executeThreshold), _el$51);
                _$insert(_el$47, () => s().executeThresholdClamped ? "*" : "", null);
                _$effect(_$p => _$setProp(_el$47, "fg", contextSummaryColor(), _$p));
                return _el$47;
              })();
            })(), _el$43);
            _$insertNode(_el$43, _el$44);
            _$insert(_el$43, () => compactTokens(s().inputTokens), _el$44);
            _$insert(_el$43, () => compactTokens(s().contextLimit), null);
            _$effect(_$p => _$setProp(_el$43, "fg", contextSummaryColor(), _$p));
            return _el$42;
          })();
        })(), null);
        _$insert(_el$41, _$createComponent(TokenBreakdown, {
          get theme() {
            return props.theme;
          },
          get snapshot() {
            return s();
          },
          get collapsed() {
            return collapsed();
          }
        }), null);
        _$insert(_el$41, (() => {
          var _c$8 = _$memo(() => s().tailHygiene !== undefined);
          return () => _c$8() && _$createComponent(StatRow, {
            get theme() {
              return props.theme;
            },
            label: "Hygiene",
            get value() {
              return hygieneValue(s().tailHygiene);
            },
            get warning() {
              return !s().tailHygiene.evaluable;
            }
          });
        })(), null);
        _$effect(_$p => _$setProp(_el$41, "marginTop", collapsed() ? 0 : 1, _$p));
        return _el$41;
      })();
    })(), null);
    _$insert(_el$25, (() => {
      var _c$5 = _$memo(() => !!collapsed());
      return () => _c$5() && (() => {
        var _el$52 = _$createElement("box");
        _$setProp(_el$52, "width", "100%");
        _$setProp(_el$52, "flexDirection", "column");
        _$insert(_el$52, (() => {
          var _c$0 = _$memo(() => !!compactionOff());
          return () => _c$0() ? compactionOffSidebarRows(s()).map(row => _$createComponent(StatRow, {
            get theme() {
              return props.theme;
            },
            get label() {
              return row.label;
            },
            get value() {
              return row.value;
            },
            get accent() {
              return row.label === "Memories";
            },
            get dim() {
              return row.label !== "Memories";
            }
          })) : [(() => {
            var _el$53 = _$createElement("box"),
              _el$54 = _$createElement("text");
            _$insertNode(_el$53, _el$54);
            _$setProp(_el$53, "width", "100%");
            _$setProp(_el$53, "flexDirection", "row");
            _$setProp(_el$53, "justifyContent", "space-between");
            _$insertNode(_el$54, _$createTextNode(`Historian`));
            _$insert(_el$53, (() => {
              var _c$1 = _$memo(() => !!s()?.historianRunning);
              return () => _c$1() ? (() => {
                var _el$67 = _$createElement("text");
                _$insertNode(_el$67, _$createTextNode(`comparting ⟳`));
                _$effect(_$p => _$setProp(_el$67, "fg", props.theme.warning, _$p));
                return _el$67;
              })() : (() => {
                var _el$69 = _$createElement("text");
                _$insertNode(_el$69, _$createTextNode(`idle`));
                _$effect(_$p => _$setProp(_el$69, "fg", props.theme.textMuted, _$p));
                return _el$69;
              })();
            })(), null);
            _$effect(_$p => _$setProp(_el$54, "fg", props.theme.textMuted, _$p));
            return _el$53;
          })(), _$createComponent(Show, {
            get when() {
              return s()?.dreamerProgress;
            },
            children: progress => (() => {
              var _el$71 = _$createElement("box"),
                _el$72 = _$createElement("text"),
                _el$74 = _$createElement("text"),
                _el$75 = _$createTextNode(` `),
                _el$76 = _$createTextNode(`/`);
              _$insertNode(_el$71, _el$72);
              _$insertNode(_el$71, _el$74);
              _$setProp(_el$71, "width", "100%");
              _$setProp(_el$71, "flexDirection", "row");
              _$setProp(_el$71, "justifyContent", "space-between");
              _$insertNode(_el$72, _$createTextNode(`Dreamer`));
              _$insertNode(_el$74, _el$75);
              _$insertNode(_el$74, _el$76);
              _$insert(_el$74, () => progress().task, _el$75);
              _$insert(_el$74, () => progress().processed, _el$76);
              _$insert(_el$74, () => progress().total, null);
              _$effect(_p$ => {
                var _v$19 = props.theme.textMuted,
                  _v$20 = props.theme.warning;
                _v$19 !== _p$.e && (_p$.e = _$setProp(_el$72, "fg", _v$19, _p$.e));
                _v$20 !== _p$.t && (_p$.t = _$setProp(_el$74, "fg", _v$20, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$71;
            })()
          }), (() => {
            var _el$56 = _$createElement("box"),
              _el$57 = _$createElement("text"),
              _el$59 = _$createElement("text");
            _$insertNode(_el$56, _el$57);
            _$insertNode(_el$56, _el$59);
            _$setProp(_el$56, "width", "100%");
            _$setProp(_el$56, "flexDirection", "row");
            _$setProp(_el$56, "justifyContent", "space-between");
            _$insertNode(_el$57, _$createTextNode(`Memories`));
            _$insert(_el$59, (() => {
              var _c$10 = _$memo(() => (s()?.memoryBlockCount ?? 0) > 0);
              return () => _c$10() ? `${s().memoryBlockCount}/${s()?.memoryCount ?? 0}` : String(s()?.memoryCount ?? 0);
            })());
            _$effect(_p$ => {
              var _v$15 = props.theme.textMuted,
                _v$16 = props.theme.textMuted;
              _v$15 !== _p$.e && (_p$.e = _$setProp(_el$57, "fg", _v$15, _p$.e));
              _v$16 !== _p$.t && (_p$.t = _$setProp(_el$59, "fg", _v$16, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$56;
          })(), (() => {
            var _el$60 = _$createElement("box"),
              _el$61 = _$createElement("text"),
              _el$63 = _$createElement("text"),
              _el$64 = _$createTextNode(`C:`),
              _el$65 = _$createTextNode(` Q:`),
              _el$66 = _$createTextNode(` N:`);
            _$insertNode(_el$60, _el$61);
            _$insertNode(_el$60, _el$63);
            _$setProp(_el$60, "width", "100%");
            _$setProp(_el$60, "flexDirection", "row");
            _$setProp(_el$60, "justifyContent", "space-between");
            _$insertNode(_el$61, _$createTextNode(`Status`));
            _$insertNode(_el$63, _el$64);
            _$insertNode(_el$63, _el$65);
            _$insertNode(_el$63, _el$66);
            _$insert(_el$63, () => s()?.compartmentCount ?? 0, _el$65);
            _$insert(_el$63, () => s()?.pendingOpsCount ?? 0, _el$66);
            _$insert(_el$63, () => s()?.sessionNoteCount ?? 0, null);
            _$effect(_p$ => {
              var _v$17 = props.theme.textMuted,
                _v$18 = props.theme.textMuted;
              _v$17 !== _p$.e && (_p$.e = _$setProp(_el$61, "fg", _v$17, _p$.e));
              _v$18 !== _p$.t && (_p$.t = _$setProp(_el$63, "fg", _v$18, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$60;
          })(), _$createComponent(Show, {
            get when() {
              return s()?.recompProgress;
            },
            children: progress => _$createComponent(RecompProgressSection, {
              get theme() {
                return props.theme;
              },
              get progress() {
                return progress();
              }
            })
          })];
        })());
        return _el$52;
      })();
    })(), null);
    _$insert(_el$25, (() => {
      var _c$6 = _$memo(() => !!!collapsed());
      return () => _c$6() && [_$memo(() => _$memo(() => !!(!compactionOff() && sections().historian))() && [(() => {
        var _el$77 = _$createElement("box"),
          _el$78 = _$createElement("text"),
          _el$79 = _$createElement("b");
        _$insertNode(_el$77, _el$78);
        _$setProp(_el$77, "width", "100%");
        _$setProp(_el$77, "marginTop", 1);
        _$setProp(_el$77, "flexDirection", "row");
        _$setProp(_el$77, "justifyContent", "space-between");
        _$insertNode(_el$78, _el$79);
        _$insertNode(_el$79, _$createTextNode(`Historian`));
        _$insert(_el$77, (() => {
          var _c$11 = _$memo(() => !!s()?.historianRunning);
          return () => _c$11() ? (() => {
            var _el$81 = _$createElement("text");
            _$insertNode(_el$81, _$createTextNode(`comparting ⟳`));
            _$effect(_$p => _$setProp(_el$81, "fg", props.theme.warning, _$p));
            return _el$81;
          })() : (() => {
            var _el$83 = _$createElement("text");
            _$insertNode(_el$83, _$createTextNode(`idle`));
            _$effect(_$p => _$setProp(_el$83, "fg", props.theme.textMuted, _$p));
            return _el$83;
          })();
        })(), null);
        _$effect(_$p => _$setProp(_el$78, "fg", props.theme.text, _$p));
        return _el$77;
      })(), _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Compartments",
        get value() {
          return String(s()?.compartmentCount ?? 0);
        }
      }), _$createComponent(Show, {
        get when() {
          return s()?.recompProgress;
        },
        children: progress => _$createComponent(RecompProgressSection, {
          get theme() {
            return props.theme;
          },
          get progress() {
            return progress();
          }
        })
      })]), _$memo(() => _$memo(() => !!sections().memory)() && [_$createComponent(SectionHeader, {
        get theme() {
          return props.theme;
        },
        title: "Memory"
      }), _$memo(() => _$memo(() => !!compactionOff())() ? compactionOffSidebarRows(s()).filter(row => row.label === "Memories").map(row => _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        get label() {
          return row.label;
        },
        get value() {
          return row.value;
        },
        accent: true
      })) : [_$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Memories",
        get value() {
          return String(s()?.memoryCount ?? 0);
        },
        accent: true
      }), _$memo(() => _$memo(() => (s()?.memoryBlockCount ?? 0) > 0)() && _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Injected",
        get value() {
          return String(s().memoryBlockCount);
        },
        dim: true
      }))])]), _$memo(() => _$memo(() => !!(sections().status && (compactionOff() || (s()?.pendingOpsCount ?? 0) > 0 || (s()?.sessionNoteCount ?? 0) > 0 || (s()?.readySmartNoteCount ?? 0) > 0)))() && [_$createComponent(SectionHeader, {
        get theme() {
          return props.theme;
        },
        title: "Status"
      }), _$memo(() => _$memo(() => !!compactionOff())() ? compactionOffSidebarRows(s()).filter(row => row.label !== "Memories").map(row => _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        get label() {
          return row.label;
        },
        get value() {
          return row.value;
        },
        dim: true
      })) : [_$memo(() => _$memo(() => (s()?.pendingOpsCount ?? 0) > 0)() && _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Queue",
        get value() {
          return `${s().pendingOpsCount} pending`;
        },
        warning: true
      })), _$memo(() => _$memo(() => (s()?.sessionNoteCount ?? 0) > 0)() && _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Notes",
        get value() {
          return String(s().sessionNoteCount);
        }
      })), _$memo(() => _$memo(() => (s()?.readySmartNoteCount ?? 0) > 0)() && _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Smart Notes",
        get value() {
          return `${s().readySmartNoteCount} ready`;
        },
        accent: true
      }))])]), _$memo(() => _$memo(() => !!(sections().dreamer && (s()?.lastDreamerRunAt || s()?.dreamerProgress)))() && [_$createComponent(SectionHeader, {
        get theme() {
          return props.theme;
        },
        title: "Dreamer"
      }), _$createComponent(Show, {
        get when() {
          return s()?.dreamerProgress;
        },
        children: progress => _$createComponent(StatRow, {
          get theme() {
            return props.theme;
          },
          label: "Current",
          get value() {
            return `${progress().task} ${progress().processed}/${progress().total}`;
          },
          warning: true
        })
      }), _$createComponent(Show, {
        get when() {
          return s()?.lastDreamerRunAt;
        },
        children: lastRunAt => _$createComponent(StatRow, {
          get theme() {
            return props.theme;
          },
          label: "Last run",
          get value() {
            return relativeTime(lastRunAt());
          },
          dim: true
        })
      }), _$createComponent(For, {
        get each() {
          return Object.entries(s()?.dreamerBacklog ?? {});
        },
        children: ([task, backlog]) => _$createComponent(StatRow, {
          get theme() {
            return props.theme;
          },
          label: task,
          get value() {
            return `${backlog.pending}/${backlog.total}`;
          },
          dim: true
        })
      })]), _$memo(() => _$memo(() => !!(sections().stats && s()?.totalInputTokens != null))() && [_$createComponent(SectionHeader, {
        get theme() {
          return props.theme;
        },
        title: "Stats"
      }), _$createComponent(StatRow, {
        get theme() {
          return props.theme;
        },
        label: "Total tokens",
        get value() {
          return compactTokens(s().totalInputTokens ?? 0);
        },
        dim: true
      })])];
    })(), null);
    _$effect(_p$ => {
      var _v$11 = props.theme.borderActive,
        _v$12 = props.theme.accent,
        _v$13 = badgeTextColor(props.theme.accent, props.theme.background),
        _v$14 = props.theme.textMuted;
      _v$11 !== _p$.e && (_p$.e = _$setProp(_el$25, "borderColor", _v$11, _p$.e));
      _v$12 !== _p$.t && (_p$.t = _$setProp(_el$27, "backgroundColor", _v$12, _p$.t));
      _v$13 !== _p$.a && (_p$.a = _$setProp(_el$28, "fg", _v$13, _p$.a));
      _v$14 !== _p$.o && (_p$.o = _$setProp(_el$30, "fg", _v$14, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$25;
  })();
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