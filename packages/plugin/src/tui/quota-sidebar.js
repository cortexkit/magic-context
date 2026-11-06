// @bun
// ../../node_modules/.bun/@cortexkit+common-auth@0.38.0+79ed038a4f852143/node_modules/@cortexkit/common-auth/src/quota-sidebar/index.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createContext, createMemo, createSignal, For, Index, mergeProps, Show, useContext } from "solid-js";

// ../../node_modules/.bun/@cortexkit+common-auth@0.38.0+79ed038a4f852143/node_modules/@cortexkit/common-auth/src/quota/map.ts
var ALL_SCOPE = "all";
var DEFAULT_REQUIRED_LABELS = Object.freeze([
  "primary"
]);

// ../../node_modules/.bun/@cortexkit+common-auth@0.38.0+79ed038a4f852143/node_modules/@cortexkit/common-auth/src/quota/format.ts
var QUOTA_STALE_AFTER_MS = 15 * 60000;
var NO_QUOTA_READING = "no quota reading yet";
var NO_LIMITS_REPORTED = "no limits reported";
function shortSpan(ms) {
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60)
    return `${minutes}m`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return hours === 0 ? `${days}d` : `${days}d${hours}h`;
}
function lengthName(minutes) {
  if (minutes % 1440 === 0)
    return `${minutes / 1440}d`;
  if (minutes % 60 === 0)
    return `${minutes / 60}h`;
  return `${minutes}m`;
}
function quotaWindowName(limit) {
  if (limit.scope !== ALL_SCOPE || limit.windowMinutes === undefined)
    return limit.label;
  return lengthName(limit.windowMinutes);
}
function clampPercent(remaining) {
  return Math.min(100, Math.max(0, remaining));
}
function wholePercent(remaining) {
  return Math.round(clampPercent(remaining));
}
function percentLeft(remaining) {
  return `${wholePercent(remaining)}% left`;
}
function resetDetails(resetsAt, checkedAt, now) {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  return {
    ...Number.isFinite(at) && at > now ? { resetIn: shortSpan(at - now) } : {},
    resetSinceReading: Number.isFinite(at) && at > checkedAt && at <= now
  };
}
function displayOrder(left, right) {
  const l = left.windowMinutes;
  const r = right.windowMinutes;
  if (l !== undefined && r !== undefined && l !== r)
    return l - r;
  if (l === undefined !== (r === undefined))
    return l === undefined ? 1 : -1;
  if (left.scope !== right.scope) {
    if (left.scope === ALL_SCOPE)
      return -1;
    if (right.scope === ALL_SCOPE)
      return 1;
    return left.scope < right.scope ? -1 : 1;
  }
  return left.label < right.label ? -1 : left.label > right.label ? 1 : 0;
}
function quotaWindowParts(quota, options) {
  const { windows, age } = scopedWindowParts(quota, options, true);
  const parts = windows.map(({ part }) => part);
  return age === undefined ? { windows: parts } : { windows: parts, age };
}
function withShortNames(windows) {
  const abbreviations = scopeAbbreviations(windows.filter(({ part, scope }) => part.kind === "window" && scope !== ALL_SCOPE).map(({ scope }) => scope));
  for (const window of windows) {
    window.part.short = window.part.kind === "budget" ? "cr" : window.scope === ALL_SCOPE ? window.part.name : abbreviations.get(window.scope) ?? window.scope;
  }
  return windows;
}
function hasWindowReading(limit) {
  return Number.isFinite(limit.remainingPercent) && Number.isFinite(limit.checkedAt);
}
function scopedWindowParts(quota, options, includeUnknown = false) {
  if (!quota)
    return { windows: [] };
  const { now } = options;
  const readings = quota.limits.filter((limit) => limit.kind === "reading" && (includeUnknown || hasWindowReading(limit))).sort(displayOrder);
  const windows = readings.map((limit) => {
    const part = hasWindowReading(limit) ? {
      kind: "window",
      reading: "known",
      name: quotaWindowName(limit),
      short: "",
      figure: percentLeft(limit.remainingPercent),
      remainingPercent: clampPercent(limit.remainingPercent),
      checkedAt: limit.checkedAt,
      ...resetDetails(limit.resetsAt, limit.checkedAt, now)
    } : {
      kind: "window",
      reading: "unknown",
      name: quotaWindowName(limit),
      short: "",
      figure: "no reading",
      resetSinceReading: false
    };
    return {
      scope: limit.scope,
      ...limit.windowMinutes === undefined ? {} : { windowMinutes: limit.windowMinutes },
      part
    };
  });
  const budget = quota.budget;
  if (budget) {
    const remainingPercent = budget.remainingPercent;
    const figure = budget.reached ? "credits spent" : remainingPercent !== undefined ? `credits ${percentLeft(remainingPercent)}` : "credits available";
    windows.push({
      scope: ALL_SCOPE,
      spent: budget.reached,
      part: {
        kind: "budget",
        reading: "known",
        name: "credits",
        short: "",
        figure,
        ...remainingPercent === undefined ? {} : { remainingPercent: clampPercent(remainingPercent) },
        checkedAt: budget.checkedAt,
        ...resetDetails(budget.resetsAt, budget.checkedAt, now)
      }
    });
  }
  withShortNames(windows);
  const readingTimes = windows.flatMap(({ part }) => part.reading === "known" && part.checkedAt !== undefined ? [part.checkedAt] : []);
  if (readingTimes.length > 0) {
    const age = now - Math.min(...readingTimes);
    if (age > (options.staleAfterMs ?? QUOTA_STALE_AFTER_MS)) {
      return { windows, age: `checked ${shortSpan(age)} ago` };
    }
  }
  return { windows };
}
function scopeDisplayName(scope) {
  const model = scope.slice(scope.indexOf(":") + 1);
  return model.charAt(0).toUpperCase() + model.slice(1);
}
function scopeAbbreviations(scopes) {
  const names = [...new Set(scopes.map(scopeDisplayName))];
  const lengths = new Map(names.map((name) => [name, 2]));
  const short = (name) => name.slice(0, lengths.get(name));
  for (;; ) {
    const byShort = new Map;
    for (const name of names) {
      byShort.set(short(name), [...byShort.get(short(name)) ?? [], name]);
    }
    let extended = false;
    for (const group of byShort.values()) {
      if (group.length < 2)
        continue;
      for (const name of group) {
        const length = lengths.get(name) ?? 2;
        if (length < name.length) {
          lengths.set(name, length + 1);
          extended = true;
        }
      }
    }
    if (!extended)
      break;
  }
  return new Map(scopes.map((scope) => [scope, short(scopeDisplayName(scope))]));
}
var NARROW_GROUP_LIMIT = 2;
function groupShortNames(groups) {
  const labels = groups.map((group) => group.label.trim() || group.scope);
  const short = scopeAbbreviations(labels);
  return labels.map((label) => short.get(label) ?? label);
}
function groupedNarrowPieces(groups, windows) {
  if (!groups || groups.length === 0)
    return;
  const reported = windows.filter(({ part }) => part.kind === "window");
  if (reported.some(({ scope }) => scope === ALL_SCOPE))
    return;
  const candidates = groups.flatMap((group, listed) => {
    const inGroup = reported.filter(({ scope }) => scope === group.scope);
    const groupTightest = inGroup.reduce((least, window) => least === undefined || (window.part.remainingPercent ?? 0) < (least.part.remainingPercent ?? 0) ? window : least, undefined);
    return groupTightest ? [{ group, listed, window: groupTightest }] : [];
  });
  if (candidates.length === 0)
    return;
  const names = groupShortNames(groups);
  const left = (candidate) => candidate.window.part.remainingPercent ?? 0;
  const shown = [...candidates].sort((a, b) => left(a) - left(b) || a.listed - b.listed).slice(0, NARROW_GROUP_LIMIT).sort((a, b) => a.listed - b.listed);
  return shown.map((candidate, index) => {
    const { windowMinutes } = candidate.window;
    const piece = [
      names[candidate.listed] ?? candidate.group.scope,
      ...windowMinutes === undefined ? [] : [lengthName(windowMinutes)],
      `${wholePercent(left(candidate))}%`
    ].join(" ");
    return index === shown.length - 1 ? `${piece} left` : piece;
  });
}
function narrowTextParts(quota, options) {
  const { windows } = scopedWindowParts(quota, options);
  const grouped = groupedNarrowPieces(quota?.groups, windows);
  if (grouped)
    return grouped;
  const general = windows.filter(({ part, scope }) => part.kind === "window" && scope === ALL_SCOPE);
  const scoped = windows.filter(({ part, scope }) => part.kind === "window" && scope !== ALL_SCOPE);
  const budget = windows.find(({ part }) => part.kind === "budget");
  const budgetLeft = budget?.spent ? 0 : budget?.part.remainingPercent;
  const extras = [
    ...scoped.map(({ part }) => ({
      label: part.short,
      remaining: part.remainingPercent ?? 0
    })),
    ...budgetLeft === undefined || budget === undefined ? [] : [{ label: budget.part.short, remaining: budgetLeft }]
  ];
  const tightest = extras.reduce((best, item) => best === undefined || item.remaining < best.remaining ? item : best, undefined);
  const pieces = general.map(({ part }) => `${part.name} ${wholePercent(part.remainingPercent ?? 0)}%`);
  if (tightest) {
    pieces.push(`${tightest.label} ${wholePercent(tightest.remaining)}%`);
  }
  if (pieces.length === 0)
    return windows.map(({ part }) => part.figure);
  return pieces.map((piece, index) => index === pieces.length - 1 ? `${piece} left` : piece);
}
function quotaTextParts(quota, options) {
  if (options.form === "narrow")
    return narrowTextParts(quota, options);
  const { windows, age } = scopedWindowParts(quota, options);
  const full = (options.form ?? "full") === "full";
  const text = windows.map(({ part }) => {
    const reset = full && part.resetIn ? `, resets ${part.resetIn}` : "";
    return `${part.kind === "budget" ? "" : `${part.name} `}${part.figure}${reset}`;
  });
  return age === undefined ? text : [...text, age];
}
function formatQuota(quota, options) {
  const parts = quotaTextParts(quota, options);
  if (parts.length > 0)
    return parts.join(" \xB7 ");
  return quota && quota.limits.length > 0 ? NO_LIMITS_REPORTED : NO_QUOTA_READING;
}

