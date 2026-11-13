import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  applyWorkspaceChanges,
  formatDateTime,
  formatRelativeTime,
  getProjectCards,
  listWorkspaces,
} from "../../lib/api";
import type { ProjectCard, WorkspaceListItem } from "../../lib/types";
import HarnessBadge from "../HarnessBadge";
import ProjectCardMenu from "./ProjectCardMenu";
import { workspaceAssignmentPlan } from "./workspace-menu-options";

interface Props {
  onSelect: (project: ProjectCard) => void;
}

/** Top-level Projects view: a searchable card grid sorted by last activity. Each
 *  card drills into the project's detail (sessions / memories / dreamer / primers). */
export default function ProjectsGrid(props: Props) {
  const [cards, { refetch }] = createResource(getProjectCards);
  const [search, setSearch] = createSignal("");
  // null = the list could not be read; the menu says so instead of offering nothing.
  const [workspaces, { refetch: refetchWorkspaces }] = createResource(() =>
    listWorkspaces().catch(() => null),
  );
  const [menu, setMenu] = createSignal<{
    card: ProjectCard;
    anchor: HTMLElement;
    point: { x: number; y: number };
  } | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let grid: HTMLDivElement | undefined;

  const refreshAll = () => Promise.allSettled([refetch(), refetchWorkspaces()]);

  const assign = async (card: ProjectCard, picked: WorkspaceListItem) => {
    if (saving()) return;
    setSaving(true);
    setError(null);
    // One project, one workspace: a move leaves first. Run in order, never together.
    let plan: ReturnType<typeof workspaceAssignmentPlan> | null = null;
    let left = false;
    try {
      // Plan from the list as it is now, not as the menu saw it: an earlier
      // save or another window may have changed membership since.
      const fresh = await listWorkspaces();
      const target = fresh.find((ws) => ws.id === picked.id);
      if (!target) throw new Error(`${picked.name} no longer exists.`);
      plan = workspaceAssignmentPlan(card, fresh, target);
      if (plan.leave?.workspaceId === target.id) return;
      if (plan.leave) {
        await applyWorkspaceChanges(plan.leave);
        left = true;
      }
      await applyWorkspaceChanges(plan.join);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      const reason = /[.!?]$/.test(raw.trim()) ? raw.trim() : `${raw.trim()}.`;
      let restored = false;
      if (left && plan?.restore) {
        restored = await applyWorkspaceChanges(plan.restore).then(
          () => true,
          () => false,
        );
      }
      setError(
        !left
          ? `Could not save: ${reason}`
          : restored
            ? `Could not move to ${picked.name}: ${reason} The project stays where it was.`
            : `Could not move to ${picked.name}: ${reason} It has left its old workspace and is now in none.`,
      );
    } finally {
      // Stay busy until the cards show the result, so the next menu plans from it.
      await refreshAll();
      setSaving(false);
      // The refreshed cards are new elements; give focus back to this card's.
      if (document.activeElement === document.body) {
        grid?.querySelector<HTMLElement>(`[data-identity="${CSS.escape(card.identity)}"]`)?.focus();
      }
    }
  };

  const openMenu = (event: MouseEvent, card: ProjectCard) => {
    event.preventDefault();
    if (saving()) return;
    refetchWorkspaces();
    setMenu({
      card,
      anchor: event.currentTarget as HTMLElement,
      point: { x: event.clientX, y: event.clientY },
    });
  };

  const openMenuFromKeyboard = (event: KeyboardEvent, card: ProjectCard) => {
    if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
    event.preventDefault();
    if (saving()) return;
    const anchor = event.currentTarget as HTMLElement;
    const rect = anchor.getBoundingClientRect();
    refetchWorkspaces();
    setMenu({ card, anchor, point: { x: rect.left + 16, y: rect.top + 32 } });
  };

  const filtered = createMemo<ProjectCard[]>(() => {
    const all = cards() ?? [];
    const q = search().trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (c) =>
        c.display_name.toLowerCase().includes(q) ||
        c.primary_path.toLowerCase().includes(q) ||
        c.identity.toLowerCase().includes(q) ||
        (c.workspace_name ?? "").toLowerCase().includes(q),
    );
  });

  return (
    <>
      <div class="section-header">
        <h1 class="section-title">Projects</h1>
        <div class="section-actions">
          <Show when={saving()}>
            <span role="status" style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
              Saving…
            </span>
          </Show>
          <Show when={cards()}>
            <span style={{ "font-size": "12px", color: "var(--text-secondary)" }}>
              {(cards() ?? []).length} tracked
            </span>
          </Show>
          <button type="button" class="btn sm" onClick={() => void refreshAll()}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div style={{ padding: "0 20px 12px" }}>
        <input
          class="search-input"
          type="text"
          placeholder="Search projects…"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          style={{ width: "100%" }}
        />
      </div>

      <Show when={error()}>
        {(message) => (
          <div style={{ padding: "0 20px 12px" }}>
            <div class="project-grid-error" role="alert">
              <span>{message()}</span>
              <button type="button" class="btn sm" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </Show>

      <div class="scroll-area">
        {/* Only the first load blanks the grid; a refresh keeps the cards in place. */}
        <Show
          when={cards.state !== "unresolved" && cards.state !== "pending"}
          fallback={<div class="empty-state">Loading projects…</div>}
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="empty-state">
                <span class="empty-state-icon">📁</span>
                <span>{search() ? "No projects match your search." : "No projects yet."}</span>
              </div>
            }
          >
            <div class="project-card-grid" ref={grid}>
              <For each={filtered()}>
                {(card) => (
                  <button
                    type="button"
                    class="card project-card"
                    data-identity={card.identity}
                    aria-busy={saving()}
                    onClick={() => {
                      if (saving()) return;
                      props.onSelect(card);
                    }}
                    onContextMenu={(e) => openMenu(e, card)}
                    onKeyDown={(e) => openMenuFromKeyboard(e, card)}
                  >
                    <div class="project-card-head">
                      <span class="project-card-name" title={card.primary_path || card.identity}>
                        {card.display_name}
                      </span>
                      <Show when={card.harnesses.length > 0}>
                        <span class="project-card-harnesses">
                          <For each={card.harnesses}>{(h) => <HarnessBadge harness={h} />}</For>
                        </span>
                      </Show>
                    </div>

                    <Show when={card.workspace_name}>
                      <div class="project-card-workspace">
                        <span class="pill indigo" title="workspace">
                          🗂 {card.workspace_name}
                        </span>
                      </div>
                    </Show>

                    <div class="project-card-stats">
                      <span class="project-card-stat">
                        <strong>{card.session_count}</strong> session
                        {card.session_count === 1 ? "" : "s"}
                      </span>
                      <span class="project-card-stat">
                        <strong>{card.memory_count}</strong> memor
                        {card.memory_count === 1 ? "y" : "ies"}
                      </span>
                    </div>

                    <div
                      class="project-card-active"
                      title={card.last_activity_ms ? formatDateTime(card.last_activity_ms) : ""}
                    >
                      {card.last_activity_ms
                        ? `active ${formatRelativeTime(card.last_activity_ms)}`
                        : "no activity"}
                    </div>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      {/* Keyed: the menu reads its card and anchor while closing, after menu() is null. */}
      <Show when={menu()} keyed>
        {(open) => (
          <ProjectCardMenu
            card={open.card}
            anchor={open.anchor}
            point={open.point}
            // The last list read while a refresh runs: the menu opens complete
            // instead of flickering through a loading state.
            workspaces={workspaces.latest}
            onPick={(card, target) => void assign(card, target)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </>
  );
}
