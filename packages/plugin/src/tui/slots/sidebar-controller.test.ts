import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "comment-json";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    PLUGIN_KEY,
    readTuiPreferencesFileSync,
    resolveMagicContextPrefs,
    TUI_PREFS_FILE_ENV,
} from "../../shared/tui-preferences";
import { createSidebarController, type SidebarController } from "./sidebar-controller.tsx";

let file: string;
let saved: string | undefined;
const controllers: SidebarController[] = [];

beforeEach(() => {
    saved = process.env[TUI_PREFS_FILE_ENV];
    file = join(
        createTestTempDirFromPath(join(tmpdir(), "mc-sidebar-controller-")),
        "tui-preferences.jsonc",
    );
    process.env[TUI_PREFS_FILE_ENV] = file;
});

afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
    if (saved === undefined) delete process.env[TUI_PREFS_FILE_ENV];
    else process.env[TUI_PREFS_FILE_ENV] = saved;
});

/** A controller seeded the way the slot factory seeds one at startup. */
function startController(): SidebarController {
    const controller = createSidebarController(
        resolveMagicContextPrefs(readTuiPreferencesFileSync()),
    );
    controllers.push(controller);
    return controller;
}

function persistedCollapsed(): unknown {
    try {
        const root = parse(readFileSync(file, "utf8")) as Record<string, { collapsed?: unknown }>;
        return root[PLUGIN_KEY]?.collapsed;
    } catch {
        return undefined;
    }
}

async function waitForPersisted(value: boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (persistedCollapsed() !== value) {
        if (Date.now() > deadline) throw new Error(`collapsed never became ${value} in ${file}`);
        await Bun.sleep(10);
    }
}

describe("sidebar collapse state", () => {
    test("a toggle is written to the preferences file and a new controller starts from it", async () => {
        const first = startController();
        expect(first.collapsed()).toBe(false);

        first.toggleCollapsed();
        expect(first.collapsed()).toBe(true);
        await waitForPersisted(true);

        // A new launch reads the file again.
        const second = startController();
        expect(second.collapsed()).toBe(true);

        second.toggleCollapsed();
        await waitForPersisted(false);
        expect(startController().collapsed()).toBe(false);
    });

    test("with rememberCollapsed off, a toggle is not written and launches use startCollapsed", async () => {
        writeFileSync(
            file,
            JSON.stringify({
                [PLUGIN_KEY]: { rememberCollapsed: false, startCollapsed: true, collapsed: true },
            }),
        );
        const first = startController();
        expect(first.collapsed()).toBe(true);
        first.toggleCollapsed();
        expect(first.collapsed()).toBe(false);
        await Bun.sleep(50);
        expect(persistedCollapsed()).toBe(true);
        expect(startController().collapsed()).toBe(true);
    });
});
