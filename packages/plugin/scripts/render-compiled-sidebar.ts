import type { CliRenderer, Renderable } from "@opentui/core";
import { plugin } from "bun";
import { join } from "node:path";
import { runtimeModuleId, TUI_RUNTIME_SPECIFIERS } from "../src/shared/tui-runtime-specifiers";
import { getRpcClient } from "../src/tui-compiled/data/context-db";
import type { SidebarSnapshot } from "../src/tui/data/context-db";
import { mountV1Sidebar } from "../src/v2/tui/sidebar-mount";
import type { V2TuiContext } from "../src/v2/tui/types";

type SnapshotReply = Pick<SidebarSnapshot, "sessionId"> & Partial<SidebarSnapshot>;
export type RenderCase = {
    snapshots: [SnapshotReply, ...SnapshotReply[]];
    collapsed?: boolean;
    throwOnEvaluable?: boolean;
    trackText?: string[];
};
export type RenderResult = { frames: string[]; error?: string; textIds?: number[][][] };
type TestRender = (
    node: () => unknown,
    options: { width: number; height: number },
) => Promise<{
    renderOnce(): Promise<void>;
    captureCharFrame(): string;
    renderer: Pick<CliRenderer, "destroy" | "requestRender" | "root">;
}>;
type SlotRegistry = {
    register(plugin: {
        id: string;
        slots: Record<string, (ctx: unknown, value: { sessionID: string }) => unknown>;
    }): () => void;
};

const loaded = new Map<string, Record<string, unknown>>();
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

const { createSlot, createSolidSlotRegistry, testRender, useRenderer } = loaded.get(
    "@opentui/solid",
) as unknown as {
    createSlot(registry: SlotRegistry): (props: { name: string; sessionID: string }) => unknown;
    createSolidSlotRegistry(
        renderer: unknown,
        context: unknown,
        options: { onPluginError(event: { error: Error }): void },
    ): SlotRegistry;
    testRender: TestRender;
    useRenderer(): unknown;
};
const { ErrorBoundary } = loaded.get("solid-js") as unknown as {
    ErrorBoundary(props: { children: unknown; fallback: (error: unknown) => null }): unknown;
};

function captureTextIds(root: Renderable, labels: string[]): number[][] {
    const ids = labels.map(() => [] as number[]);
    function visit(node: Renderable) {
        if ("plainText" in node) {
            for (const [index, label] of labels.entries()) {
                if (node.plainText === label) ids[index].push(node.num);
            }
        }
        for (const child of node.getChildren()) visit(child);
    }
    visit(root);
    return ids;
}

async function renderRefresh({
    snapshots,
    collapsed,
    throwOnEvaluable,
    trackText,
}: RenderCase): Promise<RenderResult> {
    process.env.OPENCODE_TUI_PREFERENCES_FILE = join(
        import.meta.dir,
        "../src/tui/slots/fixtures",
        collapsed ? "sidebar-collapsed.json" : "unused/prefs.jsonc",
    );
    const directory = import.meta.dir;
    const sessionID = snapshots[0].sessionId;
    let response = snapshots[0];
    let resolveDraw = () => {};
    const nextDraw = () =>
        new Promise<void>((resolve) => {
            resolveDraw = () => resolve();
        });
    let completed = nextDraw();
    const result: RenderResult = { frames: [] };
    if (trackText) result.textIds = [];
    let setup: Awaited<ReturnType<TestRender>> | undefined;
    const context = {
        renderer: {
            requestRender() {
                setup?.renderer.requestRender();
                resolveDraw();
            },
        },
        data: { listen: () => () => {} },
    } satisfies Pick<V2TuiContext, "renderer"> & { data: Pick<V2TuiContext["data"], "listen"> };
    const slot = await mountV1Sidebar(context as unknown as V2TuiContext, directory);
    if (!slot) throw new Error("compiled sidebar runtime not available");
    const rpc = getRpcClient();
    if (!rpc) throw new Error("sidebar RPC client not initialized");
    rpc.call = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
        if (method !== "sidebar-snapshot" || params.sessionId !== response.sessionId) {
            throw new Error(`unexpected sidebar RPC: ${method} for ${String(params.sessionId)}`);
        }
        return response as T;
    };
    const last = snapshots.at(-1);
    if (throwOnEvaluable && last?.tailHygiene) {
        Object.defineProperty(last.tailHygiene, "evaluable", {
            get() {
                throw new TypeError("forced error reading tailHygiene.evaluable during refresh");
            },
        });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    function recordError(error: unknown) {
        result.error ??= error instanceof Error ? error.message : String(error);
        resolveDraw();
    }
    try {
        setup = await testRender(
            () => {
                const registry = createSolidSlotRegistry(
                    useRenderer(),
                    {},
                    { onPluginError: ({ error }) => recordError(error) },
                );
                registry.register({
                    id: "opencode-magic-context",
                    slots: { "sidebar.content": (_ctx, value) => slot.render(value) },
                });
                const Slot = createSlot(registry);
                return ErrorBoundary({
                    get children() {
                        return Slot({ name: "sidebar.content", sessionID });
                    },
                    fallback(error) {
                        // The refresh handler catches errors. The boundary records the slot error first.
                        recordError(error);
                        return null;
                    },
                });
            },
            { width: 80, height: 50 },
        );
        for (const [step, snapshot] of snapshots.entries()) {
            if (step > 0) {
                response = snapshot;
                completed = nextDraw();
                slot.refresh();
            }
            await Promise.race([
                completed,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`${step} snapshot did not draw`)),
                        5000,
                    );
                }),
            ]);
            clearTimeout(timer);
            if (result.error !== undefined) break;
            await setup.renderOnce();
            result.frames.push(setup.captureCharFrame().trimEnd());
            if (trackText) result.textIds?.push(captureTextIds(setup.renderer.root, trackText));
        }
    } catch (error) {
        recordError(error);
    } finally {
        clearTimeout(timer);
        setup?.renderer.destroy();
        slot.dispose();
    }
    return result;
}

const inputs = JSON.parse(await Bun.stdin.text()) as RenderCase[];
const results: RenderResult[] = [];
for (const entry of inputs) results.push(await renderRefresh(entry));
process.stdout.write(JSON.stringify(results));
process.exit(0);
