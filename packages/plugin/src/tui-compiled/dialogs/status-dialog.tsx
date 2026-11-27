import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { spread as _$spread } from "opentui:runtime-module:%40opentui%2Fsolid";
import { mergeProps as _$mergeProps } from "opentui:runtime-module:%40opentui%2Fsolid";
import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { use as _$use } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
// @ts-nocheck
/**
 * The `/ctx-status` dialog: one view, drawn from the shared status model.
 *
 * It lives in its own module so both host generations can mount the same
 * component. OpenCode 1 imports it from here; OpenCode 2 loads the compiled
 * copy (`src/tui-compiled/dialogs/status-dialog.tsx`) through the host's
 * OpenTUI runtime registry and mounts it on its dialog surface, the same
 * arrangement `src/v2/tui/sidebar-mount.ts` uses for the sidebar.
 */
import { createMemo, createSignal, onCleanup } from "opentui:runtime-module:solid-js";
import packageJson from "../../../package.json";
import { pausedRecompReason } from "../../shared/recomp-outcome";
import { buildStatusViewFor, distributeBarWidths, statusColumnsFor } from "../../shared/status-view";
import { RUST_MODE_HOST_PATHS_LINE } from "../../shared/rust-mode-status";
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

/**
 * Resolves a shared status tone against this host's theme. Every row in the
 * status dialog passes through here: a row drawn without an explicit colour
 * takes the terminal's default foreground, which on a light theme is the same
 * colour as the dialog background and reads as a blank page.
 */
function toneColor(theme, tone) {
  if (tone === "accent") return theme.accent;
  if (tone === "muted") return theme.textMuted;
  if (tone === "warning") return theme.warning;
  if (tone === "error") return theme.error;
  return theme.text;
}

/**
 * Width the dialog is actually laid out at, which is NOT the terminal width:
 * each host sizes its own dialog surface (OpenCode 1's default is 60 columns,
 * OpenCode 2's widest is 88 columns on a 200-column terminal), and that is the
 * width the sections have to fit into. Renderables carry their laid-out width
 * and emit "resize" when a layout pass changes it, so the component reads it
 * from its own root box. ("resized", with a d, is emitted only by the
 * renderer's root; a box never sends it, and listening for it left the dialog
 * sizing its sections from the terminal width forever.)
 *
 * Until the first layout there is no width to read; the terminal width is the
 * fallback, and an unknown terminal keeps the wide layout the dialog has always
 * drawn rather than collapsing on a guess.
 */
function terminalColumns() {
  const columns = process.stdout?.columns;
  return typeof columns === "number" && columns > 0 ? columns : Number.POSITIVE_INFINITY;
}

/** One label/value row, with the label column fixed so labels never wrap mid-word. */
const StatusRowView = props => (() => {
  var _el$4 = _$createElement("box"),
    _el$5 = _$createElement("box"),
    _el$6 = _$createElement("text"),
    _el$7 = _$createElement("text");
  _$insertNode(_el$4, _el$5);
  _$insertNode(_el$4, _el$7);
  _$setProp(_el$4, "width", "100%");
  _$setProp(_el$4, "flexDirection", "row");
  _$setProp(_el$4, "justifyContent", "space-between");
  _$setProp(_el$4, "gap", 1);
  _$insertNode(_el$5, _el$6);
  _$setProp(_el$5, "flexShrink", 0);
  _$insert(_el$6, () => props.row.label);
  _$insert(_el$7, () => props.row.value);
  _$effect(_p$ => {
    var _v$3 = props.labelWidth,
      _v$4 = props.t.textMuted,
      _v$5 = toneColor(props.t, props.row.tone);
    _v$3 !== _p$.e && (_p$.e = _$setProp(_el$5, "width", _v$3, _p$.e));
    _v$4 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$4, _p$.t));
    _v$5 !== _p$.a && (_p$.a = _$setProp(_el$7, "fg", _v$5, _p$.a));
    return _p$;
  }, {
    e: undefined,
    t: undefined,
    a: undefined
  });
  return _el$4;
})();
const StatusSectionView = props => (() => {
  var _el$8 = _$createElement("box"),
    _el$9 = _$createElement("text"),
    _el$0 = _$createElement("b");
  _$insertNode(_el$8, _el$9);
  _$setProp(_el$8, "flexDirection", "column");
  _$setProp(_el$8, "width", "100%");
  _$setProp(_el$8, "marginTop", 1);
  _$insertNode(_el$9, _el$0);
  _$insert(_el$0, () => props.section.title);
  _$insert(_el$8, () => props.section.rows.map(row => _$createComponent(StatusRowView, {
    get t() {
      return props.t;
    },
    row: row,
    get labelWidth() {
      return props.section.labelWidth;
    }
  })), null);
  _$effect(_$p => _$setProp(_el$9, "fg", props.t.text, _$p));
  return _el$8;
})();

