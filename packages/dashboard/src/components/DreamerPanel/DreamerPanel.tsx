import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  enqueueDream,
  formatDateTime,
  formatRelativeTime,
  getDreamQueue,
  getDreamRuns,
  getDreamState,
  getProjects,
} from "../../lib/api";
import type {
  DreamQueueEntry,
  DreamRun,
  DreamRunMemoryChanges,
  DreamRunTask,
  ProjectInfo,
} from "../../lib/types";

type ProjectRunGroup = {
  project: ProjectInfo | undefined;
  projectPath: string;
  runs: DreamRun[];
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTaskLabel(name: string): string {
  return name === "smart-notes" ? "smart notes" : name;
}

function formatTaskOutput(task: DreamRunTask, run: DreamRun): string {
  if (task.name === "smart-notes") {
    return `${run.smart_notes_surfaced} surfaced, ${run.smart_notes_pending} pending`;
  }
  return `${task.resultChars.toLocaleString()} chars`;
}

function getProjectLabel(project: ProjectInfo | undefined, projectPath: string): string {
  if (project) return project.label;
  if (projectPath.startsWith("git:")) return `${projectPath.slice(0, 14)}…`;
  const segments = projectPath.split("/").filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] ?? "") : projectPath;
}

function hasMemoryChanges(changes: DreamRunMemoryChanges | null): changes is DreamRunMemoryChanges {
  if (!changes) return false;
  return Object.values(changes).some((value) => (value ?? 0) > 0);
}

