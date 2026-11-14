import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { ProjectCard, WorkspaceListItem } from "../../lib/types";
import FloatingLayer from "../shared/FloatingLayer";
import { projectWorkspaceMenu, type WorkspaceMenuTarget } from "./workspace-menu-options";

interface Props {
  card: ProjectCard;
  anchor: HTMLElement;
  point: { x: number; y: number };
  /** Undefined while loading; null when the list could not be read. */
  workspaces: WorkspaceListItem[] | null | undefined;
  onPick: (card: ProjectCard, target: WorkspaceListItem) => void;
  onClose: () => void;
}

/** A menu's own items, not those of a flyout nested inside it. */
const menuItems = (menu: HTMLElement | undefined) =>
  menu
    ? Array.from(
        menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
      ).filter((item) => item.parentElement?.closest('[role="menu"]') === menu)
    : [];

/** Move focus among a menu's items: arrows wrap, Home/End jump. Disabled items
 *  stay reachable so their reason is read out. */
function roveFocus(menu: HTMLElement | undefined, key: string): boolean {
  const items = menuItems(menu);
  if (items.length === 0) return false;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
  else if (key === "ArrowUp") next = at <= 0 ? items.length - 1 : at - 1;
  else if (key === "Home") next = 0;
  else if (key === "End") next = items.length - 1;
  else return false;
  items[next].focus();
  return true;
}

/** A status line inside the flyout. It is a disabled item rather than plain
 *  text so arrowing into the flyout lands on it and a screen reader says it. */
function MenuStatus(props: { text: string }) {
  return (
    <div role="menuitem" aria-disabled="true" tabIndex={-1} class="context-menu-note">
      {props.text}
    </div>
  );
}

/** Right-click menu on a project card: one entry that adds the project to a
 *  workspace, or moves it once it has one. */
