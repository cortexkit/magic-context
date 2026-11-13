import { createEffect, createSignal, type JSX, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

/** Swallow the click that follows the pointerdown which closed a context menu,
 *  as native menus do. Lasts until that click, or until the next pointerdown or
 *  key press shows no click is coming. */
function swallowDismissClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  const stop = () => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerdown", stop, true);
    window.removeEventListener("keydown", stop, true);
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerdown", stop, true);
  window.addEventListener("keydown", stop, true);
}

/** Keep menus out of scroll containers and place them within the visible viewport.
 *
 *  By default the layer opens below (or above) `anchor` and is at least 320px
 *  wide. With `point` it opens at that viewport position instead, sized by its
 *  own content — the placement a context menu needs: the click that dismisses
 *  it does not reach what lies beneath, and scrolling the page closes it.
 *  `anchor` still counts as "inside" for outside-click handling and gets focus
 *  back on Esc. */
export default function FloatingLayer(props: {
  anchor: HTMLElement;
  point?: { x: number; y: number };
  onClose: () => void;
  children: JSX.Element;
  class?: string;
}) {
  let layer: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  createEffect(() => {
    const point = props.point;
    const placeAtAnchor = () => {
      const rect = props.anchor.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12;
      const height = Math.min(360, Math.max(below, rect.top - 12));
      const placeBelow = below >= Math.min(300, height);
      setPosition({
        position: "fixed",
        left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
        top: placeBelow ? `${rect.bottom + 4}px` : "auto",
        bottom: placeBelow ? "auto" : `${window.innerHeight - rect.top + 4}px`,
        width: `${width}px`,
        "max-height": `${height}px`,
        "z-index": 1000,
      });
    };
    const placeAtPoint = (at: { x: number; y: number }) => {
      // The point-mode class must itself be `position: fixed` with an intrinsic
      // width, so the content can be measured before any inline style lands.
      const width = layer?.offsetWidth ?? 0;
      const height = layer?.offsetHeight ?? 0;
      const fitsBelow = at.y + height + 12 <= window.innerHeight;
      setPosition({
        position: "fixed",
        left: `${Math.max(12, Math.min(at.x, window.innerWidth - width - 12))}px`,
        top: fitsBelow ? `${Math.max(12, at.y)}px` : "auto",
        bottom: fitsBelow ? "auto" : `${Math.max(12, window.innerHeight - at.y)}px`,
        "z-index": 1000,
      });
    };
    const place = () => (point ? placeAtPoint(point) : placeAtAnchor());
    const outside = (event: PointerEvent) => {
      if (!props.anchor.contains(event.target as Node) && !layer?.contains(event.target as Node)) {
        if (point) swallowDismissClick();
        props.onClose();
      }
    };
    // A context menu belongs to the spot it opened on; once the page scrolls it
    // points at something else, so close it. Scrolling inside the menu is fine.
    const scrolled = (event: Event) => {
      if (!point) return place();
      if (!layer?.contains(event.target as Node)) props.onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        props.anchor.focus();
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scrolled, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    onCleanup(() => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
    });
  });
  return (
    <Portal>
      <div class={props.class ?? "model-select-dropdown"} ref={layer} style={position()}>
        {props.children}
      </div>
    </Portal>
  );
}
