/**
 * Renders the shipped, compiled sidebar (`src/tui-compiled/slots/`) outside
 * OpenCode, for `src/tui/slots/sidebar-render.test.ts`.
 *
 * Like `render-compiled-status-dialog.ts`, this registers the
 * `opentui:runtime-module:*` registry OpenCode provides from this package's
 * own OpenTUI and Solid, so it runs as its own process (a Bun plugin cannot be
 * unregistered, and other tests check the registry is absent). Run it with
 * `bun --conditions=browser`: Solid's server build never re-runs a signal, so
 * the shared frame's rows would keep their unmeasured first layout.
 *
 * Input (stdin): a JSON array of cases, each one of
 *  - `{ kind: "panel", width, collapsed, theme, snapshot, now, version, label?, sections? }`:
 *    the panel drawn from one snapshot (`null` for the state before the first);
 *  - `{ kind: "mount-v1", width, directory }`: the OpenCode 1 TUI entry's `tui()`
 *    run against a stand-in host API, drawing the slot it registers;
 *  - `{ kind: "mount-v2", width, directory }`: the OpenCode 2 `setupWithJsx`
 *    run against a stand-in host context, drawing its `sidebar.content` claim.
 * `theme` is `"golden"` (fixed test colours) or `"dark"` / `"light"` (the default
 * theme of a released OpenCode 2 host, recorded in
 * `src/v2/tui/__fixtures__/ga-host-theme.json`).
 *
 * Output (stdout): a JSON array with, per case, `{ frame, spans, ansi }` or
 * `{ error }`. `frame` is the text with trailing blank rows removed, `spans`
 * one `[text, fg, bg, bold]` list per kept row (colours as `#rrggbb`, `bg` null
 * where the terminal background shows), and `ansi` the same rows with 24-bit
 * colour escapes.
 */
import { plugin } from "bun";
import { runtimeModuleId, TUI_RUNTIME_SPECIFIERS } from "../src/shared/tui-runtime-specifiers";

type Rgba = { toInts(): [number, number, number, number] };
type Span = { text: string; fg: Rgba; bg: Rgba; attributes: number; width: number };
type Setup = {
    renderOnce(): Promise<void>;
    captureCharFrame(): string;
    captureSpans(): { lines: Array<{ spans: Span[] }> };
};
type TestRender = (node: () => unknown, options: { width: number; height: number }) => Promise<Setup>;

type PanelCase = {
    kind: "panel";
    width: number;
    collapsed: boolean;
    theme: "golden" | "dark" | "light";
    snapshot: unknown;
    now: number;
    version: string;
    label?: string;
    sections?: Record<string, boolean>;
};
type MountCase = { kind: "mount-v1" | "mount-v2"; width: number; directory: string };
type RenderCase = PanelCase | MountCase;
type SpanRow = Array<[string, string, string | null, 0 | 1]>;

const loaded = new Map<string, Record<string, unknown>>();
// @opentui/core/testing subclasses a core export while it initializes; load core first.
await import("@opentui/core");
for (const specifier of TUI_RUNTIME_SPECIFIERS) loaded.set(specifier, await import(specifier));
plugin({
    name: "opentui-runtime-registry-for-sidebar-render",
    setup(build) {
        for (const specifier of TUI_RUNTIME_SPECIFIERS) {
            build.module(runtimeModuleId(specifier), () => ({
                exports: loaded.get(specifier) ?? {},
                loader: "object",
            }));
        }
    },
});

const { testRender } = loaded.get("@opentui/solid") as unknown as { testRender: TestRender };

// Imported by URL so the scripts typecheck does not compile the generated TSX.
const compiled = (path: string) => new URL(`../src/tui-compiled/${path}`, import.meta.url).href;
const panelModule = (await import(compiled("slots/sidebar-panel.tsx"))) as {
    SidebarPanel(props: unknown): unknown;
    sidebarTheme(theme: unknown): unknown;
};
const viewModule = (await import(compiled("slots/sidebar-view.ts"))) as {
    buildSidebarView(snapshot: unknown, sections: unknown, now: number): unknown;
};
const recordedThemes = (await import("../src/v2/tui/__fixtures__/ga-host-theme.json")) as unknown as {
    modes: Record<"dark" | "light", unknown>;
};
const { flattenTheme } = (await import("../src/v2/tui/sidebar-mount")) as unknown as {
    flattenTheme(theme: unknown, mode: "dark" | "light"): Record<string, string>;
};

/** The colours the shared frame's own golden frames use. */
const GOLDEN_THEME = {
    text: "#f0f0f0",
    textMuted: "#888888",
    accent: "#55aaff",
    background: "#101010",
    borderActive: "#888888",
    success: "#00cc55",
    warning: "#ffaa00",
    error: "#ff0055",
};

const DEFAULT_SECTIONS = { context: true, history: true, cache: true, knowledge: true };

/**
 * The recording stores each colour as `{ rgba: "#rrggbbaa" }`, where the host
 * hands the sidebar RGBA objects; hex strings are what OpenTUI also accepts.
 */
function recordedColours(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    const leaf = (value as { rgba?: unknown }).rgba;
    if (typeof leaf === "string") return leaf.slice(0, 7);
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
            key,
            recordedColours(entry),
        ]),
    );
}

function hostTheme(theme: PanelCase["theme"]): Record<string, string> {
    return theme === "golden"
        ? GOLDEN_THEME
        : flattenTheme(recordedColours(recordedThemes.modes[theme]), theme);
}

