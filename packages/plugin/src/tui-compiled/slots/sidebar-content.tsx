import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */

import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "opentui:runtime-module:solid-js";
import packageJson from "../../../package.json";
import { formatThresholdPercent } from "../../shared/format-threshold";
import { computeEffectiveOrder, DEFAULT_PREFS, DEFAULT_SLOT_ORDER, PLUGIN_KEY, queueTuiPreferenceUpdate, readTuiPreferencesFile, readTuiPreferencesFileSync, resolveMagicContextPrefs, watchTuiPreferences } from "../../shared/tui-preferences";
import { renderUserFacingFailure } from "../../shared/user-facing-codes";
import { badgeTextColor } from "../badge-contrast";
import { compactionOffSidebarRows } from "../compaction-off";
import { loadSidebarSnapshot } from "../data/context-db";
import { createRefreshScheduler } from "../data/refresh-scheduler";
import { directoryForSession } from "../data/session-directory";
import { SidebarFrame, SidebarGaugeRow, SidebarSection, SidebarStatRow, SidebarTextRow } from "../quota-sidebar.js";

// Recomp commands do not send parent-session message events.
let activeRecompPollKick = null;
let activeSidebarRefresh = null;
export function kickRecompProgressRefresh() {
  activeRecompPollKick?.();
}