// ../../node_modules/.bun/@cortexkit+common-auth@0.38.0+79ed038a4f852143/node_modules/@cortexkit/common-auth/src/quota-sidebar/index.tsx
var FrameContext = createContext();
function frameContext() {
  const context = useContext(FrameContext);
  if (!context)
    throw new Error("Sidebar primitives must be inside SidebarFrame");
  return context;
}
function displayWidth(text) {
  const bun = globalThis.Bun;
  return bun?.stringWidth ? bun.stringWidth(text) : Array.from(text).length;
}
function fitText(text, columns) {
  if (displayWidth(text) <= columns)
    return text;
  if (columns < 1)
    return "";
  let kept = "";
  let used = 0;
  for (const char of text) {
    const width = displayWidth(char);
    if (used + width > columns - 1)
      break;
    kept += char;
    used += width;
  }
  return `${kept}\u2026`;
}
function SidebarSection(props) {
  const context = frameContext();
  return [(() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("b");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "marginTop", 1);
    _$insertNode(_el$2, _el$3);
    _$insert(_el$3, () => props.title);
    _$effect((_$p) => _$setProp(_el$2, "fg", context.theme.text, _$p));
    return _el$;
  })(), _$memo(() => props.children)];
}
function SidebarStatRow(props) {
  const context = frameContext();
  const [width, setWidth] = createSignal(0);
  let row;
  const value = () => width() <= 0 ? props.value : fitText(props.value, width() - displayWidth(props.label) - 1);
  return (() => {
    var _el$4 = _$createElement("box"), _el$5 = _$createElement("text"), _el$6 = _$createElement("text"), _el$7 = _$createElement("b");
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$6);
    _$use((element) => {
      row = element;
    }, _el$4);
    _$setProp(_el$4, "onSizeChange", () => setWidth(row?.width ?? 0));
    _$setProp(_el$4, "width", "100%");
    _$setProp(_el$4, "flexDirection", "row");
    _$setProp(_el$4, "justifyContent", "space-between");
    _$setProp(_el$4, "columnGap", 1);
    _$setProp(_el$5, "wrapMode", "none");
    _$setProp(_el$5, "flexShrink", 0);
    _$insert(_el$5, () => props.label);
    _$insertNode(_el$6, _el$7);
    _$setProp(_el$6, "wrapMode", "none");
    _$setProp(_el$6, "flexShrink", 1);
    _$insert(_el$7, value);
    _$effect((_p$) => {
      var _v$ = context.theme.textMuted, _v$2 = context.theme[props.tone ?? "text"];
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$5, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$4;
  })();
}
function SidebarTextRow(props) {
  const context = frameContext();
  return (() => {
    var _el$8 = _$createElement("text");
    _$insert(_el$8, () => props.text);
    _$effect((_p$) => {
      var _v$3 = context.theme[props.tone ?? "textMuted"], _v$4 = props.wrapMode;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$8, "fg", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$8, "wrapMode", _v$4, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$8;
  })();
}
function usageTone(used, appearance) {
  if (used >= appearance.errorThreshold)
    return "error";
  if (used >= appearance.warnThreshold)
    return "warning";
  return "success";
}
function barSegments(used, appearance, pace) {
  const width = appearance.barWidth;
  const cells = (pct) => Math.max(0, Math.min(Math.round(pct / 100 * width), width));
  const usedCells = cells(used);
  const tone = usageTone(used, appearance);
  const plain = [{
    text: appearance.barFilledChar.repeat(usedCells),
    tone
  }, {
    text: "",
    tone
  }, {
    text: appearance.barEmptyChar.repeat(width - usedCells),
    tone
  }];
  const overlay = pace?.overlay;
  if (!overlay)
    return plain;
  const paceCells = cells(overlay.percent);
  const lo = Math.min(usedCells, paceCells);
  const hi = Math.max(usedCells, paceCells);
  if (lo === hi)
    return plain;
  return [{
    text: appearance.barFilledChar.repeat(lo),
    tone
  }, {
    text: (overlay.kind === "deficit" ? "\u2593" : "\u2592").repeat(hi - lo),
    tone: overlay.kind === "deficit" ? "error" : "success"
  }, {
    text: appearance.barEmptyChar.repeat(width - hi),
    tone
  }];
}
function QuotaRow(props) {
  const context = frameContext();
  const [columns, setColumns] = createSignal(0);
  let row;
  const label = () => props.part.name + " ".repeat(Math.max(0, props.labelWidth - displayWidth(props.part.name)));
  const figure = () => ` ${props.part.kind === "budget" && props.part.figure.startsWith(`${props.part.name} `) ? props.part.figure.slice(props.part.name.length + 1) : props.part.figure}`;
  const hasReading = () => props.part.reading === "known";
  const used = () => 100 - (props.part.remainingPercent ?? 100);
  const segments = createMemo(() => hasReading() ? barSegments(used(), {
    ...context.appearance,
    barWidth: props.barCells
  }, props.pace) : [], undefined, {
    equals: (previous, next) => previous.length === next.length && previous.every((segment, index) => segment.text === next[index]?.text && segment.tone === next[index]?.tone)
  });
  const paceLine = () => {
    const text = props.pace?.text;
    if (!text || columns() <= 0)
      return text;
    return fitText(text, columns() - props.labelWidth);
  };
  return [(() => {
    var _el$9 = _$createElement("box"), _el$0 = _$createElement("box");
    _$insertNode(_el$9, _el$0);
    _$use((element) => {
      row = element;
    }, _el$9);
    _$setProp(_el$9, "onSizeChange", () => setColumns(row?.width ?? 0));
    _$setProp(_el$9, "width", "100%");
    _$setProp(_el$9, "flexDirection", "row");
    _$setProp(_el$9, "justifyContent", "space-between");
    _$setProp(_el$0, "flexDirection", "row");
    _$insert(_el$0, _$createComponent(Show, {
      get when() {
        return props.labelWidth > 0;
      },
      get children() {
        var _el$1 = _$createElement("text");
        _$setProp(_el$1, "wrapMode", "none");
        _$setProp(_el$1, "flexShrink", 0);
        _$insert(_el$1, label);
        _$effect((_$p) => _$setProp(_el$1, "fg", context.theme.textMuted, _$p));
        return _el$1;
      }
    }), null);
    _$insert(_el$0, _$createComponent(Show, {
      get when() {
        return hasReading();
      },
      get fallback() {
        return (() => {
          var _el$13 = _$createElement("text");
          _$insertNode(_el$13, _$createTextNode(`no reading`));
          _$setProp(_el$13, "wrapMode", "none");
          _$effect((_$p) => _$setProp(_el$13, "fg", context.theme.textMuted, _$p));
          return _el$13;
        })();
      },
      get children() {
        return _$createComponent(Show, {
          get when() {
            return !props.part.resetSinceReading;
          },
          get fallback() {
            return (() => {
              var _el$15 = _$createElement("text");
              _$insertNode(_el$15, _$createTextNode(`reset since last check`));
              _$setProp(_el$15, "wrapMode", "none");
              _$effect((_$p) => _$setProp(_el$15, "fg", context.theme.textMuted, _$p));
              return _el$15;
            })();
          },
          get children() {
            return [_$createComponent(Show, {
              get when() {
                return props.barCells > 0;
              },
              get children() {
                return _$createComponent(Index, {
                  get each() {
                    return segments();
                  },
                  children: (segment) => (() => {
                    var _el$17 = _$createElement("text");
                    _$setProp(_el$17, "wrapMode", "none");
                    _$insert(_el$17, () => segment().text);
                    _$effect((_p$) => {
                      var _v$5 = context.theme[segment().tone], _v$6 = segment().text ? undefined : 0;
                      _v$5 !== _p$.e && (_p$.e = _$setProp(_el$17, "fg", _v$5, _p$.e));
                      _v$6 !== _p$.t && (_p$.t = _$setProp(_el$17, "width", _v$6, _p$.t));
                      return _p$;
                    }, {
                      e: undefined,
                      t: undefined
                    });
                    return _el$17;
                  })()
                });
              }
            }), (() => {
              var _el$10 = _$createElement("text");
              _$setProp(_el$10, "wrapMode", "none");
              _$insert(_el$10, figure);
              _$effect((_$p) => _$setProp(_el$10, "fg", context.theme[usageTone(used(), context.appearance)], _$p));
              return _el$10;
            })()];
          }
        });
      }
    }), null);
    _$insert(_el$9, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!(hasReading() && props.showReset))() && !props.part.resetSinceReading;
      },
      get children() {
        var _el$11 = _$createElement("box");
        _$setProp(_el$11, "flexShrink", 0);
        _$setProp(_el$11, "flexDirection", "row");
        _$setProp(_el$11, "justifyContent", "flex-end");
        _$insert(_el$11, _$createComponent(Show, {
          get when() {
            return props.part.resetIn;
          },
          get children() {
            var _el$12 = _$createElement("text");
            _$setProp(_el$12, "wrapMode", "none");
            _$insert(_el$12, () => props.part.resetIn);
            _$effect((_$p) => _$setProp(_el$12, "fg", context.theme.textMuted, _$p));
            return _el$12;
          }
        }));
        _$effect((_$p) => _$setProp(_el$11, "width", props.resetWidth, _$p));
        return _el$11;
      }
    }), null);
    _$effect((_$p) => _$setProp(_el$0, "flexShrink", props.part.resetSinceReading ? 1 : 0, _$p));
    return _el$9;
  })(), _$createComponent(Show, {
    get when() {
      return _$memo(() => !!(hasReading() && !props.part.resetSinceReading))() && paceLine();
    },
    keyed: true,
    children: (line) => (() => {
      var _el$18 = _$createElement("box"), _el$20 = _$createElement("text");
      _$insertNode(_el$18, _el$20);
      _$setProp(_el$18, "width", "100%");
      _$setProp(_el$18, "flexDirection", "row");
      _$insert(_el$18, _$createComponent(Show, {
        get when() {
          return props.labelWidth > 0;
        },
        get children() {
          var _el$19 = _$createElement("text");
          _$insert(_el$19, () => "".padEnd(props.labelWidth));
          _$effect((_$p) => _$setProp(_el$19, "fg", context.theme.textMuted, _$p));
          return _el$19;
        }
      }), _el$20);
      _$setProp(_el$20, "wrapMode", "none");
      _$insert(_el$20, line);
      _$effect((_$p) => _$setProp(_el$20, "fg", context.theme[props.pace?.tone ?? "textMuted"], _$p));
      return _el$18;
    })()
  })];
}
function CollapsedAccountRow(props) {
  const context = frameContext();
  const [width, setWidth] = createSignal(0);
  let row;
  const hasQuota = () => quotaWindowParts(props.account.quota, {
    now: context.now
  }).windows.some((part) => part.reading === "known");
  const text = () => hasQuota() ? formatQuota(props.account.quota, {
    now: context.now,
    form: "narrow"
  }) : props.account.emptyQuotaText?.collapsed ?? "\u2014";
  const showQuota = () => width() <= 0 || displayWidth(text()) + 4 <= width();
  const label = () => {
    if (width() <= 0)
      return props.account.label;
    return fitText(props.account.label, width() - (showQuota() ? displayWidth(text()) + 3 : 2));
  };
  const muted = () => props.account.collapsed?.muted ?? false;
  const quotaTone = () => muted() ? "textMuted" : props.account.collapsed?.quotaTone ?? "success";
  return (() => {
    var _el$21 = _$createElement("box"), _el$23 = _$createElement("box"), _el$26 = _$createElement("text");
    _$insertNode(_el$21, _el$23);
    _$use((element) => {
      row = element;
    }, _el$21);
    _$setProp(_el$21, "onSizeChange", () => setWidth(row?.width ?? 0));
    _$setProp(_el$21, "width", "100%");
    _$setProp(_el$21, "flexDirection", "row");
    _$setProp(_el$21, "justifyContent", "space-between");
    _$insert(_el$21, _$createComponent(Show, {
      get when() {
        return label();
      },
      get children() {
        var _el$22 = _$createElement("text");
        _$setProp(_el$22, "wrapMode", "none");
        _$setProp(_el$22, "flexShrink", 1);
        _$insert(_el$22, label);
        _$effect((_$p) => _$setProp(_el$22, "fg", context.theme[muted() ? "textMuted" : "text"], _$p));
        return _el$22;
      }
    }), _el$23);
    _$insertNode(_el$23, _el$26);
    _$setProp(_el$23, "flexDirection", "row");
    _$setProp(_el$23, "flexShrink", 0);
    _$insert(_el$23, _$createComponent(Show, {
      get when() {
        return showQuota();
      },
      get children() {
        return _$createComponent(Show, {
          get when() {
            return _$memo(() => !!hasQuota())() && !muted();
          },
          get fallback() {
            return (() => {
              var _el$27 = _$createElement("text");
              _$insert(_el$27, text);
              _$effect((_$p) => _$setProp(_el$27, "fg", context.theme.textMuted, _$p));
              return _el$27;
            })();
          },
          get children() {
            var _el$24 = _$createElement("text"), _el$25 = _$createElement("b");
            _$insertNode(_el$24, _el$25);
            _$insert(_el$25, text);
            _$effect((_$p) => _$setProp(_el$24, "fg", context.theme[quotaTone()], _$p));
            return _el$24;
          }
        });
      }
    }), _el$26);
    _$insert(_el$26, () => showQuota() ? " " : "", null);
    _$insert(_el$26, () => props.account.blocked ? "\u2298" : "\u25CF", null);
    _$effect((_p$) => {
      var _v$7 = label() ? 1 : 0, _v$8 = context.theme[props.account.indicatorTone];
      _v$7 !== _p$.e && (_p$.e = _$setProp(_el$21, "columnGap", _v$7, _p$.e));
      _v$8 !== _p$.t && (_p$.t = _$setProp(_el$26, "fg", _v$8, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$21;
  })();
}
function AccountBlock(props) {
  const context = frameContext();
  const [columns, setColumns] = createSignal(0);
  let block;
  const rows = () => props.account.groups.flatMap((group) => group.rows);
  const labelWidth = () => Math.max(0, ...rows().map(({
    part
  }) => part.name ? Math.max(3, displayWidth(part.name) + 1) : 0));
  const resetWidth = () => Math.max(0, ...rows().map(({
    part
  }) => part.reading === "unknown" || part.resetSinceReading ? 0 : displayWidth(part.resetIn ?? "")));
  const figureWidth = createMemo(() => Math.max(10, ...rows().filter(({
    part
  }) => part.reading === "known" && !part.resetSinceReading).map(({
    part
  }) => displayWidth(` ${part.kind === "budget" && part.figure.startsWith(`${part.name} `) ? part.figure.slice(part.name.length + 1) : part.figure}`))));
  const fit = (rowLabelWidth) => {
    const desired = context.appearance.barWidth;
    const minimum = Math.min(4, desired);
    if (columns() <= 0)
      return {
        barCells: desired,
        showReset: resetWidth() > 0
      };
    const room = columns() - rowLabelWidth - figureWidth();
    const withReset = room - resetWidth() - 1;
    const showReset = resetWidth() > 0 && withReset >= minimum;
    const available = showReset ? withReset : room;
    return {
      barCells: available >= minimum ? Math.min(desired, available) : 0,
      showReset
    };
  };
  const label = () => {
    const full = `${props.account.label}${props.account.titleSuffix ? ` \xB7 ${props.account.titleSuffix}` : ""}`;
    return columns() <= 0 ? full : fitText(full, columns() - displayWidth(props.account.status.text) - 1);
  };
  const age = () => quotaWindowParts(props.account.quota, {
    now: context.now
  }).age;
  const hasRows = () => props.account.groups.some((group) => group.rows.length > 0);
  return (() => {
    var _el$28 = _$createElement("box"), _el$29 = _$createElement("box"), _el$30 = _$createElement("text"), _el$31 = _$createElement("b"), _el$32 = _$createElement("text"), _el$33 = _$createElement("b");
    _$insertNode(_el$28, _el$29);
    _$use((element) => {
      block = element;
    }, _el$28);
    _$setProp(_el$28, "onSizeChange", () => setColumns(block?.width ?? 0));
    _$setProp(_el$28, "width", "100%");
    _$setProp(_el$28, "flexDirection", "column");
    _$insertNode(_el$29, _el$30);
    _$insertNode(_el$29, _el$32);
    _$setProp(_el$29, "width", "100%");
    _$setProp(_el$29, "flexDirection", "row");
    _$setProp(_el$29, "justifyContent", "space-between");
    _$setProp(_el$29, "columnGap", 1);
    _$insertNode(_el$30, _el$31);
    _$setProp(_el$30, "wrapMode", "none");
    _$setProp(_el$30, "flexShrink", 1);
    _$insert(_el$31, label);
    _$insertNode(_el$32, _el$33);
    _$setProp(_el$32, "wrapMode", "none");
    _$setProp(_el$32, "flexShrink", 0);
    _$insert(_el$33, () => props.account.status.text);
    _$insert(_el$28, () => context.beforeQuota?.(props.account), null);
    _$insert(_el$28, _$createComponent(Show, {
      get when() {
        return hasRows();
      },
      get fallback() {
        return _$createComponent(SidebarTextRow, {
          get text() {
            return props.account.emptyQuotaText?.expanded ?? "\u2014";
          },
          wrapMode: "none"
        });
      },
      get children() {
        return _$createComponent(For, {
          get each() {
            return props.account.groups;
          },
          children: (group) => [_$createComponent(Show, {
            get when() {
              return group.title;
            },
            get children() {
              return _$createComponent(SidebarTextRow, {
                get text() {
                  return group.title ?? "";
                },
                tone: "text",
                wrapMode: "none"
              });
            }
          }), _$createComponent(For, {
            get each() {
              return group.rows;
            },
            children: (row) => {
              const rowLabelWidth = () => row.part.name ? labelWidth() : 0;
              const rowFit = createMemo(() => fit(rowLabelWidth()));
              return _$createComponent(QuotaRow, {
                get part() {
                  return row.part;
                },
                get pace() {
                  return row.pace;
                },
                get labelWidth() {
                  return rowLabelWidth();
                },
                get barCells() {
                  return rowFit().barCells;
                },
                get resetWidth() {
                  return resetWidth();
                },
                get showReset() {
                  return rowFit().showReset;
                }
              });
            }
          })]
        });
      }
    }), null);
    _$insert(_el$28, _$createComponent(Show, {
      get when() {
        return age();
      },
      children: (text) => _$createComponent(SidebarTextRow, {
        get text() {
          return text();
        },
        wrapMode: "none"
      })
    }), null);
    _$insert(_el$28, () => context.afterQuota?.(props.account), null);
    _$effect((_p$) => {
      var _v$9 = props.marginTop, _v$0 = context.theme.text, _v$1 = context.theme[props.account.status.tone];
      _v$9 !== _p$.e && (_p$.e = _$setProp(_el$28, "marginTop", _v$9, _p$.e));
      _v$0 !== _p$.t && (_p$.t = _$setProp(_el$30, "fg", _v$0, _p$.t));
      _v$1 !== _p$.a && (_p$.a = _$setProp(_el$32, "fg", _v$1, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$28;
  })();
}
function SidebarFrame(props) {
  const hasData = () => props.accounts.length > 0;
  const headerLabel = () => !hasData() ? props.header.badge : `${props.collapsed ? "\u25B6" : "\u25BC"} ${props.header.badge}`;
  const context = mergeProps(props, {
    get theme() {
      const theme = props.theme;
      return {
        ...theme,
        textMuted: theme?.textMuted ?? theme?.text,
        accent: theme?.accent ?? theme?.text,
        success: theme?.success ?? theme?.text,
        warning: theme?.warning ?? theme?.text,
        error: theme?.error ?? theme?.text
      };
    }
  });
  const invertBadge = () => props.theme?.accent !== undefined && props.theme?.background !== undefined;
  return _$createComponent(FrameContext.Provider, {
    value: context,
    get children() {
      var _el$34 = _$createElement("box"), _el$35 = _$createElement("box"), _el$36 = _$createElement("box"), _el$37 = _$createElement("text"), _el$38 = _$createElement("b");
      _$insertNode(_el$34, _el$35);
      _$setProp(_el$34, "width", "100%");
      _$setProp(_el$34, "flexDirection", "column");
      _$insertNode(_el$35, _el$36);
      _$setProp(_el$35, "width", "100%");
      _$setProp(_el$35, "flexDirection", "row");
      _$setProp(_el$35, "justifyContent", "space-between");
      _$setProp(_el$35, "alignItems", "center");
      _$setProp(_el$35, "onMouseDown", () => {
        if (hasData())
          props.onToggle();
      });
      _$insertNode(_el$36, _el$37);
      _$setProp(_el$36, "paddingLeft", 1);
      _$setProp(_el$36, "paddingRight", 1);
      _$insertNode(_el$37, _el$38);
      _$insert(_el$38, headerLabel);
      _$insert(_el$35, _$createComponent(Show, {
        get when() {
          return props.header.version;
        },
        get children() {
          var _el$39 = _$createElement("text");
          _$insert(_el$39, () => props.header.version);
          _$effect((_$p) => _$setProp(_el$39, "fg", context.theme.textMuted, _$p));
          return _el$39;
        }
      }), null);
      _$insert(_el$34, _$createComponent(Show, {
        get when() {
          return _$memo(() => !!props.collapsed)() && hasData();
        },
        get children() {
          return [_$createComponent(For, {
            get each() {
              return props.accounts;
            },
            children: (account) => _$createComponent(CollapsedAccountRow, {
              account
            })
          }), _$memo(() => props.collapsedSections?.())];
        }
      }), null);
      _$insert(_el$34, _$createComponent(Show, {
        get when() {
          return !props.collapsed || !hasData();
        },
        get children() {
          return [_$createComponent(Show, {
            get when() {
              return _$memo(() => !!props.showQuota)() && hasData();
            },
            get children() {
              return _$createComponent(SidebarSection, {
                title: "Quota",
                get children() {
                  return _$createComponent(For, {
                    get each() {
                      return props.accounts;
                    },
                    children: (account, index) => _$createComponent(AccountBlock, {
                      account,
                      get marginTop() {
                        return index() === 0 ? 0 : 1;
                      }
                    })
                  });
                }
              });
            }
          }), _$memo(() => props.sections?.())];
        }
      }), null);
      _$effect((_p$) => {
        var _v$10 = invertBadge() ? props.theme?.accent : undefined, _v$11 = invertBadge() ? props.theme?.background : context.theme.accent;
        _v$10 !== _p$.e && (_p$.e = _$setProp(_el$36, "backgroundColor", _v$10, _p$.e));
        _v$11 !== _p$.t && (_p$.t = _$setProp(_el$37, "fg", _v$11, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$34;
    }
  });
}
export {
  SidebarFrame,
  SidebarSection,
  SidebarStatRow,
  SidebarTextRow
};
