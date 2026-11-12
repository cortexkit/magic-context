import { mock } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { RGBA, rgbToHex } from "@opentui/core";
import { plugin } from "bun";
import { createSignal } from "solid-js";
import type { SidebarSnapshot } from "../src/shared/rpc-types";
import { resolveMagicContextPrefs } from "../src/shared/tui-preferences";
import { runtimeModuleId, TUI_RUNTIME_SPECIFIERS } from "../src/shared/tui-runtime-specifiers";

type RenderCase = {
    snapshot: SidebarSnapshot | null;
    width?: number;
    preferences?: Record<string, unknown>;
    toggleHeader?: boolean;
    now?: number;
    matchingBadgeColors?: boolean;
};

const loaded = new Map<string, Record<string, unknown>>();
for (const specifier of TUI_RUNTIME_SPECIFIERS) loaded.set(specifier, await import(specifier));
plugin({
    name: "sidebar-render-runtime",
    setup(build) {
        for (const specifier of TUI_RUNTIME_SPECIFIERS) {
            build.module(runtimeModuleId(specifier), () => ({
                exports: loaded.get(specifier) ?? {},
                loader: "object",
            }));
        }
    },
});

const theme = {
    primary: RGBA.fromHex("#ffcc00"),
    secondary: RGBA.fromHex("#ffcc00"),
    accent: RGBA.fromHex("#ffcc00"),
    error: RGBA.fromHex("#ff0000"),
    warning: RGBA.fromHex("#ff8800"),
    success: RGBA.fromHex("#00ff00"),
    info: RGBA.fromHex("#0088ff"),
    text: RGBA.fromHex("#ffffff"),
    textMuted: RGBA.fromHex("#888888"),
    background: RGBA.fromHex("#000000"),
    backgroundPanel: RGBA.fromHex("#000000"),
    backgroundElement: RGBA.fromHex("#000000"),
    backgroundMenu: RGBA.fromHex("#000000"),
    border: RGBA.fromHex("#888888"),
    borderActive: RGBA.fromHex("#ffffff"),
    borderSubtle: RGBA.fromHex("#888888"),
};

let snapshot: SidebarSnapshot | null = null;
let preferences: Record<string, unknown> = {};
// Replace only transport and preference I/O. The shipped slot owns rendering.
mock.module(new URL("../src/tui-compiled/data/context-db.ts", import.meta.url).pathname, () => ({
    loadSidebarSnapshot: async () => snapshot,
}));
const prefsUrl = new URL("../src/shared/tui-preferences.ts", import.meta.url).pathname;
const actualPrefs = await import(prefsUrl);
mock.module(prefsUrl, () => ({
    ...actualPrefs,
    readTuiPreferencesFileSync: () => preferences,
    queueTuiPreferenceUpdate: async () => {},
    watchTuiPreferences: () => () => {},
}));
if (process.argv.includes("--raw-frame")) {
    const rawFrame = await import(new URL("../src/tui/quota-sidebar.js", import.meta.url).href);
    mock.module(
        new URL("../src/tui-compiled/quota-sidebar.js", import.meta.url).pathname,
        () => rawFrame,
    );
}
const sidebarUrl = new URL("../src/tui-compiled/slots/sidebar-content.tsx", import.meta.url).href;
const { createSidebarContentSlot } = await import(sidebarUrl);
const { testRender } = await import("@opentui/solid");
const inputs = JSON.parse(await Bun.stdin.text()) as RenderCase[];
const results = [];
for (const entry of inputs) {
    const realNow = Date.now;
    const fixtureNow = entry.now;
    if (fixtureNow !== undefined) Date.now = () => fixtureNow;
    snapshot = entry.snapshot;
    preferences = entry.preferences ?? {};
    const prefs = resolveMagicContextPrefs(preferences);
    const published = Promise.withResolvers<void>();
    const [currentTheme] = createSignal(
        entry.matchingBadgeColors ? { ...theme, background: theme.accent } : theme,
    );
    const slot = createSidebarContentSlot({
        state: {
            path: { directory: "fixture" },
            session: { get: () => ({ directory: "fixture" }) },
        },
        renderer: {
            requestRender() {
                published.resolve();
            },
        },
        event: { on: () => () => {} },
    } as unknown as TuiPluginApi);
    try {
        const setup = await testRender(
            () =>
                slot.slots.sidebar_content(
                    {
                        theme: {
                            get current() {
                                return currentTheme();
                            },
                        },
                    },
                    { session_id: "fixture" },
                ),
            { width: entry.width ?? 42, height: 60 },
        );
        await Promise.race([
            published.promise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("snapshot was not published")), 5000),
            ),
        ]);
        for (let pass = 0; pass < 4; pass++) await setup.renderOnce();
        if (entry.toggleHeader) {
            await setup.mockMouse.click(2, 0);
            for (let pass = 0; pass < 3; pass++) await setup.renderOnce();
        }
        const spans = setup.captureSpans();
        results.push({
            frame: setup.captureCharFrame(),
            lines: spans.lines.map((line) =>
                line.spans.map((span) => ({
                    text: span.text,
                    fg: rgbToHex(span.fg),
                    attributes: span.attributes,
                })),
            ),
            collapsed: prefs.collapsed,
        });
        setup.renderer.destroy();
    } catch (error) {
        results.push({ error: error instanceof Error ? error.stack : String(error) });
    } finally {
        Date.now = realNow;
        slot.dispose();
    }
}
const output = process.argv.includes("--frames")
    ? results
          .map((result) =>
              result.frame !== undefined
                  ? result.frame
                        .split("\n")
                        .map((line) => line.trimEnd())
                        .join("\n")
                        .trimEnd()
                  : result.error,
          )
          .join("\n\n")
    : JSON.stringify(results);
await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => (error ? reject(error) : resolve()));
});
process.exit(0);
