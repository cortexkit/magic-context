import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */
import { Index, Show } from "opentui:runtime-module:solid-js";
import { SidebarFrame, SidebarGaugeRow, SidebarSection, SidebarStatRow, SidebarTextRow } from "../vendor/opencode-sidebar";
import { badgeTextColor } from "../badge-contrast";
// Every gauge row passes this session's own thresholds, so these defaults only
// fill the frame's required appearance.
const APPEARANCE = {
  barWidth: 10,
  barFilledChar: "█",
  barEmptyChar: "░",
  warnThreshold: 50,
  errorThreshold: 80
};

/** The host theme in the shared frame's colour names. */
export function sidebarTheme(theme) {
  return {
    text: theme.text,
    textMuted: theme.textMuted,
    accent: theme.accent,
    success: theme.success,
    warning: theme.warning,
    error: theme.error,
    borderActive: theme.borderActive,
    // The frame draws the badge label in `background` on `accent`; pick a
    // label colour that stays readable when the two are too close.
    background: badgeTextColor(theme.accent, theme.background)
  };
}
function StatRows(props) {
  return _$createComponent(Index, {
    get each() {
      return props.rows;
    },
    children: row => _$createComponent(SidebarStatRow, {
      get label() {
        return row().label;
      },
      get value() {
        return row().value;
      },
      get tone() {
        return row().tone;
      }
    })
  });
}
function Gauge(props) {
  return _$createComponent(SidebarGaugeRow, {
    get label() {
      return props.gauge.label;
    },
    get used() {
      return props.gauge.used;
    },
    get value() {
      return props.gauge.value;
    },
    get warnAt() {
      return props.gauge.warnAt;
    },
    get errorAt() {
      return props.gauge.errorAt;
    }
  });
}

/** The collapsed panel's one row: a stat row ending in a status dot. */
function Summary(props) {
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box"),
      _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "columnGap", 1);
    _$setProp(_el$2, "flexGrow", 1);
    _$insert(_el$2, _$createComponent(SidebarStatRow, {
      get label() {
        return props.row.label;
      },
      get value() {
        return props.row.value;
      }
    }));
    _$insertNode(_el$3, _$createTextNode(`●`));
    _$effect(_$p => _$setProp(_el$3, "fg", props.theme.success, _$p));
    return _el$;
  })();
}
/** Draws a decided {@link SidebarView} in the shared CortexKit sidebar frame. */
export function SidebarPanel(props) {
  return _$createComponent(SidebarFrame, {
    get header() {
      return {
        badge: props.label,
        version: props.version
      };
    },
    accounts: [],
    get theme() {
      return props.theme;
    },
    appearance: APPEARANCE,
    showQuota: false,
    get now() {
      return props.now;
    },
    get collapsed() {
      return props.collapsed;
    },
    collapsible: true,
    get onToggle() {
      return props.onToggle;
    },
    sections: () => [_$createComponent(Show, {
      get when() {
        return props.view.context;
      },
      children: context => _$createComponent(SidebarSection, {
        title: "Context",
        get children() {
          return [_$createComponent(Show, {
            get when() {
              return context().gauge;
            },
            children: gauge => _$createComponent(Gauge, {
              get gauge() {
                return gauge();
              }
            })
          }), _$createComponent(StatRows, {
            get rows() {
              return context().rows;
            }
          })];
        }
      })
    }), _$createComponent(Show, {
      get when() {
        return props.view.history;
      },
      children: rows => _$createComponent(SidebarSection, {
        title: "History",
        get children() {
          return _$createComponent(StatRows, {
            get rows() {
              return rows();
            }
          });
        }
      })
    }), _$createComponent(Show, {
      get when() {
        return props.view.progress;
      },
      children: progress => _$createComponent(SidebarSection, {
        get title() {
          return progress().title;
        },
        get children() {
          return [_$createComponent(StatRows, {
            get rows() {
              return progress().rows;
            }
          }), _$createComponent(Show, {
            get when() {
              return progress().gauge;
            },
            children: gauge => _$createComponent(Gauge, {
              get gauge() {
                return gauge();
              }
            })
          }), _$createComponent(Index, {
            get each() {
              return progress().notes;
            },
            children: note => _$createComponent(SidebarTextRow, {
              get text() {
                return note();
              }
            })
          })];
        }
      })
    }), _$createComponent(Show, {
      get when() {
        return props.view.cache;
      },
      children: rows => _$createComponent(SidebarSection, {
        title: "Prompt cache",
        get children() {
          return _$createComponent(StatRows, {
            get rows() {
              return rows();
            }
          });
        }
      })
    }), _$createComponent(Show, {
      get when() {
        return props.view.knowledge;
      },
      children: rows => _$createComponent(SidebarSection, {
        title: "Knowledge",
        get children() {
          return _$createComponent(StatRows, {
            get rows() {
              return rows();
            }
          });
        }
      })
    })],
    collapsedSections: () => _$createComponent(Summary, {
      get row() {
        return props.view.summary;
      },
      get theme() {
        return props.theme;
      }
    })
  });
}