/**
 * `status` is the checked result of the status RPC (`loadStatusDetail`), never
 * the raw reply: a reply the view cannot draw arrives as the reason it cannot,
 * and the shared model turns that into a "status unavailable" view. An
 * unchecked reply used to reach the view model directly, where a missing field
 * threw inside this component's first render and crashed the whole TUI.
 */
export const StatusDialog = props => {
  const theme = createMemo(() => props.api.theme.current);
  const t = () => theme();
  const ready = () => props.status.state === "ready" ? props.status : null;
  const compactionOff = () => ready()?.source.compaction_enabled === false;
  const recompProgress = () => ready()?.extras.recompProgress ?? null;
  const hostBackendsModuleSide = () => ready()?.extras.hostBackendsModuleSide === true;

  // Which rows exist, what they are called and which colour they carry is
  // decided by the shared model, so this dialog and Pi's overlay cannot drift
  // apart. This component only draws what the model returns, and the model
  // never throws: a result it cannot draw becomes the unavailable view.
  const view = createMemo(() => buildStatusViewFor(props.status, {
    version: packageJson.version
  }));
  // The dialog's own laid-out width, which is what the sections have to fit
  // into; the terminal width is only the pre-layout fallback.
  const [dialogWidth, setDialogWidth] = createSignal(0);
  const measureRoot = element => {
    const read = () => {
      const width = Number(element?.width);
      if (Number.isFinite(width) && width > 0) setDialogWidth(width);
    };
    read();
    element?.on?.("resize", read);
    onCleanup(() => element?.off?.("resize", read));
  };
  // paddingLeft + paddingRight below; what the sections get is what is left.
  const contentWidth = () => dialogWidth() > 0 ? dialogWidth() - 4 : terminalColumns();
  // The shared model decides whether the sections fit in two columns at this
  // width, and how wide each column has to be; below that the same sections
  // are drawn in one column, in the same order, instead of being squeezed
  // into mid-word wraps.
  const columns = () => statusColumnsFor(view().sections, contentWidth());
  const columnSections = parity => view().sections.filter((_section, index) => index % 2 === parity);
  const hygiene = () => view().hygiene;
  // Integer segment widths that sum to the bar's own width. Proportional
  // flexGrow lets the layout engine round each segment on its own, which
  // leaves blank cells between the coloured runs; the shared helper
  // distributes the remainder so the bar has no gaps. Before the first
  // layout there is no width to divide, so the flex fallback stays.
  const barWidths = () => {
    const width = contentWidth();
    if (!Number.isFinite(width) || width <= 0) return null;
    return distributeBarWidths(view().bar.map(segment => segment.tokens), width);
  };
  return (() => {
    var _el$1 = _$createElement("box"),
      _el$10 = _$createElement("box"),
      _el$11 = _$createElement("text"),
      _el$12 = _$createElement("b"),
      _el$13 = _$createElement("text"),
      _el$14 = _$createElement("box"),
      _el$15 = _$createElement("text"),
      _el$16 = _$createElement("b"),
      _el$17 = _$createElement("text"),
      _el$18 = _$createElement("box"),
      _el$19 = _$createElement("box"),
      _el$20 = _$createElement("box"),
      _el$21 = _$createElement("text");
    _$insertNode(_el$1, _el$10);
    _$insertNode(_el$1, _el$14);
    _$insertNode(_el$1, _el$18);
    _$insertNode(_el$1, _el$19);
    _$insertNode(_el$1, _el$20);
    _$use(measureRoot, _el$1);
    _$setProp(_el$1, "flexDirection", "column");
    _$setProp(_el$1, "width", "100%");
    _$setProp(_el$1, "paddingLeft", 2);
    _$setProp(_el$1, "paddingRight", 2);
    _$setProp(_el$1, "paddingTop", 1);
    _$setProp(_el$1, "paddingBottom", 1);
    _$insertNode(_el$10, _el$11);
    _$insertNode(_el$10, _el$13);
    _$setProp(_el$10, "justifyContent", "center");
    _$setProp(_el$10, "width", "100%");
    _$setProp(_el$10, "marginBottom", 1);
    _$setProp(_el$10, "flexDirection", "row");
    _$setProp(_el$10, "gap", 2);
    _$insertNode(_el$11, _el$12);
    _$insert(_el$12, () => view().title);
    _$insert(_el$13, () => view().version);
    _$insertNode(_el$14, _el$15);
    _$insertNode(_el$14, _el$17);
    _$setProp(_el$14, "flexDirection", "row");
    _$setProp(_el$14, "justifyContent", "space-between");
    _$setProp(_el$14, "width", "100%");
    _$insertNode(_el$15, _el$16);
    _$insert(_el$16, () => view().headline.left.text);
    _$insert(_el$17, () => view().headline.right.text);
    _$insert(_el$1, (() => {
      var _c$ = _$memo(() => !!view().windowLine);
      return () => _c$() && (() => {
        var _el$22 = _$createElement("text");
        _$insert(_el$22, () => view().windowLine);
        _$effect(_$p => _$setProp(_el$22, "fg", t().textMuted, _$p));
        return _el$22;
      })();
    })(), _el$18);
    _$setProp(_el$18, "width", "100%");
    _$setProp(_el$18, "flexDirection", "row");
    _$setProp(_el$18, "height", 1);
    _$insert(_el$18, () => view().bar.map((seg, index) => {
      const widths = barWidths();
      const fixed = widths ? widths[index] ?? 0 : undefined;
      return (() => {
        var _el$23 = _$createElement("box");
        _$spread(_el$23, _$mergeProps({
          get key() {
            return seg.label;
          }
        }, () => fixed === undefined ? {
          flexGrow: Math.max(1, seg.tokens),
          flexBasis: 0
        } : {
          width: fixed,
          flexShrink: 0
        }, {
          "height": 1,
          get backgroundColor() {
            return seg.color;
          }
        }), false);
        return _el$23;
      })();
    }));
    _$setProp(_el$19, "flexDirection", "column");
    _$setProp(_el$19, "width", "100%");
    _$insert(_el$19, () => view().breakdown.map(row => (() => {
      var _el$24 = _$createElement("box"),
        _el$25 = _$createElement("text"),
        _el$26 = _$createElement("text");
      _$insertNode(_el$24, _el$25);
      _$insertNode(_el$24, _el$26);
      _$setProp(_el$24, "width", "100%");
      _$setProp(_el$24, "flexDirection", "row");
      _$setProp(_el$24, "justifyContent", "space-between");
      _$setProp(_el$24, "gap", 1);
      _$insert(_el$25, () => row.label);
      _$insert(_el$26, () => row.value);
      _$effect(_p$ => {
        var _v$1 = row.label,
          _v$10 = row.color,
          _v$11 = t().textMuted;
        _v$1 !== _p$.e && (_p$.e = _$setProp(_el$24, "key", _v$1, _p$.e));
        _v$10 !== _p$.t && (_p$.t = _$setProp(_el$25, "fg", _v$10, _p$.t));
        _v$11 !== _p$.a && (_p$.a = _$setProp(_el$26, "fg", _v$11, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$24;
    })()), null);
    _$insert(_el$19, (() => {
      var _c$2 = _$memo(() => !!hygiene());
      return () => _c$2() && _$createComponent(StatusRowView, {
        get t() {
          return t();
        },
        get row() {
          return hygiene();
        },
        labelWidth: 9
      });
    })(), null);
    _$insert(_el$1, (() => {
      var _c$3 = _$memo(() => !!(!compactionOff() && recompProgress()));
      return () => _c$3() && (() => {
        const p = recompProgress();
        // Label follows the flow that started the run, so a plain
        // /ctx-recomp never reads as an "Upgrade" (dogfood 2026-06-04).
        const verb = p.kind === "upgrade" ? "Upgrade" : p.kind === "embed" ? "Embed" : "Recomp";
        return (() => {
          var _el$27 = _$createElement("box"),
            _el$28 = _$createElement("text"),
            _el$29 = _$createElement("b");
          _$insertNode(_el$27, _el$28);
          _$setProp(_el$27, "marginTop", 1);
          _$setProp(_el$27, "width", "100%");
          _$setProp(_el$27, "flexDirection", "column");
          _$insertNode(_el$28, _el$29);
          _$insert(_el$29, verb);
          _$insert(_el$27, () => {
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
            const paused = pausedRecompReason(p.message);
            if (paused !== null) return _$createComponent(R, {
              get t() {
                return t();
              },
              l: "Status",
              v: `${verb} paused: ${paused}`,
              get fg() {
                return t().warning;
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
          _$effect(_$p => _$setProp(_el$28, "fg", t().text, _$p));
          return _el$27;
        })();
      })();
    })(), _el$20);
    _$insert(_el$1, (() => {
      var _c$4 = _$memo(() => !!hostBackendsModuleSide());
      return () => _c$4() && (() => {
        var _el$30 = _$createElement("box"),
          _el$31 = _$createElement("text"),
          _el$32 = _$createElement("b"),
          _el$34 = _$createElement("text");
        _$insertNode(_el$30, _el$31);
        _$insertNode(_el$30, _el$34);
        _$setProp(_el$30, "marginTop", 1);
        _$setProp(_el$30, "width", "100%");
        _$setProp(_el$30, "flexDirection", "column");
        _$insertNode(_el$31, _el$32);
        _$insertNode(_el$32, _$createTextNode(`Rust Mode`));
        _$insert(_el$34, RUST_MODE_HOST_PATHS_LINE);
        _$effect(_p$ => {
          var _v$12 = t().text,
            _v$13 = t().textMuted;
          _v$12 !== _p$.e && (_p$.e = _$setProp(_el$31, "fg", _v$12, _p$.e));
          _v$13 !== _p$.t && (_p$.t = _$setProp(_el$34, "fg", _v$13, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$30;
      })();
    })(), _el$20);
    _$insert(_el$1, (() => {
      var _c$5 = _$memo(() => !!columns().twoColumn);
      return () => _c$5() ? (() => {
        var _el$35 = _$createElement("box"),
          _el$36 = _$createElement("box"),
          _el$37 = _$createElement("box");
        _$insertNode(_el$35, _el$36);
        _$insertNode(_el$35, _el$37);
        _$setProp(_el$35, "flexDirection", "row");
        _$setProp(_el$35, "width", "100%");
        _$setProp(_el$35, "gap", 4);
        _$setProp(_el$36, "flexDirection", "column");
        _$setProp(_el$36, "flexGrow", 0);
        _$setProp(_el$36, "flexShrink", 1);
        _$setProp(_el$36, "minWidth", 0);
        _$setProp(_el$36, "overflow", "hidden");
        _$insert(_el$36, () => columnSections(0).map(section => _$createComponent(StatusSectionView, {
          get t() {
            return t();
          },
          section: section
        })));
        _$setProp(_el$37, "flexDirection", "column");
        _$setProp(_el$37, "flexGrow", 0);
        _$setProp(_el$37, "flexShrink", 1);
        _$setProp(_el$37, "minWidth", 0);
        _$setProp(_el$37, "overflow", "hidden");
        _$insert(_el$37, () => columnSections(1).map(section => _$createComponent(StatusSectionView, {
          get t() {
            return t();
          },
          section: section
        })));
        _$effect(_p$ => {
          var _v$14 = columns().leftWidth,
            _v$15 = columns().rightWidth;
          _v$14 !== _p$.e && (_p$.e = _$setProp(_el$36, "flexBasis", _v$14, _p$.e));
          _v$15 !== _p$.t && (_p$.t = _$setProp(_el$37, "flexBasis", _v$15, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$35;
      })() : (() => {
        var _el$38 = _$createElement("box");
        _$setProp(_el$38, "flexDirection", "column");
        _$setProp(_el$38, "width", "100%");
        _$insert(_el$38, () => view().sections.map(section => _$createComponent(StatusSectionView, {
          get t() {
            return t();
          },
          section: section
        })));
        return _el$38;
      })();
    })(), _el$20);
    _$insert(_el$1, (() => {
      var _c$6 = _$memo(() => view().warnings.length > 0);
      return () => _c$6() && (() => {
        var _el$39 = _$createElement("box");
        _$setProp(_el$39, "marginTop", 1);
        _$setProp(_el$39, "width", "100%");
        _$setProp(_el$39, "flexDirection", "column");
        _$insert(_el$39, () => view().warnings.map(warning => (() => {
          var _el$40 = _$createElement("text");
          _$insert(_el$40, () => warning.text);
          _$effect(_$p => _$setProp(_el$40, "fg", warning.tone === "error" ? t().error : t().warning, _$p));
          return _el$40;
        })()));
        return _el$39;
      })();
    })(), _el$20);
    _$insertNode(_el$20, _el$21);
    _$setProp(_el$20, "marginTop", 1);
    _$setProp(_el$20, "justifyContent", "flex-end");
    _$setProp(_el$20, "width", "100%");
    _$insert(_el$21, () => view().footer);
    _$effect(_p$ => {
      var _v$6 = t().accent,
        _v$7 = t().textMuted,
        _v$8 = toneColor(t(), view().headline.left.tone),
        _v$9 = toneColor(t(), view().headline.right.tone),
        _v$0 = t().textMuted;
      _v$6 !== _p$.e && (_p$.e = _$setProp(_el$11, "fg", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp(_el$13, "fg", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp(_el$15, "fg", _v$8, _p$.a));
      _v$9 !== _p$.o && (_p$.o = _$setProp(_el$17, "fg", _v$9, _p$.o));
      _v$0 !== _p$.i && (_p$.i = _$setProp(_el$21, "fg", _v$0, _p$.i));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined
    });
    return _el$1;
  })();
};