/** Ask the mounted sidebar to fetch an out-of-band status update now. */
export function refreshSidebarSnapshot() {
  activeSidebarRefresh?.();
}
// The controller outlives slot remounts, so preference changes survive a switch
// from the main session to a subagent view and back.
function createSidebarController(initialPrefs) {
  const [prefs, setPrefs] = createSignal(initialPrefs);
  const seedCollapsed = initialPrefs.rememberCollapsed && initialPrefs.collapsed != null ? initialPrefs.collapsed : initialPrefs.startCollapsed;
  const [collapsed, setCollapsed] = createSignal(seedCollapsed);
  let lastPersistedCollapsed = initialPrefs.collapsed;
  let lastApplied = JSON.stringify(initialPrefs);
  const stopWatchingPreferences = watchTuiPreferences(() => {
    void (async () => {
      const next = resolveMagicContextPrefs(await readTuiPreferencesFile());
      const serialized = JSON.stringify(next);
      if (serialized === lastApplied) return;
      lastApplied = serialized;
      setPrefs(next);
      // Ignore the file watcher's echo after a local preference write.
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
  return String(Math.round(value));
}
function relativeTime(ms) {
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""} ago`;
  return `${hours}h ago`;
}
function modelName(model) {
  if (!model) return "—";
  const id = model.split("/").pop() ?? model;
  return id.replace(/-(\d{8})$/, "").split("-").map(word => {
    if (/^deepseek$/i.test(word)) return "DeepSeek";
    if (/^gpt$/i.test(word)) return "GPT";
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ");
}
function shortText(text) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 32 ? `${line.slice(0, 31)}…` : line;
}
function present(value) {
  return typeof value === "number" && Number.isFinite(value);
}
const SidebarContent = props => {
  const [snapshot, setSnapshot] = createSignal(null);
  const sections = () => props.controller.prefs().sections;
  const headerLabel = () => {
    const label = props.controller.prefs().header.label;
    return label === DEFAULT_PREFS.header.label ? "MAGIC CONTEXT" : label;
  };
  const scheduler = createRefreshScheduler({
    read: async () => {
      const sid = props.sessionID();
      if (!sid) return null;
      const directory = directoryForSession(props.api.state.session?.get?.(sid)?.directory, props.api.state.path.directory ?? "");
      return loadSidebarSnapshot(sid, directory, {
        throwOnFailure: true
      });
    },
    onSnapshot: data => {
      setSnapshot(data);
      try {
        props.api.renderer.requestRender();
      } catch {
        // The renderer can close before the request completes.
      }
    },
    isRunning: data => Boolean(data?.historianRunning || data?.dreamerProgress || data?.recompProgress?.phase === "recomp" || data?.recompProgress?.phase === "migration")
  });
  const refresh = () => scheduler.refresh();
  const scheduleRefresh = () => scheduler.event();
  activeRecompPollKick = refresh;
  activeSidebarRefresh = refresh;
  onCleanup(() => {
    scheduler.dispose();
    if (activeRecompPollKick === refresh) activeRecompPollKick = null;
    if (activeSidebarRefresh === refresh) activeSidebarRefresh = null;
  });
  createEffect(on(props.sessionID, () => {
    setSnapshot(null);
    scheduler.reset();
  }));
  createEffect(on(props.sessionID, sessionID => {
    const unsubs = [props.api.event.on("message.updated", event => {
      if (event.properties.info.sessionID === sessionID) scheduleRefresh();
    }), props.api.event.on("session.updated", event => {
      if (event.properties.info.id === sessionID) scheduleRefresh();
    }), props.api.event.on("message.removed", event => {
      if (event.properties.sessionID === sessionID) scheduleRefresh();
    })];
    onCleanup(() => {
      for (const unsub of unsubs) unsub();
    });
  }, {
    defer: false
  }));
  const s = snapshot;
  const compactionOff = () => s()?.compaction_enabled === false;
  const tokenValue = () => {
    const data = s();
    return data && present(data.inputTokens) && data.contextLimit > 0 ? `${compactTokens(data.inputTokens)}/${compactTokens(data.contextLimit)}` : "—";
  };
  const contextUsage = () => {
    const data = s();
    if (compactionOff() && present(data?.native_context_usage_percentage)) return data.native_context_usage_percentage;
    if (!data || data.contextLimit <= 0) return undefined;
    return compactionOff() ? data.inputTokens / data.contextLimit * 100 : present(data.usagePercentage) ? data.usagePercentage : undefined;
  };
  const nextSummary = () => {
    const data = s();
    if (!data || !present(data.proactiveFloor) || !present(data.usagePercentage) || !present(data.inputTokens) || data.contextLimit <= 0) return "—";
    if (data.usagePercentage >= data.proactiveFloor) return "due";
    const remaining = Math.max(0, data.contextLimit * data.proactiveFloor / 100 - data.inputTokens);
    return `at ${formatThresholdPercent(data.proactiveFloor)}% · +${compactTokens(remaining)}`;
  };
  const values = createMemo(() => {
    const data = s();
    const run = data?.historianRun;
    const cacheAt = data?.cachedM0MaterializedAt;
    const drops = data?.queuedDropTokens;
    const lastDream = data?.lastDreamerRunAt;
    return {
      lastRun: run ? `${relativeTime(run.finishedAt)} · ${run.outcome}` : "—",
      model: modelName(run?.model),
      waiting: present(data?.waitingMessages) ? `${data?.waitingMessages} msgs` : "no reading",
      cacheBuilt: present(cacheAt) ? relativeTime(cacheAt) : "—",
      sinceThen: present(data?.summariesSinceCache) && present(data?.memoriesSinceCache) ? `${data?.summariesSinceCache} summaries · ${data?.memoriesSinceCache} memories` : "—",
      drops: present(data?.queuedDropCount) ? present(drops) ? `${data?.queuedDropCount} · ≈${compactTokens(drops)} at rebuild` : `${data?.queuedDropCount} · no reading` : "—",
      memories: present(data?.memoryCount) ? `${data?.memoryCount} · ${present(data?.memoriesSinceCache) ? data?.memoriesSinceCache : "—"} new` : "—",
      notes: present(data?.sessionNoteCount) && present(data?.readySmartNoteCount) ? `${data?.sessionNoteCount} · ${data?.readySmartNoteCount} smart waiting` : "—",
      dreamerLastRun: present(lastDream) ? `${relativeTime(lastDream)} · ${data?.dreamerFailures?.length ? "failed" : "ok"}` : "—",
      nativeRows: data ? compactionOffSidebarRows(data).filter(row => row.label === "Memories" ? sections().memory : sections().status) : []
    };
  });
  const progress = () => {
    const p = s()?.recompProgress;
    return p?.phase === "recomp" || p?.phase === "migration" ? p : undefined;
  };
  const progressLabel = () => ({
    recomp: "Recomp",
    upgrade: "Upgrade",
    embed: "Embed",
    wrapup: "Wrap-up"
  })[progress()?.kind ?? "recomp"];
  const progressValue = () => {
    const p = progress();
    return p && p.totalMessages > 0 ? `${Math.round(Math.max(0, Math.min(1, p.processedMessages / p.totalMessages)) * 100)}%` : "no reading";
  };
  const healthRows = createMemo(() => {
    const data = s();
    const rows = [];
    if (!data) return rows;
    const historian = data.historianRun;
    if (!compactionOff()) {
      const counts = historian?.sinceLastClean;
      if (counts && counts.primaryRejections > 0) rows.push({
        label: "Historian",
        value: `${modelName(historian?.primaryModel).split(" ")[0]} ${counts.primaryRejections}/${counts.primaryAttempts} rejected`,
        tone: "warning"
      });
      if (counts && counts.fallbackRuns > 0) rows.push({
        label: "Fallback",
        value: `finished ${counts.fallbackRuns} runs`,
        tone: "warning"
      });
      if (historian?.outcome === "failed" || (data.historianFailureCount ?? 0) > 0) rows.push({
        label: "Historian",
        value: "last run failed",
        tone: "error"
      });
    }
    if (data.dreamerFailures?.length) rows.push({
      label: "Dreamer",
      value: `${data.dreamerFailures.length} tasks failed`,
      tone: "warning"
    });
    const rebuild = data.recompProgress;
    if (rebuild?.phase === "failed" || rebuild?.phase === "skipped") {
      const verb = {
        recomp: "Recomp",
        upgrade: "Upgrade",
        embed: "Embed",
        wrapup: "Wrap-up"
      }[rebuild.kind ?? "recomp"];
      rows.push({
        label: verb,
        value: rebuild.phase === "failed" ? `✗ ${verb} failed` : "stopped",
        tone: rebuild.phase === "failed" ? "error" : "warning"
      });
    }
    if (data.lastTransformError) rows.push({
      label: "Transform",
      value: shortText(data.lastTransformError),
      tone: "error"
    });
    for (const limitation of data.hostLimitations ?? []) rows.push({
      label: "Host",
      value: shortText(renderUserFacingFailure(limitation, "plain")),
      tone: "warning"
    });
    if (data.configReloadFailure) rows.push({
      label: "Config",
      value: "reload failed",
      tone: "warning"
    });
    return rows;
  });
  const collapsedContext = () => {
    const used = contextUsage();
    return present(used) ? `${Math.round(100 - Math.max(0, Math.min(100, used)))}% left ●` : "no reading ●";
  };
  const collapsedHistorian = () => {
    const data = s();
    if (!data) return "no reading ●";
    const run = data.historianRun;
    const state = run?.outcome === "failed" || run?.outcome === "fallback" ? run.outcome : data.historianRunning || data.compartmentInProgress ? "summarizing" : "idle";
    return `${state}${run ? ` · ${relativeTime(run.finishedAt).replace(/ ago$/, "")}` : ""} ●`;
  };
  return _$createComponent(SidebarFrame, {
    get header() {
      return {
        badge: headerLabel(),
        version: `v${packageJson.version}`
      };
    },
    accounts: [],
    showQuota: false,
    get theme() {
      return {
        text: props.theme.text,
        textMuted: props.theme.textMuted,
        accent: props.theme.accent,
        success: props.theme.success,
        warning: props.theme.warning,
        error: props.theme.error,
        background: badgeTextColor(props.theme.accent, props.theme.background),
        borderActive: props.theme.borderActive
      };
    },
    appearance: {
      barWidth: 10,
      barFilledChar: "█",
      barEmptyChar: "░",
      warnThreshold: 65,
      errorThreshold: 85
    },
    get now() {
      return Date.now();
    },
    collapsible: true,
    get collapsed() {
      return props.controller.collapsed();
    },
    get onToggle() {
      return props.controller.toggleCollapsed;
    },
    collapsedSections: () => [_$createComponent(SidebarStatRow, {
      label: "Context",
      get value() {
        return collapsedContext();
      }
    }), _$createComponent(Show, {
      get when() {
        return _$memo(() => !!!compactionOff())() && sections().historian;
      },
      get children() {
        return _$createComponent(SidebarStatRow, {
          label: "Historian",
          get value() {
            return collapsedHistorian();
          }
        });
      }
    }), _$createComponent(Show, {
      get when() {
        return _$memo(() => !!!compactionOff())() && sections().status;
      },
      get children() {
        return _$createComponent(SidebarStatRow, {
          label: "Cache",
          get value() {
            return _$memo(() => !!present(s()?.queuedDropCount))() ? `${s()?.queuedDropCount} drops queued ●` : "no reading ●";
          }
        });
      }
    }), _$createComponent(Show, {
      get when() {
        return healthRows().length > 0;
      },
      get children() {
        return _$createComponent(SidebarStatRow, {
          label: "Health",
          get value() {
            return `${healthRows().length} ${healthRows().length === 1 ? "issue" : "issues"} ●`;
          },
          get tone() {
            return healthRows().some(row => row.tone === "error") ? "error" : "warning";
          }
        });
      }
    })],
    sections: () => [_$createComponent(SidebarSection, {
      title: "Context",
      get children() {
        return [_$createComponent(SidebarGaugeRow, {
          label: "ctx",
          get used() {
            return contextUsage();
          },
          get value() {
            return tokenValue();
          },
          get warnAt() {
            return _$memo(() => !!compactionOff())() ? 100 : s()?.executeThreshold;
          },
          get errorAt() {
            return compactionOff() ? 100 : 85;
          }
        }), _$createComponent(Show, {
          get when() {
            return !compactionOff();
          },
          get fallback() {
            return _$createComponent(SidebarTextRow, {
              text: "native compaction"
            });
          },
          get children() {
            return _$createComponent(SidebarStatRow, {
              label: "Next summary",
              get value() {
                return nextSummary();
              }
            });
          }
        })];
      }
    }), _$createComponent(Show, {
      get when() {
        return _$memo(() => !!!compactionOff())() && sections().historian;
      },
      get children() {
        return _$createComponent(SidebarSection, {
          title: "History",
          get children() {
            return [_$createComponent(SidebarStatRow, {
              label: "Historian",
              get value() {
                return _$memo(() => !!s())() ? s()?.historianRunning || s()?.compartmentInProgress ? "summarizing" : "idle" : "—";
              }
            }), _$createComponent(SidebarStatRow, {
              label: "Last run",
              get value() {
                return values().lastRun;
              }
            }), _$createComponent(SidebarStatRow, {
              label: "Model",
              get value() {
                return values().model;
              }
            }), _$createComponent(SidebarStatRow, {
              label: "Waiting",
              get value() {
                return values().waiting;
              }
            }), _$createComponent(Show, {
              get when() {
                return progress();
              },
              get children() {
                return _$createComponent(SidebarStatRow, {
                  get label() {
                    return progressLabel();
                  },
                  get value() {
                    return progressValue();
                  }
                });
              }
            })];
          }
        });
      }
    }), _$createComponent(Show, {
      get when() {
        return _$memo(() => !!!compactionOff())() && sections().status;
      },
      get children() {
        return _$createComponent(SidebarSection, {
          title: "Prompt cache",
          get children() {
            return [_$createComponent(SidebarStatRow, {
              label: "Cache built",
              get value() {
                return values().cacheBuilt;
              }
            }), _$createComponent(SidebarStatRow, {
              label: "Since then",
              get value() {
                return values().sinceThen;
              }
            }), _$createComponent(SidebarStatRow, {
              label: "Queued drops",
              get value() {
                return values().drops;
              }
            })];
          }
        });
      }
    }), _$createComponent(Show, {
      get when() {
        return sections().memory || sections().status;
      },
      get children() {
        return _$createComponent(SidebarSection, {
          title: "Knowledge",
          get children() {
            return _$createComponent(Show, {
              get when() {
                return compactionOff();
              },
              get fallback() {
                return [_$createComponent(Show, {
                  get when() {
                    return sections().memory;
                  },
                  get children() {
                    return _$createComponent(SidebarStatRow, {
                      label: "Memories",
                      get value() {
                        return values().memories;
                      }
                    });
                  }
                }), _$createComponent(Show, {
                  get when() {
                    return sections().status;
                  },
                  get children() {
                    return _$createComponent(SidebarStatRow, {
                      label: "Notes",
                      get value() {
                        return values().notes;
                      }
                    });
                  }
                })];
              },
              get children() {
                return _$createComponent(For, {
                  get each() {
                    return values().nativeRows;
                  },
                  children: row => _$createComponent(SidebarStatRow, {
                    get label() {
                      return row.label;
                    },
                    get value() {
                      return row.value;
                    }
                  })
                });
              }
            });
          }
        });
      }
    }), _$createComponent(Show, {
      get when() {
        return sections().dreamer;
      },
      get children() {
        return _$createComponent(SidebarSection, {
          title: "Dreamer",
          get children() {
            return [_$createComponent(SidebarStatRow, {
              label: "Last run",
              get value() {
                return values().dreamerLastRun;
              }
            }), _$createComponent(Show, {
              get when() {
                return s()?.dreamerProgress;
              },
              children: p => _$createComponent(SidebarStatRow, {
                label: "Current",
                get value() {
                  return `${p().task} ${p().processed}/${p().total}`;
                }
              })
            })];
          }
        });
      }
    }), _$createComponent(Show, {
      get when() {
        return healthRows().length > 0;
      },
      get children() {
        return _$createComponent(SidebarSection, {
          title: "Health",
          get children() {
            return [_$createComponent(For, {
              get each() {
                return healthRows();
              },
              children: row => _$createComponent(SidebarStatRow, {
                get label() {
                  return row.label;
                },
                get value() {
                  return row.value;
                },
                get tone() {
                  return row.tone;
                }
              })
            }), _$createComponent(Show, {
              get when() {
                return s()?.recompProgress?.phase === "failed" || s()?.recompProgress?.phase === "skipped";
              },
              get children() {
                return _$createComponent(Show, {
                  get when() {
                    return s()?.recompProgress?.message;
                  },
                  get children() {
                    return _$createComponent(SidebarTextRow, {
                      get text() {
                        return s()?.recompProgress?.message ?? "";
                      }
                    });
                  }
                });
              }
            }), _$createComponent(SidebarTextRow, {
              text: "/ctx-status shows details"
            })];
          }
        });
      }
    })]
  });
};
export function createSidebarContentSlot(api) {
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