function hex(color: Rgba): string | null {
    const [r, g, b, a] = color.toInts();
    if (a === 0) return null;
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function ansiRow(row: SpanRow): string {
    let out = "";
    for (const [text, fg, bg, bold] of row) {
        const codes = [bold ? "1" : "22"];
        if (fg) codes.push(`38;2;${Number.parseInt(fg.slice(1, 3), 16)};${Number.parseInt(fg.slice(3, 5), 16)};${Number.parseInt(fg.slice(5, 7), 16)}`);
        if (bg) codes.push(`48;2;${Number.parseInt(bg.slice(1, 3), 16)};${Number.parseInt(bg.slice(3, 5), 16)};${Number.parseInt(bg.slice(5, 7), 16)}`);
        else codes.push("49");
        out += `\u001b[${codes.join(";")}m${text}`;
    }
    return `${out}\u001b[0m`;
}

function panelNode(entry: PanelCase): () => unknown {
    const view = viewModule.buildSidebarView(
        entry.snapshot,
        entry.sections ?? DEFAULT_SECTIONS,
        entry.now,
    );
    const props = {
        view,
        collapsed: entry.collapsed,
        onToggle: () => {},
        theme: panelModule.sidebarTheme(hostTheme(entry.theme)),
        label: entry.label ?? "MAGIC CONTEXT",
        version: entry.version,
        now: entry.now,
    };
    return () => panelModule.SidebarPanel(props);
}

/** OpenCode 1: the TUI entry registers its sidebar slot through `api.slots.register`. */
async function mountV1Node(entry: MountCase): Promise<() => unknown> {
    const tuiModule = (await import(compiled("index.tsx"))) as {
        default: { tui(api: unknown, options: unknown, meta: unknown): Promise<void> };
    };
    const registered: Array<{ slots: Record<string, (ctx: unknown, value: unknown) => unknown> }> = [];
    const api = {
        app: { version: "1.18.30" },
        state: {
            path: { directory: entry.directory },
            session: { get: () => ({ directory: entry.directory }) },
        },
        route: { current: { name: "session", params: { sessionID: "ses_mount_v1" } } },
        slots: { register: (slot: (typeof registered)[number]) => registered.push(slot) },
        keymap: { registerLayer: () => () => {} },
        lifecycle: { onDispose: () => {} },
        renderer: { requestRender: () => {} },
        event: { on: () => () => {} },
        ui: { toast: () => {}, dialog: { replace: () => {}, clear: () => {} } },
        theme: { current: hostTheme("golden") },
    };
    await tuiModule.default.tui(api, {}, {});
    const slot = registered[0];
    if (!slot) throw new Error("the OpenCode 1 entry registered no slot");
    return () =>
        slot.slots.sidebar_content?.(
            { theme: { current: hostTheme("golden") } },
            { session_id: "ses_mount_v1" },
        );
}

/** OpenCode 2: `setupWithJsx` claims `sidebar.content` and renders the mounted component. */
async function mountV2Node(entry: MountCase): Promise<() => unknown> {
    const { setupWithJsx } = (await import("../src/v2/tui/index")) as unknown as {
        setupWithJsx(context: unknown, jsx: unknown): Promise<() => void>;
    };
    const claims: Array<{ append?: string; render(input: { sessionID: string }): unknown }> = [];
    const context = {
        location: { directory: entry.directory },
        renderer: { requestRender() {} },
        data: {
            listen: () => () => {},
            location: { default: () => ({ directory: entry.directory }) },
        },
        keymap: { layer: () => {} },
        storage: {
            memory: <Value extends object>(_key: string, options: { initial: Value }) =>
                [options.initial, (mutation: (draft: Value) => void) => mutation(options.initial)] as const,
        },
        ui: {
            router: { current: () => ({ type: "session", sessionID: "ses_mount_v2" }) },
            slot: (claim: (typeof claims)[number]) => {
                claims.push(claim);
                return () => {};
            },
            toast: { show() {} },
            dialog: { async alert() {}, async confirm() { return false; } },
        },
    };
    // The text projection is the only caller of the factory; a mounted
    // component never reaches it, so a factory that throws proves that.
    await setupWithJsx(context, () => {
        throw new Error("the sidebar fell back to its text projection");
    });
    const claim = claims.find((entry) => entry.append === "sidebar.content");
    if (!claim) throw new Error("the OpenCode 2 entry claimed no sidebar slot");
    return () => claim.render({ sessionID: "ses_mount_v2" });
}

async function nodeFor(entry: RenderCase): Promise<() => unknown> {
    if (entry.kind === "panel") return panelNode(entry);
    if (entry.kind === "mount-v1") return mountV1Node(entry);
    return mountV2Node(entry);
}

const inputs = JSON.parse(await Bun.stdin.text()) as RenderCase[];
const results: Array<{ frame: string; spans: SpanRow[]; ansi: string } | { error: string }> = [];
for (const entry of inputs) {
    try {
        const setup = await testRender(await nodeFor(entry), { width: entry.width, height: 40 });
        // Rows measure their own width on the first pass and fit their values on
        // the next; the later passes draw what a user sees.
        for (let pass = 0; pass < 3; pass += 1) await setup.renderOnce();
        const rows = setup.captureCharFrame().split("\n");
        while (rows.length > 0 && rows[rows.length - 1]?.trim() === "") rows.pop();
        const spans = setup
            .captureSpans()
            .lines.slice(0, rows.length)
            .map((line) =>
                line.spans.map(
                    (span): SpanRow[number] => [
                        span.text,
                        hex(span.fg) ?? "",
                        hex(span.bg),
                        span.attributes & 1 ? 1 : 0,
                    ],
                ),
            );
        results.push({
            frame: rows.join("\n"),
            spans,
            ansi: spans.map(ansiRow).join("\n"),
        });
    } catch (error) {
        results.push({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    }
}
process.stdout.write(JSON.stringify(results));
process.exit(0);
