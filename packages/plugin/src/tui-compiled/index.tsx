import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
// @ts-nocheck
import { createMemo } from "opentui:runtime-module:solid-js";
import { createSidebarContentSlot, kickRecompProgressRefresh, refreshSidebarSnapshot } from "./slots/sidebar-content";
import packageJson from "../../package.json";
import { closeRpc, dismissUpgradeReminder, getAnnouncement, getCompartmentCount, getRpcGeneration, initRpcClient, loadEmbedDetail, loadStatusDetail, loadToastDurationMs, markAnnounced, requestRecomp, requestUpgrade } from "./data/context-db";
import { startNotificationSocket, stopNotificationSocket } from "./data/notification-socket";
import { formatThresholdPercent } from "../shared/format-threshold";
import { compactionOffSidebarRows, nativeCompactionContextLabel } from "./compaction-off";
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
const R = props => (() => {
  var _el$ = _$createElement("box"),
    _el$2 = _$createElement("text"),
    _el$3 = _$createElement("text");
  _$insertNode(_el$, _el$2);
  _$insertNode(_el$, _el$3);
  _$setProp(_el$, "width", "100%");
  _$setProp(_el$, "flexDirection", "row");
  _$setProp(_el$, "justifyContent", "space-between");
  _$insert(_el$2, () => props.l);
  _$insert(_el$3, () => props.v);
  _$effect(_p$ => {
    var _v$ = props.t.textMuted,
      _v$2 = props.fg ?? props.t.text;
    _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
    _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
    return _p$;
  }, {
    e: undefined,
    t: undefined
  });
  return _el$;
})();
const StatusDialog = props => {
  const theme = createMemo(() => props.api.theme.current);
  const t = () => theme();
  const s = () => props.s;
  const compactionOff = () => s().compaction_enabled === false;

  // Prefer the RPC-provided model context limit (what the sidebar shows) so the
  // two surfaces never disagree. Fall back to deriving from usage% only when the
  // RPC limit is absent (0) — and that derivation is itself undefined at 0%, so
  // it stays "?" rather than showing a number inconsistent with the sidebar.
  const contextLimit = () => s().contextLimit > 0 ? s().contextLimit : s().usagePercentage > 0 ? Math.round(s().inputTokens / (s().usagePercentage / 100)) : 0;
  const elapsed = () => s().lastResponseTime > 0 ? Date.now() - s().lastResponseTime : 0;

  // Token breakdown segments — same colors as sidebar. Kept in sync with
  // slots/sidebar-content.tsx so the status dialog and sidebar read identically.
  const COLORS = {
    // Cool / structured — injected by the plugin into message[0]
    system: "#c084fc",
    docs: "#22d3ee",
    compartments: "#60a5fa",
    facts: "#fbbf24",
    memories: "#34d399",
    profile: "#a3e635",
    // Warm / user-facing — chat and tool traffic
    conversation: "#f87171",
    toolCalls: "#fb923c",
    toolDefs: "#f472b6"
  };
  const breakdownSegments = () => {
    const d = s();
    const total = d.inputTokens || 1;
    const segs = [];
    if (d.systemPromptTokens > 0) segs.push({
      label: "System",
      tokens: d.systemPromptTokens,
      color: COLORS.system
    });
    if (d.docsTokens > 0) segs.push({
      label: "Docs",
      tokens: d.docsTokens,
      color: COLORS.docs
    });
    if (!compactionOff() && d.compartmentTokens > 0) segs.push({
      label: "Compartments",
      tokens: d.compartmentTokens,
      color: COLORS.compartments,
      detail: `(${d.compartmentCount})`
    });
    if (d.factTokens > 0) segs.push({
      label: "Facts",
      tokens: d.factTokens,
      color: COLORS.facts
    });
    if (d.memoryTokens > 0) segs.push({
      label: "Memories",
      tokens: d.memoryTokens,
      color: COLORS.memories,
      detail: `(${d.memoryBlockCount})`
    });
    if (d.profileTokens > 0) segs.push({
      label: "User Profile",
      tokens: d.profileTokens,
      color: COLORS.profile
    });
    if (d.conversationTokens > 0) segs.push({
      label: "Conversation",
      tokens: d.conversationTokens,
      color: COLORS.conversation
    });
    if (d.toolCallTokens > 0) segs.push({
      label: "Tool Calls",
      tokens: d.toolCallTokens,
      color: COLORS.toolCalls
    });
    if (d.toolDefinitionTokens > 0) segs.push({
      label: "Tool Defs",
      tokens: d.toolDefinitionTokens,
      color: COLORS.toolDefs
    });
    return {
      segs,
      total
    };
  };

  // The status-dialog breakdown bar uses flex layout (same approach as the
  // sidebar breakdown). Each segment becomes a colored box with
  // flexGrow=tokens and flexBasis=0, parent has width="100%", so opentui
  // distributes the dialog's full width proportionally regardless of the
  // dialog's actual rendered width.
  const barSegments = () => breakdownSegments().segs.filter(seg => seg.tokens > 0);
  return (() => {
    var _el$4 = _$createElement("box"),
      _el$5 = _$createElement("box"),
      _el$6 = _$createElement("text"),
      _el$7 = _$createElement("b"),
      _el$9 = _$createElement("text"),
      _el$0 = _$createTextNode(`v`),
      _el$1 = _$createElement("box"),
      _el$10 = _$createElement("text"),
      _el$11 = _$createTextNode(` / `),
      _el$12 = _$createTextNode(` tokens`),
      _el$13 = _$createElement("box"),
      _el$14 = _$createElement("box"),
      _el$15 = _$createElement("box"),
      _el$16 = _$createElement("box"),
      _el$17 = _$createElement("text"),
      _el$18 = _$createElement("b"),
      _el$20 = _$createElement("box"),
      _el$21 = _$createElement("text");
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$1);
    _$insertNode(_el$4, _el$13);
    _$insertNode(_el$4, _el$14);
    _$insertNode(_el$4, _el$15);
    _$insertNode(_el$4, _el$16);
    _$insertNode(_el$4, _el$20);
    _$setProp(_el$4, "flexDirection", "column");
    _$setProp(_el$4, "width", "100%");
    _$setProp(_el$4, "paddingLeft", 2);
    _$setProp(_el$4, "paddingRight", 2);
    _$setProp(_el$4, "paddingTop", 1);
    _$setProp(_el$4, "paddingBottom", 1);
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$5, _el$9);
    _$setProp(_el$5, "justifyContent", "center");
    _$setProp(_el$5, "width", "100%");
    _$setProp(_el$5, "marginBottom", 1);
    _$setProp(_el$5, "flexDirection", "row");
    _$setProp(_el$5, "gap", 2);
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$7, _$createTextNode(`⚡ Magic Context Status`));
    _$insertNode(_el$9, _el$0);
    _$insert(_el$9, () => packageJson.version, null);
    _$insertNode(_el$1, _el$10);
    _$setProp(_el$1, "flexDirection", "row");
    _$setProp(_el$1, "justifyContent", "space-between");
    _$setProp(_el$1, "width", "100%");
    _$insert(_el$1, (() => {
      var _c$ = _$memo(() => !!compactionOff());
      return () => _c$() ? (() => {
        var _el$23 = _$createElement("text"),
          _el$24 = _$createElement("b");
        _$insertNode(_el$23, _el$24);
        _$insert(_el$24, () => nativeCompactionContextLabel(s()));
        _$effect(_$p => _$setProp(_el$23, "fg", t().accent, _$p));
        return _el$23;
      })() : (() => {
        var _el$25 = _$createElement("text"),
          _el$26 = _$createElement("b"),
          _el$27 = _$createTextNode(`%`),
          _el$28 = _$createTextNode(` / `),
          _el$29 = _$createTextNode(`%`);
        _$insertNode(_el$25, _el$26);
        _$insertNode(_el$25, _el$28);
        _$insertNode(_el$25, _el$29);
        _$insertNode(_el$26, _el$27);
        _$insert(_el$26, () => s().usagePercentage.toFixed(1), _el$27);
        _$insert(_el$25, () => formatThresholdPercent(s().executeThreshold), _el$29);
        _$insert(_el$25, () => s().executeThresholdClamped ? "*" : "", null);
        _$effect(_$p => _$setProp(_el$25, "fg", s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent, _$p));
        return _el$25;
      })();
    })(), _el$10);
    _$insertNode(_el$10, _el$11);
    _$insertNode(_el$10, _el$12);
    _$insert(_el$10, () => fmt(s().inputTokens), _el$11);
    _$insert(_el$10, (() => {
      var _c$2 = _$memo(() => contextLimit() > 0);
      return () => _c$2() ? fmt(contextLimit()) : "?";
    })(), _el$12);
    _$setProp(_el$13, "width", "100%");
    _$setProp(_el$13, "flexDirection", "row");
    _$setProp(_el$13, "height", 1);
    _$insert(_el$13, () => barSegments().map(seg => (() => {
      var _el$30 = _$createElement("box");
      _$setProp(_el$30, "flexBasis", 0);
      _$setProp(_el$30, "height", 1);
      _$effect(_p$ => {
        var _v$8 = seg.label,
          _v$9 = Math.max(1, seg.tokens),
          _v$0 = seg.color;
        _v$8 !== _p$.e && (_p$.e = _$setProp(_el$30, "key", _v$8, _p$.e));
        _v$9 !== _p$.t && (_p$.t = _$setProp(_el$30, "flexGrow", _v$9, _p$.t));
        _v$0 !== _p$.a && (_p$.a = _$setProp(_el$30, "backgroundColor", _v$0, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$30;
    })()));
    _$setProp(_el$14, "flexDirection", "column");
    _$insert(_el$14, () => breakdownSegments().segs.map(seg => {
      const pct = (seg.tokens / breakdownSegments().total * 100).toFixed(1);
      return (() => {
        var _el$31 = _$createElement("box"),
          _el$32 = _$createElement("text"),
          _el$33 = _$createTextNode(` `),
          _el$34 = _$createElement("text"),
          _el$35 = _$createTextNode(` (`),
          _el$36 = _$createTextNode(`%)`);
        _$insertNode(_el$31, _el$32);
        _$insertNode(_el$31, _el$34);
        _$setProp(_el$31, "width", "100%");
        _$setProp(_el$31, "flexDirection", "row");
        _$setProp(_el$31, "justifyContent", "space-between");
        _$insertNode(_el$32, _el$33);
        _$insert(_el$32, () => seg.label, _el$33);
        _$insert(_el$32, () => seg.detail ?? "", null);
        _$insertNode(_el$34, _el$35);
        _$insertNode(_el$34, _el$36);
        _$insert(_el$34, () => fmt(seg.tokens), _el$35);
        _$insert(_el$34, pct, _el$36);
        _$effect(_p$ => {
          var _v$1 = seg.label,
            _v$10 = seg.color,
            _v$11 = t().textMuted;
          _v$1 !== _p$.e && (_p$.e = _$setProp(_el$31, "key", _v$1, _p$.e));
          _v$10 !== _p$.t && (_p$.t = _$setProp(_el$32, "fg", _v$10, _p$.t));
          _v$11 !== _p$.a && (_p$.a = _$setProp(_el$34, "fg", _v$11, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$31;
      })();
    }));
    _$insert(_el$4, (() => {
      var _c$3 = _$memo(() => !!(!compactionOff() && s().recompProgress));
      return () => _c$3() && (() => {
        const p = s().recompProgress;
        // Label follows the flow that started the run, so a plain
        // /ctx-recomp never reads as an "Upgrade" (dogfood 2026-06-04).
        const verb = p.kind === "upgrade" ? "Upgrade" : p.kind === "embed" ? "Embed" : "Recomp";
        return (() => {
          var _el$37 = _$createElement("box"),
            _el$38 = _$createElement("text"),
            _el$39 = _$createElement("b");
          _$insertNode(_el$37, _el$38);
          _$setProp(_el$37, "marginTop", 1);
          _$setProp(_el$37, "width", "100%");
          _$setProp(_el$37, "flexDirection", "column");
          _$insertNode(_el$38, _el$39);
          _$insert(_el$39, verb);
          _$insert(_el$37, () => {
            if (p.phase === "recomp") {
              const frac = p.totalMessages > 0 ? p.processedMessages / p.totalMessages : 0;
              const width = 24;
              const filled = Math.round(Math.max(0, Math.min(1, frac)) * width);
              const bar = p.totalMessages > 0 ? `[${"█".repeat(filled)}${"░".repeat(width - filled)}]` : "(starting…)";
              const activeLabel = p.kind === "upgrade" ? "upgrading" : p.kind === "embed" ? "embedding" : "comparting";
              return [_$createComponent(R, {
                get t() {
                  return t();
                },
                l: activeLabel,
                get v() {
                  return _$memo(() => p.totalMessages > 0)() ? `${bar} ${Math.round(frac * 100)}%` : bar;
                },
                get fg() {
                  return t().warning;
                }
              }), _$memo(() => _$memo(() => !!p.note)() ? _$createComponent(R, {
                get t() {
                  return t();
                },
                l: "Status",
                get v() {
                  return p.note;
                },
                get fg() {
                  return t().textMuted;
                }
              }) : null), _$memo(() => _$memo(() => p.kind === "embed")() ? _$createComponent(R, {
                get t() {
                  return t();
                },
                l: "Compartments",
                get v() {
                  return `${p.processedMessages}/${p.totalMessages} embedded`;
                },
                get fg() {
                  return t().textMuted;
                }
              }) : _$createComponent(R, {
                get t() {
                  return t();
                },
                l: "Compartments",
                get v() {
                  return `${p.compartmentsCreated} (${p.passCount} pass${p.passCount === 1 ? "" : "es"})`;
                },
                get fg() {
                  return t().textMuted;
                }
              }))];
            }
            if (p.phase === "migration") return _$createComponent(R, {
              get t() {
                return t();
              },
              l: "Status",
              get v() {
                return p.note ?? "Migrating memories ⟳";
              },
              get fg() {
                return t().warning;
              }
            });
            if (p.phase === "done") return _$createComponent(R, {
              get t() {
                return t();
              },
              l: "Status",
              v: `✓ ${verb} complete`,
              get fg() {
                return t().accent;
              }
            });
            if (p.phase === "skipped") return _$createComponent(R, {
              get t() {
                return t();
              },
              l: "Status",
              get v() {
                return p.message ?? `${verb} stopped early`;
              },
              get fg() {
                return t().textMuted;
              }
            });
            return _$createComponent(R, {
              get t() {
                return t();
              },
              l: "Status",
              get v() {
                return `✗ ${verb} failed${p.message ? `: ${p.message}` : ""}`;
              },
              get fg() {
                return t().error;
              }
            });
          }, null);
          _$effect(_$p => _$setProp(_el$38, "fg", t().text, _$p));
          return _el$37;
        })();
      })();
    })(), _el$15);
    _$setProp(_el$15, "flexDirection", "row");
    _$setProp(_el$15, "width", "100%");
    _$setProp(_el$15, "marginTop", 1);
    _$setProp(_el$15, "gap", 4);
    _$insert(_el$15, (() => {
      var _c$4 = _$memo(() => !!compactionOff());
      return () => _c$4() ? (() => {
        var _el$40 = _$createElement("box"),
          _el$41 = _$createElement("text"),
          _el$42 = _$createElement("b");
        _$insertNode(_el$40, _el$41);
        _$setProp(_el$40, "flexDirection", "column");
        _$setProp(_el$40, "flexGrow", 1);
        _$setProp(_el$40, "flexBasis", 0);
        _$insertNode(_el$41, _el$42);
        _$insertNode(_el$42, _$createTextNode(`Knowledge`));
        _$insert(_el$40, () => compactionOffSidebarRows(s()).map(row => _$createComponent(R, {
          get t() {
            return t();
          },
          get l() {
            return row.label;
          },
          get v() {
            return row.value;
          },
          get fg() {
            return _$memo(() => row.label === "Memories")() ? t().accent : t().textMuted;
          }
        })), null);
        _$insert(_el$40, (() => {
          var _c$8 = _$memo(() => s().readySmartNoteCount > 0);
          return () => _c$8() && _$createComponent(R, {
            get t() {
              return t();
            },
            l: "Smart Notes",
            get v() {
              return `${s().readySmartNoteCount} ready`;
            },
            get fg() {
              return t().accent;
            }
          });
        })(), null);
        _$insert(_el$40, (() => {
          var _c$9 = _$memo(() => !!s().lastDreamerRunAt);
          return () => _c$9() && _$createComponent(R, {
            get t() {
              return t();
            },
            l: "Dreamer",
            get v() {
              return `last ${relTime(s().lastDreamerRunAt)}`;
            },
            get fg() {
              return t().textMuted;
            }
          });
        })(), null);
        _$effect(_$p => _$setProp(_el$41, "fg", t().text, _$p));
        return _el$40;
      })() : [(() => {
        var _el$44 = _$createElement("box"),
          _el$45 = _$createElement("text"),
          _el$46 = _$createElement("b"),
          _el$48 = _$createElement("box"),
          _el$49 = _$createElement("text"),
          _el$50 = _$createElement("b"),
          _el$52 = _$createElement("box"),
          _el$53 = _$createElement("text"),
          _el$54 = _$createElement("b"),
          _el$56 = _$createElement("box"),
          _el$57 = _$createElement("text"),
          _el$58 = _$createElement("b");
        _$insertNode(_el$44, _el$45);
        _$insertNode(_el$44, _el$48);
        _$insertNode(_el$44, _el$52);
        _$insertNode(_el$44, _el$56);
        _$setProp(_el$44, "flexDirection", "column");
        _$setProp(_el$44, "flexGrow", 1);
        _$setProp(_el$44, "flexBasis", 0);
        _$insertNode(_el$45, _el$46);
        _$insertNode(_el$46, _$createTextNode(`Tags`));
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Active",
          get v() {
            return `${s().activeTags} (~${fmtBytes(s().activeBytes)})`;
          }
        }), _el$48);
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Dropped",
          get v() {
            return String(s().droppedTags);
          }
        }), _el$48);
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Total",
          get v() {
            return String(s().totalTags);
          },
          get fg() {
            return t().textMuted;
          }
        }), _el$48);
        _$insertNode(_el$48, _el$49);
        _$setProp(_el$48, "marginTop", 1);
        _$insertNode(_el$49, _el$50);
        _$insertNode(_el$50, _$createTextNode(`Pending Queue`));
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Drops",
          get v() {
            return String(s().pendingOpsCount);
          },
          get fg() {
            return _$memo(() => s().pendingOpsCount > 0)() ? t().warning : t().textMuted;
          }
        }), _el$52);
        _$insertNode(_el$52, _el$53);
        _$setProp(_el$52, "marginTop", 1);
        _$insertNode(_el$53, _el$54);
        _$insertNode(_el$54, _$createTextNode(`Cache TTL`));
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Configured",
          get v() {
            return s().cacheTtl;
          }
        }), _el$56);
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Last response",
          get v() {
            return _$memo(() => s().lastResponseTime > 0)() ? `${Math.round(elapsed() / 1000)}s ago` : "never";
          }
        }), _el$56);
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Remaining",
          get v() {
            return _$memo(() => !!s().cacheExpired)() ? "expired" : _$memo(() => !!s().cacheNeverExpires)() ? "never expires (always-warm lane)" : `${Math.round(s().cacheRemainingMs / 1000)}s`;
          },
          get fg() {
            return _$memo(() => !!s().cacheExpired)() ? t().warning : t().textMuted;
          }
        }), _el$56);
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Auto-execute",
          get v() {
            return _$memo(() => !!s().cacheExpired)() ? "yes (expired)" : _$memo(() => !!s().cacheNeverExpires)() ? `at ≥${formatThresholdPercent(s().executeThreshold)}%` : `at TTL or ≥${formatThresholdPercent(s().executeThreshold)}%`;
          },
          get fg() {
            return t().textMuted;
          }
        }), _el$56);
        _$insertNode(_el$56, _el$57);
        _$setProp(_el$56, "marginTop", 1);
        _$insertNode(_el$57, _el$58);
        _$insertNode(_el$58, _$createTextNode(`Memory`));
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Active",
          get v() {
            return String(s().memoryCount);
          },
          get fg() {
            return t().accent;
          }
        }), null);
        _$insert(_el$44, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Injected",
          get v() {
            return String(s().memoryBlockCount);
          },
          get fg() {
            return t().textMuted;
          }
        }), null);
        _$effect(_p$ => {
          var _v$12 = t().text,
            _v$13 = t().text,
            _v$14 = t().text,
            _v$15 = t().text;
          _v$12 !== _p$.e && (_p$.e = _$setProp(_el$45, "fg", _v$12, _p$.e));
          _v$13 !== _p$.t && (_p$.t = _$setProp(_el$49, "fg", _v$13, _p$.t));
          _v$14 !== _p$.a && (_p$.a = _$setProp(_el$53, "fg", _v$14, _p$.a));
          _v$15 !== _p$.o && (_p$.o = _$setProp(_el$57, "fg", _v$15, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$44;
      })(), (() => {
        var _el$60 = _$createElement("box"),
          _el$61 = _$createElement("text"),
          _el$62 = _$createElement("b"),
          _el$64 = _$createElement("box"),
          _el$65 = _$createElement("text"),
          _el$66 = _$createElement("b"),
          _el$68 = _$createElement("box"),
          _el$69 = _$createElement("text"),
          _el$70 = _$createElement("b");
        _$insertNode(_el$60, _el$61);
        _$insertNode(_el$60, _el$64);
        _$insertNode(_el$60, _el$68);
        _$setProp(_el$60, "flexDirection", "column");
        _$setProp(_el$60, "flexGrow", 1);
        _$setProp(_el$60, "flexBasis", 0);
        _$insertNode(_el$61, _el$62);
        _$insertNode(_el$62, _$createTextNode(`Reductions`));
        _$insert(_el$60, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Execute threshold",
          get v() {
            return `${formatThresholdPercent(s().executeThreshold)}%${s().executeThresholdClamped ? "*" : ""}`;
          }
        }), _el$64);
        _$insert(_el$60, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Last reduce anchor",
          get v() {
            return `${fmt(s().lastNudgeTokens)} tok`;
          }
        }), _el$64);
        _$insertNode(_el$64, _el$65);
        _$setProp(_el$64, "marginTop", 1);
        _$insertNode(_el$65, _el$66);
        _$insertNode(_el$66, _$createTextNode(`Context Details`));
        _$insert(_el$60, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Protected tags",
          get v() {
            return String(s().protectedTagCount);
          },
          get fg() {
            return t().textMuted;
          }
        }), _el$68);
        _$insert(_el$60, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "Subagent",
          get v() {
            return s().isSubagent ? "yes" : "no";
          },
          get fg() {
            return t().textMuted;
          }
        }), _el$68);
        _$insertNode(_el$68, _el$69);
        _$setProp(_el$68, "marginTop", 1);
        _$insertNode(_el$69, _el$70);
        _$insertNode(_el$70, _$createTextNode(`History Compression`));
        _$insert(_el$60, (() => {
          var _c$0 = _$memo(() => typeof s().boundaryPresent === "boolean");
          return () => _c$0() && _$createComponent(R, {
            get t() {
              return t();
            },
            l: "Boundary",
            get v() {
              return s().boundaryPresent ? "present" : "absent";
            }
          });
        })(), null);
        _$insert(_el$60, (() => {
          var _c$1 = _$memo(() => s().coverageOrdinal !== undefined);
          return () => _c$1() && _$createComponent(R, {
            get t() {
              return t();
            },
            l: "Coverage ordinal",
            get v() {
              return _$memo(() => s().coverageOrdinal == null)() ? "none" : String(s().coverageOrdinal);
            }
          });
        })(), null);
        _$insert(_el$60, (() => {
          var _c$10 = _$memo(() => typeof s().boundaryPresent === "boolean");
          return () => _c$10() && _$createComponent(R, {
            get t() {
              return t();
            },
            l: "Compartments",
            get v() {
              return String(s().compartmentCount);
            }
          });
        })(), null);
        _$insert(_el$60, _$createComponent(R, {
          get t() {
            return t();
          },
          l: "History block",
          get v() {
            return `~${fmt(s().historyBlockTokens)} tok`;
          }
        }), null);
        _$insert(_el$60, (() => {
          var _c$11 = _$memo(() => s().compressionBudget != null);
          return () => _c$11() && _$createComponent(R, {
            get t() {
              return t();
            },
            l: "Budget",
            get v() {
              return `~${fmt(s().compressionBudget)} tok (${s().compressionUsage} used)`;
            }
          });
        })(), null);
        _$insert(_el$60, (() => {
          var _c$12 = _$memo(() => !!s().lastDreamerRunAt);
          return () => _c$12() && _$createComponent(R, {
            get t() {
              return t();
            },
            l: "Dreamer",
            get v() {
              return `last ${relTime(s().lastDreamerRunAt)}`;
            },
            get fg() {
              return t().textMuted;
            }
          });
        })(), null);
        _$insert(_el$60, (() => {
          var _c$13 = _$memo(() => !!s().skillMemory);
          return () => _c$13() && (() => {
            const sm = s().skillMemory;
            return (() => {
              var _el$72 = _$createElement("box"),
                _el$73 = _$createElement("box"),
                _el$74 = _$createElement("text"),
                _el$75 = _$createElement("b");
              _$insertNode(_el$72, _el$73);
              _$setProp(_el$72, "flexDirection", "column");
              _$insertNode(_el$73, _el$74);
              _$setProp(_el$73, "marginTop", 1);
              _$insertNode(_el$74, _el$75);
              _$insertNode(_el$75, _$createTextNode(`Skill Memory`));
              _$insert(_el$72, _$createComponent(R, {
                get t() {
                  return t();
                },
                l: "Notes",
                get v() {
                  return `${sm.totalNotes} (${sm.skillsWithNotes} ${sm.skillsWithNotes === 1 ? "skill" : "skills"})`;
                }
              }), null);
              _$insert(_el$72, _$createComponent(R, {
                get t() {
                  return t();
                },
                l: "Pinned",
                get v() {
                  return String(sm.pinnedNotes);
                },
                get fg() {
                  return t().textMuted;
                }
              }), null);
              _$effect(_$p => _$setProp(_el$74, "fg", t().text, _$p));
              return _el$72;
            })();
          })();
        })(), null);
        _$effect(_p$ => {
          var _v$16 = t().text,
            _v$17 = t().text,
            _v$18 = t().text;
          _v$16 !== _p$.e && (_p$.e = _$setProp(_el$61, "fg", _v$16, _p$.e));
          _v$17 !== _p$.t && (_p$.t = _$setProp(_el$65, "fg", _v$17, _p$.t));
          _v$18 !== _p$.a && (_p$.a = _$setProp(_el$69, "fg", _v$18, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$60;
      })()];
    })());
    _$insert(_el$4, (() => {
      var _c$5 = _$memo(() => !!s().lastTransformError);
      return () => _c$5() && (() => {
        var _el$77 = _$createElement("box"),
          _el$78 = _$createElement("text"),
          _el$79 = _$createTextNode(`⚠ `);
        _$insertNode(_el$77, _el$78);
        _$setProp(_el$77, "marginTop", 1);
        _$setProp(_el$77, "width", "100%");
        _$insertNode(_el$78, _el$79);
        _$insert(_el$78, () => s().lastTransformError, null);
        _$effect(_$p => _$setProp(_el$78, "fg", t().error, _$p));
        return _el$77;
      })();
    })(), _el$16);
    _$insertNode(_el$16, _el$17);
    _$setProp(_el$16, "marginTop", 1);
    _$setProp(_el$16, "width", "100%");
    _$insertNode(_el$17, _el$18);
    _$insertNode(_el$18, _$createTextNode(`Logger`));
    _$insert(_el$16, _$createComponent(R, {
      get t() {
        return t();
      },
      l: "Swallowed writes",
      get v() {
        return String(s().loggerDiagnostics?.swallowedWriteCount ?? 0);
      },
      get fg() {
        return _$memo(() => (s().loggerDiagnostics?.swallowedWriteCount ?? 0) > 0)() ? t().error : t().textMuted;
      }
    }), null);
    _$insert(_el$16, (() => {
      var _c$6 = _$memo(() => !!s().loggerDiagnostics?.lastErrorMessage);
      return () => _c$6() && _$createComponent(R, {
        get t() {
          return t();
        },
        l: "Last error",
        get v() {
          return s().loggerDiagnostics.lastErrorMessage;
        },
        get fg() {
          return t().error;
        }
      });
    })(), null);
    _$insert(_el$16, (() => {
      var _c$7 = _$memo(() => !!s().loggerDiagnostics?.lastErrorTime);
      return () => _c$7() && _$createComponent(R, {
        get t() {
          return t();
        },
        l: "Last error time",
        get v() {
          return s().loggerDiagnostics.lastErrorTime;
        },
        get fg() {
          return t().textMuted;
        }
      });
    })(), null);
    _$insertNode(_el$20, _el$21);
    _$setProp(_el$20, "marginTop", 1);
    _$setProp(_el$20, "justifyContent", "flex-end");
    _$setProp(_el$20, "width", "100%");
    _$insertNode(_el$21, _$createTextNode(`Esc to close`));
    _$effect(_p$ => {
      var _v$3 = t().accent,
        _v$4 = t().textMuted,
        _v$5 = compactionOff() ? t().accent : s().usagePercentage >= 80 ? t().error : s().usagePercentage >= 65 ? t().warning : t().accent,
        _v$6 = t().text,
        _v$7 = t().textMuted;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$6, "fg", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$9, "fg", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$10, "fg", _v$5, _p$.a));
      _v$6 !== _p$.o && (_p$.o = _$setProp(_el$17, "fg", _v$6, _p$.o));
      _v$7 !== _p$.i && (_p$.i = _$setProp(_el$21, "fg", _v$7, _p$.i));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined
    });
    return _el$4;
  })();
};
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
  const countResult = await getCompartmentCount(sessionId);
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
      return [count === 0 ? "This session has no compartments yet — recomp will build them from raw history." : `You have ${count} compartments.`, "", "Recomp will regenerate all compartments and facts from raw history.", "This may take a long time and consume significant tokens.", "", "Proceed?"].join("\n");
    },
    onConfirm: async () => {
      const requested = await requestRecomp(sessionId);
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
function showUpgradeDialog(api, resume, targetSessionId = getSessionId(api)) {
  const sessionId = targetSessionId;
  if (!sessionId) {
    // No active session — nothing to upgrade. Silently skip (the server only
    // enqueues this for sessions with legacy compartments, but the TUI may
    // have switched sessions before the poller fired).
    return false;
  }
  if (getSessionId(api) !== sessionId) return false;
  const title = resume ? "🎆 Resume the interrupted upgrade?" : "🎆 Historian V2 is released!";
  const message = resume ? [`An earlier upgrade to the new historian format was interrupted. ${resume.stagedCount} compartment${resume.stagedCount === 1 ? " was" : "s were"} already rebuilt (through message ${resume.stagedThrough}). Resuming continues from where it left off — nothing already rebuilt is reprocessed.`, "", "Resuming will:", "• Rebuild the remaining compartments into the new layered format", "• Re-organize this project's memories into the new taxonomy (once per project)", "", "The historian runs in the background and you can keep working. You can also resume via /ctx-session-upgrade later.", "", "Resume the upgrade now?"].join("\n") : ["This session's compartments are written by the old historian. The session is still usable with its old compartments, however it's strongly advised to upgrade them to the new format. This means every compartment needs to be reprocessed by the new historian, which might take a while depending on how big your session is.", "", "Running the upgrade will:", "• Rebuild this session's compartments into the new layered format", "• Re-organize this project's memories into the new taxonomy (once per project)", "", "The historian runs in the background and you can keep working while older compartments are reprocessed. You can also upgrade via /ctx-session-upgrade later.", "", "Run the upgrade now?"].join("\n");
  api.ui.dialog.replace(() => _$createComponent(api.ui.DialogConfirm, {
    title: title,
    message: message,
    onConfirm: async () => {
      const started = await requestUpgrade(sessionId);
      if (!started) {
        showToast(api, {
          message: "Session upgrade request failed",
          variant: "error"
        });
        return;
      }
      // The RPC call fires no message event, so start the sidebar's
      // progress poll only after the server accepts the request.
      kickRecompProgressRefresh();
      showToast(api, {
        message: resume ? "Resuming session upgrade — running in the background" : "Session upgrade started — running in the background",
        variant: "info"
      });
      void dismissUpgradeReminder(sessionId);
    },
    onCancel: () => {
      // Explicit decline → set the durable stamp so we don't re-prompt
      // on every restart. The fix for stamp-on-display trapping a
      // never-upgraded session (dogfood 2026-05-30) relies on THIS
      // being the only place the TUI path stamps.
      void dismissUpgradeReminder(sessionId);
      showToast(api, {
        message: "Upgrade skipped — run /ctx-session-upgrade anytime",
        variant: "info",
        durationOverrideMs: 4000
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
  const directory = api.state.path.directory ?? "";
  const modelKey = getModelKeyFromMessages(api, sessionId);
  const detail = await loadStatusDetail(sessionId, directory, modelKey);
  if (getSessionId(api) !== sessionId) return false;
  api.ui.dialog.replace(() => _$createComponent(StatusDialog, {
    api: api,
    s: detail
  }));
  return true;
}
const EmbedDialog = props => {
  const theme = createMemo(() => props.api.theme.current);
  const t = () => theme();
  const lines = () => props.detail.statusText.split("\n");
  return (() => {
    var _el$80 = _$createElement("box"),
      _el$81 = _$createElement("box"),
      _el$82 = _$createElement("text"),
      _el$83 = _$createElement("b");
    _$insertNode(_el$80, _el$81);
    _$setProp(_el$80, "flexDirection", "column");
    _$setProp(_el$80, "width", "100%");
    _$setProp(_el$80, "paddingLeft", 2);
    _$setProp(_el$80, "paddingRight", 2);
    _$setProp(_el$80, "paddingTop", 1);
    _$setProp(_el$80, "paddingBottom", 1);
    _$insertNode(_el$81, _el$82);
    _$setProp(_el$81, "justifyContent", "center");
    _$setProp(_el$81, "width", "100%");
    _$setProp(_el$81, "marginBottom", 1);
    _$insertNode(_el$82, _el$83);
    _$insertNode(_el$83, _$createTextNode(`Embedding`));
    _$insert(_el$80, () => lines().map(line => (() => {
      var _el$85 = _$createElement("text");
      _$insert(_el$85, line);
      _$effect(_$p => _$setProp(_el$85, "fg", t().text, _$p));
      return _el$85;
    })()), null);
    _$effect(_$p => _$setProp(_el$82, "fg", t().accent, _$p));
    return _el$80;
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
  const directory = api.state.path.directory ?? "";
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
          var _el$86 = _$createElement("box"),
            _el$87 = _$createElement("text");
          _$insertNode(_el$86, _el$87);
          _$insertNode(_el$87, _$createTextNode(`probe`));
          return _el$86;
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
        var _el$89 = _$createElement("box"),
          _el$90 = _$createElement("text");
        _$insertNode(_el$89, _el$90);
        _$insert(_el$90, summary);
        return _el$89;
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
  await refreshToastDurationMs();

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
    if (action === "show-upgrade-dialog") {
      const resume = n.payload?.resume === true ? {
        stagedCount: Number(n.payload?.stagedCount ?? 0),
        stagedThrough: Number(n.payload?.stagedThrough ?? 0)
      } : undefined;
      return stillActive() && showUpgradeDialog(api, resume, requestedSessionId);
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