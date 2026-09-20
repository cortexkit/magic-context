import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Host } from "@opencode/plugin/host";
import { setupWithJsx } from "./index";
import type { V2SidebarState, V2SlotClaim, V2TuiContext } from "./types";

const temporary: string[] = [];
afterEach(() => {
    for (const directory of temporary.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

function v2Context() {
    const claims: V2SlotClaim[] = [];
    const layers: Array<ReturnType<Parameters<V2TuiContext["keymap"]["layer"]>[0]>> = [];
    const cleanups: Array<() => void> = [];
    const state: V2SidebarState = { snapshots: {} };
    const context: V2TuiContext = {
        location: { directory: process.cwd() },
        renderer: { requestRender() {} },
        data: {
            listen(handler) {
                void handler;
                const cleanup = () => {};
                cleanups.push(cleanup);
                return cleanup;
            },
            location: { default: () => ({ directory: process.cwd() }) },
        },
        keymap: { layer: (input) => layers.push(input()) },
        storage: {
            memory: <Value extends object>(_key: string, options: { initial: Value }) => [
                options.initial,
                (mutation: (draft: Value) => void) => mutation(options.initial),
            ],
        },
        ui: {
            router: { current: () => ({ type: "session", sessionID: "ses-v2-tui" }) },
            slot: (claim) => {
                claims.push(claim);
                return () => {};
            },
            toast: { show() {} },
            dialog: {
                async alert() {},
                async confirm() {
                    return false;
                },
            },
        },
    };
    return { context, claims, layers, state };
}

function v1Api(directory: string) {
    let slot:
        | { slots: { sidebar_content: (ctx: unknown, value: unknown) => unknown }; dispose(): void }
        | undefined;
    const disposals: Array<() => void | Promise<void>> = [];
    const color = "#ffffff";
    const api = {
        state: {
            path: { directory },
            session: { messages: () => [] },
        },
        route: { current: { name: "session", params: { sessionID: "ses-v1-tui" } } },
        slots: { register: (value: typeof slot) => (slot = value) },
        keymap: { registerLayer() {} },
        command: { register() {} },
        event: { on: () => () => {} },
        renderer: { requestRender() {} },
        lifecycle: { onDispose: (cleanup: () => void | Promise<void>) => disposals.push(cleanup) },
        theme: {
            current: {
                primary: color,
                secondary: color,
                accent: color,
                error: color,
                warning: color,
                success: color,
                info: color,
                text: color,
                textMuted: color,
                background: "#000000",
                backgroundPanel: "#000000",
                backgroundElement: "#000000",
                backgroundMenu: "#000000",
                border: color,
                borderActive: color,
                borderSubtle: color,
            },
        },
        ui: {
            toast() {},
            dialog: { replace() {}, clear() {} },
            DialogAlert: () => null,
            DialogConfirm: () => null,
            DialogPrompt: () => null,
            DialogSelect: () => null,
        },
    };
    return {
        api,
        slot: () => slot,
        dispose: async () => Promise.all(disposals.map((cleanup) => cleanup())),
    };
}

test("GA 2.0.5 resolves ./tui and executes the union setup contract", async () => {
    const packageRoot = resolve(import.meta.dir, "../../..");
    const entrypoints = Host.resolve({
        name: "@cortexkit/opencode-magic-context",
        directory: packageRoot,
    });
    expect(entrypoints.tui).toContain("src/tui/entry.mjs");
    const loaded = (await Host.load(entrypoints.tui!)) as {
        default: {
            id: string;
            tui: unknown;
            setup: (context: V2TuiContext) => Promise<() => void>;
        };
    };
    expect(typeof loaded.default.setup).toBe("function");
    const fixture = v2Context();
    const cleanup = await setupWithJsx(fixture.context, (type, props) => ({ type, props }));
    expect(fixture.claims.map((claim) => claim.append)).toEqual(["sidebar.content"]);
    const sidebarClaim = fixture.claims[0]!;
    if (sidebarClaim.append !== "sidebar.content") throw new Error("expected the sidebar claim");
    expect(sidebarClaim.render({ sessionID: "ses-v2-tui" })).toEqual({
        type: "text",
        props: { children: expect.stringContaining("Magic Context") },
    });
    expect(fixture.layers[0]!.commands.map((command) => command.slash.name)).toEqual([
        "ctx-status",
        "ctx-recomp",
        "ctx-dream",
    ]);
    cleanup();
});

test("GA 2.0.5 registers the keymap layer from the app slot when setup runs outside the provider", async () => {
    const fixture = v2Context();
    let providerAvailable = false;
    Object.assign(fixture.context.keymap, {
        layer: (input: () => unknown) => {
            if (!providerAvailable) throw new Error("Keymap.Provider is missing");
            fixture.layers.push(input() as never);
        },
    });
    const cleanup = await setupWithJsx(fixture.context, (type, props) => ({ type, props }));
    expect(fixture.claims.map((claim) => claim.append)).toEqual(["sidebar.content", "app"]);
    expect(fixture.layers).toHaveLength(0);

    // The app slot render executes inside the component tree, where the provider resolves.
    providerAvailable = true;
    const appClaim = fixture.claims.find((claim) => claim.append === "app");
    if (appClaim?.append !== "app") throw new Error("expected the app slot claim");
    appClaim.render({});
    expect(
        fixture.layers.map((layer) => layer.commands.map((command) => command.slash.name)),
    ).toEqual([["ctx-status", "ctx-recomp", "ctx-dream"]]);
    // Repeated renders must not stack duplicate layers.
    appClaim.render({});
    expect(fixture.layers).toHaveLength(1);
    cleanup();
});

test("GA 2.0.5 keeps the sidebar when the app-slot keymap registration also fails", async () => {
    const fixture = v2Context();
    Object.assign(fixture.context.keymap, {
        layer: () => {
            throw new Error("Keymap.Provider is missing");
        },
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
    };
    try {
        const cleanup = await setupWithJsx(fixture.context, (type, props) => ({ type, props }));
        expect(fixture.claims.map((claim) => claim.append)).toEqual(["sidebar.content", "app"]);
        const appClaim = fixture.claims.find((claim) => claim.append === "app");
        if (appClaim?.append !== "app") throw new Error("expected the app slot claim");
        appClaim.render({});
        appClaim.render({});
        expect(fixture.layers).toHaveLength(0);
        expect(
            warnings.filter((line) => line.includes("keymap.layer is unavailable")),
        ).toHaveLength(1);
        cleanup();
    } finally {
        console.warn = originalWarn;
    }
});

test("OpenCode 1.18.30 TUI loader projection executes unchanged sidebar registration", async () => {
    // v1.18.30 packages/opencode/src/plugin/shared.ts:272-304 reads only id,
    // server and tui, rejects a simultaneous server+tui pair, and returns the
    // object without validating unrelated keys. `setup` is therefore invisible
    // to the pinned v1 TUI loader while this test executes the selected tui().
    const packageRoot = resolve(import.meta.dir, "../../..");
    const entrypoints = Host.resolve({
        name: "@cortexkit/opencode-magic-context",
        directory: packageRoot,
    });
    const loaded = (await Host.load(entrypoints.tui!)) as {
        default: {
            id: string;
            tui: (api: unknown, options?: unknown, meta?: unknown) => Promise<void>;
            setup: unknown;
            server?: unknown;
        };
    };
    const plugin = loaded.default;
    expect({ id: plugin.id, tui: plugin.tui }).toEqual({
        id: "opencode-magic-context",
        tui: expect.any(Function),
    });
    expect(plugin.server).toBeUndefined();
    expect(typeof plugin.setup).toBe("function");

    const directory = mkdtempSync(resolve(tmpdir(), "mc-v1-tui-union-"));
    temporary.push(directory);
    const fixture = v1Api(directory);
    const previousCompactionOverride = process.env.OPENCODE_DISABLE_AUTOCOMPACT;
    process.env.OPENCODE_DISABLE_AUTOCOMPACT = "1";
    try {
        await plugin.tui(fixture.api, undefined, {
            state: "first",
            id: plugin.id,
            source: "file",
            spec: "fixture",
            target: entrypoints.tui,
        });
    } finally {
        if (previousCompactionOverride === undefined)
            delete process.env.OPENCODE_DISABLE_AUTOCOMPACT;
        else process.env.OPENCODE_DISABLE_AUTOCOMPACT = previousCompactionOverride;
    }
    const slot = fixture.slot();
    expect(slot).toBeDefined();
    expect(typeof slot!.slots.sidebar_content).toBe("function");
    await fixture.dispose();
    slot!.dispose();
}, 15_000);