export default function DreamerPanel() {
  const [queue, { refetch: refetchQueue }] = createResource(getDreamQueue);
  const [state, { refetch: refetchState }] = createResource(getDreamState);
  const [projects] = createResource(getProjects);
  const [runs, { refetch: refetchRuns }] = createResource(() => getDreamRuns(undefined, 50));
  const [expandedProjects, setExpandedProjects] = createSignal<Set<string>>(new Set());

  /** Extract project identities from dream state `last_dream_at:<identity>` keys. */
  const knownProjectIds = () => {
    const s = state() ?? [];
    return s
      .filter((e) => e.key.startsWith("last_dream_at:"))
      .map((e) => e.key.replace("last_dream_at:", ""));
  };

  const handleRunNow = async () => {
    let ids = knownProjectIds();
    if (ids.length === 0) {
      ids = (projects() ?? []).map((p) => p.identity);
    }
    if (ids.length === 0) return;
    for (const id of ids) {
      await enqueueDream(id, "Manual trigger from dashboard");
    }
    refetchQueue();
  };

  const refreshAll = () => {
    refetchQueue();
    refetchState();
    refetchRuns();
  };

  const leaseState = () => {
    const s = state() ?? [];
    const leaseEntry = s.find((e) => e.key === "dreaming_lease_holder");
    const lastRunEntry = s.find((e) => e.key === "last_dream_at");
    return {
      leaseHolder: leaseEntry?.value ?? "none",
      lastRunTime: lastRunEntry?.value ?? null,
    };
  };

  const pendingQueue = () => (queue() ?? []).filter((e) => !e.started_at);
  const completedQueue = () => (queue() ?? []).filter((e) => e.started_at);
  const latestRecordedRun = createMemo(() => {
    const allRuns = runs() ?? [];
    return allRuns.length > 0 ? allRuns[0] : null;
  });

  const groupedRuns = createMemo<ProjectRunGroup[]>(() => {
    const projectMap = new Map((projects() ?? []).map((project) => [project.identity, project]));
    const groups = new Map<string, DreamRun[]>();

    for (const run of runs() ?? []) {
      const existing = groups.get(run.project_path);
      if (existing) {
        existing.push(run);
      } else {
        groups.set(run.project_path, [run]);
      }
    }

    return [...groups.entries()]
      .map(([projectPath, projectRuns]) => ({
        projectPath,
        project: projectMap.get(projectPath),
        runs: projectRuns.sort((left, right) => right.finished_at - left.finished_at),
      }))
      .sort((left, right) => (right.runs[0]?.finished_at ?? 0) - (left.runs[0]?.finished_at ?? 0));
  });

  const toggleProject = (projectPath: string) => {
    setExpandedProjects((previous) => {
      const next = new Set(previous);
      if (next.has(projectPath)) {
        next.delete(projectPath);
      } else {
        next.add(projectPath);
      }
      return next;
    });
  };

  const isExpanded = (projectPath: string) => expandedProjects().has(projectPath);

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Dreamer</h1>
        <div class="section-actions">
          <button type="button" class="btn primary sm" onClick={handleRunNow}>
            ▶ Run Now
          </button>
          <button type="button" class="btn sm" onClick={refreshAll}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div style={{ padding: "0 20px 12px" }}>
        <div class="stat-banner">
          <div class="stat-item">
            <span class="stat-label">State</span>
            <span class="stat-value">
              {leaseState().leaseHolder === "none" ? "idle" : "running"}
            </span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Lease</span>
            <span class="stat-value">{leaseState().leaseHolder}</span>
          </div>
          <Show when={leaseState().lastRunTime}>
            <div class="stat-item">
              <span class="stat-label">Last Run</span>
              <span class="stat-value">
                {(() => {
                  const v = leaseState().lastRunTime;
                  if (!v) return "—";
                  const n = Number(v);
                  return !Number.isNaN(n) && n > 1e12
                    ? `${formatRelativeTime(n)} · ${formatDateTime(n)}`
                    : v;
                })()}
              </span>
            </div>
          </Show>
          <Show when={!leaseState().lastRunTime && latestRecordedRun()}>
            <div class="stat-item">
              <span class="stat-label">Last Run</span>
              <span class="stat-value">{`${formatRelativeTime(latestRecordedRun()?.finished_at ?? 0)} · ${formatDateTime(latestRecordedRun()?.finished_at ?? 0)}`}</span>
            </div>
          </Show>
          <div class="stat-item">
            <span class="stat-label">Queue</span>
            <span class="stat-value">{pendingQueue().length} pending</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Projects</span>
            <span class="stat-value">{groupedRuns().length}</span>
          </div>
        </div>
      </div>

      <div class="scroll-area">
        <Show when={pendingQueue().length > 0}>
          <div class="category-header">
            Queue <span class="category-count">({pendingQueue().length})</span>
          </div>
          <div class="list-gap" style={{ "margin-bottom": "16px" }}>
            <For each={pendingQueue()}>
              {(entry: DreamQueueEntry) => (
                <div class="card">
                  <div class="card-title">
                    <span class="pill amber">pending</span>
                    <span style={{ "margin-left": "8px" }}>{entry.reason}</span>
                  </div>
                  <div class="card-meta">
                    <span>Project: {entry.project_path}</span>
                    <span>·</span>
                    <span>Queued: {formatRelativeTime(entry.enqueued_at)}</span>
                    <Show when={entry.retry_count > 0}>
                      <span>· Retries: {entry.retry_count}</span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={!runs.loading}
          fallback={<div class="empty-state">Loading dream history...</div>}
        >
          <Show
            when={groupedRuns().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">🌙</span>
                <span>No dream runs yet</span>
                <span style={{ "font-size": "11px" }}>
                  Run the dreamer to start building project history.
                </span>
              </div>
            }
          >
            <div class="category-header">
              Run History <span class="category-count">({groupedRuns().length})</span>
            </div>
            <div class="list-gap">
              <For each={groupedRuns()}>
                {(group) => {
                  const latestRun = () => group.runs[0];
                  const latestDuration = () => {
                    const run = latestRun();
                    return run ? formatDuration(run.finished_at - run.started_at) : "—";
                  };

                  return (
                    <div class="card dream-run-card">
                      <button
                        type="button"
                        class="dream-run-header"
                        onClick={() => toggleProject(group.projectPath)}
                      >
                        <div>
                          <div class="dream-run-title-row">
                            <span class="card-title" style={{ margin: 0 }}>
                              {getProjectLabel(group.project, group.projectPath)}
                            </span>
                            <span class="pill blue">
                              {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          <div class="card-meta" style={{ "margin-top": "4px" }}>
                            <span>Last run: {formatRelativeTime(latestRun()?.finished_at)}</span>
                            <span>·</span>
                            <span>{formatDateTime(latestRun()?.finished_at)}</span>
                            <span>·</span>
                            <span>Duration: {latestDuration()}</span>
                            <Show
                              when={
                                group.projectPath !==
                                getProjectLabel(group.project, group.projectPath)
                              }
                            >
                              <span>·</span>
                              <span class="mono">{group.projectPath}</span>
                            </Show>
                          </div>
                        </div>
                        <span class="dream-run-chevron">
                          {isExpanded(group.projectPath) ? "▾" : "▸"}
                        </span>
                      </button>

                      <Show when={isExpanded(group.projectPath)}>
                        <div class="dream-run-history">
                          <For each={group.runs}>
                            {(run) => (
                              <section class="dream-run-detail">
                                <div class="dream-run-detail-header">
                                  <div>
                                    <div class="dream-run-detail-title">
                                      {formatRelativeTime(run.finished_at)}
                                    </div>
                                    <div class="card-meta">
                                      <span>{formatDateTime(run.finished_at)}</span>
                                      <span>·</span>
                                      <span>
                                        {formatDuration(run.finished_at - run.started_at)}
                                      </span>
                                      <span>·</span>
                                      <span>{run.tasks_succeeded} succeeded</span>
                                      <Show when={run.tasks_failed > 0}>
                                        <span style={{ color: "var(--red)" }}>
                                          {run.tasks_failed} failed
                                        </span>
                                      </Show>
                                    </div>
                                  </div>
                                  <span class={`pill ${run.tasks_failed > 0 ? "red" : "green"}`}>
                                    {run.tasks_failed > 0 ? "issues" : "ok"}
                                  </span>
                                </div>

                                <table class="dream-run-table">
                                  <thead>
                                    <tr>
                                      <th>Task</th>
                                      <th>Duration</th>
                                      <th>Output</th>
                                      <th>Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <For each={run.tasks_json}>
                                      {(task) => (
                                        <tr>
                                          <td>{formatTaskLabel(task.name)}</td>
                                          <td class="mono">{formatDuration(task.durationMs)}</td>
                                          <td class="mono">{formatTaskOutput(task, run)}</td>
                                          <td>
                                            <span
                                              class={`dream-run-status ${task.error ? "error" : "success"}`}
                                            >
                                              {task.error ? "✕" : "✓"}
                                            </span>
                                          </td>
                                        </tr>
                                      )}
                                    </For>
                                  </tbody>
                                </table>

                                <Show when={hasMemoryChanges(run.memory_changes_json)}>
                                  <div class="dream-run-memory-section">
                                    <div class="dream-run-memory-title">Memory Changes</div>
                                    <div class="dream-run-memory-grid">
                                      <Show when={(run.memory_changes_json?.written ?? 0) > 0}>
                                        <div class="dream-run-memory-pill">
                                          <span>written</span>
                                          <strong>{run.memory_changes_json?.written}</strong>
                                        </div>
                                      </Show>
                                      <Show when={(run.memory_changes_json?.deleted ?? 0) > 0}>
                                        <div class="dream-run-memory-pill">
                                          <span>deleted</span>
                                          <strong>{run.memory_changes_json?.deleted}</strong>
                                        </div>
                                      </Show>
                                      <Show when={(run.memory_changes_json?.archived ?? 0) > 0}>
                                        <div class="dream-run-memory-pill">
                                          <span>archived</span>
                                          <strong>{run.memory_changes_json?.archived}</strong>
                                        </div>
                                      </Show>
                                      <Show when={(run.memory_changes_json?.merged ?? 0) > 0}>
                                        <div class="dream-run-memory-pill">
                                          <span>merged</span>
                                          <strong>{run.memory_changes_json?.merged}</strong>
                                        </div>
                                      </Show>
                                    </div>
                                  </div>
                                </Show>
                              </section>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>

        <Show when={completedQueue().length > 0}>
          <div class="category-header" style={{ "margin-top": "16px" }}>
            Queue History <span class="category-count">({completedQueue().length})</span>
          </div>
          <div class="list-gap">
            <For each={completedQueue()}>
              {(entry: DreamQueueEntry) => (
                <div class="card">
                  <div class="card-title">
                    <span class="pill green">completed</span>
                    <span style={{ "margin-left": "8px" }}>{entry.reason}</span>
                  </div>
                  <div class="card-meta">
                    <span>Project: {entry.project_path}</span>
                    <span>·</span>
                    <span>Started: {formatRelativeTime(entry.started_at ?? 0)}</span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={
            (queue() ?? []).length === 0 &&
            (state() ?? []).length === 0 &&
            (runs() ?? []).length === 0
          }
        >
          <div class="empty-state">
            <span class="empty-state-icon">🌙</span>
            <span>No dreamer activity</span>
            <span style={{ "font-size": "11px" }}>Click "Run Now" to queue a dream task.</span>
          </div>
        </Show>
      </div>
    </>
  );
}