export default function ProjectCardMenu(props: Props) {
  let rootMenu: HTMLDivElement | undefined;
  let entry: HTMLButtonElement | undefined;
  let submenu: HTMLDivElement | undefined;
  const [submenuOpen, setSubmenuOpen] = createSignal(false);
  const [submenuStyle, setSubmenuStyle] = createSignal<Record<string, string>>({});
  const reasonId = createUniqueId();

  const menu = () => projectWorkspaceMenu(props.card, props.workspaces);
  const entryDisabled = () => menu().disabledReason !== null;

  const openSubmenu = (focusFirst: boolean) => {
    if (entryDisabled()) return;
    setSubmenuOpen(true);
    if (focusFirst) menuItems(submenu)[0]?.focus();
  };
  const closeSubmenu = (refocusEntry: boolean) => {
    setSubmenuOpen(false);
    if (refocusEntry) entry?.focus();
  };

  // Flyout beside the entry; flip left or lift it when it would leave the window.
  createEffect(() => {
    // Re-measure when the targets change: they set the flyout's size.
    void menu().targets.length;
    if (!submenuOpen() || !submenu || !entry) return;
    const entryRect = entry.getBoundingClientRect();
    const width = submenu.offsetWidth;
    const height = submenu.offsetHeight;
    const flip = entryRect.right + width + 12 > window.innerWidth;
    const overflow = entryRect.top - 4 + height + 12 - window.innerHeight;
    setSubmenuStyle({
      ...(flip ? { left: "auto", right: "100%" } : {}),
      top: `${-4 - Math.max(0, overflow)}px`,
    });
  });

  // The flyout's content is replaced when the list arrives; if that took the
  // focused status line with it, hand focus to the first new item.
  createEffect(
    on(
      () => props.workspaces,
      () => {
        if (!submenuOpen() || !submenu || rootMenu?.contains(document.activeElement)) return;
        menuItems(submenu)[0]?.focus();
      },
      { defer: true },
    ),
  );

  onMount(() => {
    entry?.focus();
    // Native listener on the menu, so it runs before FloatingLayer's document
    // handler: Escape inside the flyout closes only the flyout.
    const keydown = (event: KeyboardEvent) => {
      const inSubmenu = submenu?.contains(event.target as Node) ?? false;
      if (event.key === "Tab") {
        event.preventDefault();
        props.onClose();
        props.anchor.focus();
        return;
      }
      if (inSubmenu) {
        if (event.key === "Escape" || event.key === "ArrowLeft") {
          event.preventDefault();
          event.stopPropagation();
          closeSubmenu(true);
          return;
        }
        if (roveFocus(submenu, event.key)) event.preventDefault();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        openSubmenu(true);
      } else if (roveFocus(rootMenu, event.key)) {
        event.preventDefault();
      }
    };
    rootMenu?.addEventListener("keydown", keydown);
    onCleanup(() => rootMenu?.removeEventListener("keydown", keydown));
  });

  const pick = (target: WorkspaceMenuTarget) => {
    if (target.disabledReason !== null) return;
    // Hand over the card before closing: closing unmounts this menu.
    props.onPick(props.card, target.workspace);
    props.onClose();
    props.anchor.focus();
  };

  return (
    <FloatingLayer
      anchor={props.anchor}
      point={props.point}
      onClose={props.onClose}
      class="context-menu"
    >
      <div
        role="menu"
        aria-label={`${props.card.display_name} actions`}
        ref={rootMenu}
        // The webview's own menu would otherwise open over ours.
        onContextMenu={(e) => e.preventDefault()}
      >
        <div class="context-menu-entry">
          <button
            type="button"
            role="menuitem"
            class="context-menu-item"
            ref={entry}
            aria-haspopup="menu"
            aria-expanded={submenuOpen()}
            aria-disabled={entryDisabled()}
            aria-describedby={entryDisabled() ? reasonId : undefined}
            onClick={() => (submenuOpen() ? closeSubmenu(false) : openSubmenu(true))}
            onPointerEnter={() => openSubmenu(false)}
          >
            <span>{menu().label}</span>
            <span class="context-menu-chevron" aria-hidden="true">
              ▸
            </span>
          </button>
          <Show when={submenuOpen()}>
            <div
              role="menu"
              aria-label={menu().label}
              class="context-menu context-menu-submenu"
              ref={submenu}
              style={submenuStyle()}
            >
              <Show
                when={props.workspaces !== undefined}
                fallback={<MenuStatus text="Loading workspaces…" />}
              >
                <Show
                  when={props.workspaces !== null}
                  fallback={<MenuStatus text="Workspaces could not be loaded." />}
                >
                  <Show
                    when={menu().targets.length > 0}
                    fallback={<MenuStatus text="No workspaces yet. Create one in Workspaces." />}
                  >
                    <For each={menu().targets}>
                      {(target) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          class="context-menu-item"
                          classList={{ current: target.current }}
                          aria-checked={target.current}
                          aria-disabled={target.disabledReason !== null}
                          title={target.disabledReason ?? undefined}
                          onClick={() => pick(target)}
                        >
                          <span class="context-menu-check" aria-hidden="true">
                            {target.current ? "✓" : ""}
                          </span>
                          <span class="context-menu-text">
                            <span class="context-menu-label">{target.workspace.name}</span>
                            <Show when={target.disabledReason !== null && !target.current}>
                              <span class="context-menu-hint">{target.disabledReason}</span>
                            </Show>
                          </span>
                        </button>
                      )}
                    </For>
                  </Show>
                </Show>
              </Show>
            </div>
          </Show>
        </div>
      </div>
      {/* Outside role="menu": a menu holds only items. The entry points here
          through aria-describedby. */}
      <Show when={menu().disabledReason}>
        {(reason) => (
          <div class="context-menu-note" id={reasonId}>
            {reason()}
          </div>
        )}
      </Show>
    </FloatingLayer>
  );
}
