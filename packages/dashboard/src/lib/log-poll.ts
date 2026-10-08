import { livePollDue } from "./live-poll";

/** The Log view keeps its foreground 3s cadence, but shares Cache's idle policy. */
export function createLogPoll(
  state: () => { hidden: boolean; focused: boolean; paused: boolean; loading: boolean },
  refresh: () => Promise<unknown>,
) {
  let inFlight = false;
  let ticksSinceRefresh = 0;
  let refreshOnReturn = false;

  return async function tick(force = false): Promise<void> {
    const current = state();
    if (current.hidden || current.paused) {
      refreshOnReturn = false;
      return;
    }
    refreshOnReturn ||= force;
    if (inFlight || current.loading) return;
    ticksSinceRefresh += 1;
    if (!refreshOnReturn && !livePollDue({ ...current, ticksSinceRefresh })) return;
    refreshOnReturn = false;
    ticksSinceRefresh = 0;
    inFlight = true;
    try {
      await refresh();
    } catch {
      // Transient file/IPC failures are retried on the next eligible tick.
    } finally {
      inFlight = false;
    }
    // A return event during a slow fetch gets one reconciliation, not a stack
    // of overlapping reads. Recheck visibility and pause before dispatching it.
    if (refreshOnReturn) await tick(true);
  };
}
