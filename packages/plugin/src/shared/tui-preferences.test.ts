import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parse } from "comment-json";
import { createTestTempDirFromPath } from "./test-temp-dir";
import {
    __resetTuiPreferencesWatchTestHooks,
    __setTuiPreferencesWatchTestHooks,
    computeEffectiveOrder,
    DEFAULT_PREFS,
    DEFAULT_SLOT_ORDER,
    getTuiPreferencesFile,
    PLUGIN_KEY,
    queueTuiPreferenceUpdate,
    readTuiPreferencesFile,
    resolveMagicContextPrefs,
    TUI_PREFS_FILE_ENV,
    watchTuiPreferences,
} from "./tui-preferences";

let dir: string;
let file: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [TUI_PREFS_FILE_ENV, "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"];

beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    dir = await createTestTempDirFromPath(join(tmpdir(), "mc-tui-prefs-test-"));
    file = join(dir, "tui-preferences.jsonc");
    process.env[TUI_PREFS_FILE_ENV] = file;
});

afterEach(async () => {
    __resetTuiPreferencesWatchTestHooks();
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    await rm(dir, { recursive: true, force: true });
});

describe("getTuiPreferencesFile", () => {
    test("env override wins", () => {
        expect(getTuiPreferencesFile()).toBe(file);
    });

    test("falls back to OPENCODE_CONFIG_DIR then XDG then ~/.config", () => {
        delete process.env[TUI_PREFS_FILE_ENV];
        process.env.OPENCODE_CONFIG_DIR = "/tmp/cfgdir";
        expect(getTuiPreferencesFile()).toBe("/tmp/cfgdir/tui-preferences.jsonc");
        delete process.env.OPENCODE_CONFIG_DIR;
        process.env.XDG_CONFIG_HOME = "/tmp/xdg";
        expect(getTuiPreferencesFile()).toBe("/tmp/xdg/opencode/tui-preferences.jsonc");
    });
});

describe("readTuiPreferencesFile (tolerant)", () => {
    test("missing file → {}", async () => {
        expect(await readTuiPreferencesFile()).toEqual({});
    });

    test("malformed JSON → {}", async () => {
        await writeFile(file, "{ this is not json ", "utf8");
        expect(await readTuiPreferencesFile()).toEqual({});
    });

    test("non-object root → {}", async () => {
        await writeFile(file, "[1, 2, 3]", "utf8");
        expect(await readTuiPreferencesFile()).toEqual({});
    });

    test("jsonc with comments + trailing comma parses", async () => {
        await writeFile(
            file,
            `{
  // a comment
  "magic-context": { "order": 205, },
}`,
            "utf8",
        );
        const root = await readTuiPreferencesFile();
        expect(resolveMagicContextPrefs(root).order).toBe(205);
    });
});

describe("watchTuiPreferences", () => {
    test("notifies when the initial read resolves after an atomic replacement", async () => {
        const previous = `{"magic-context":{"sections":{"knowledge":true}}}\n`;
        const next = `{"magic-context":{"sections":{"knowledge":false}}}\n`;
        await writeFile(file, previous, "utf8");

        let resolveInitialRead!: (text: string) => void;
        const pendingInitialRead = new Promise<string>((resolve) => {
            resolveInitialRead = resolve;
        });
        let emitWatchEvent!: (event: string, filename: string | null) => void;
        let readCount = 0;
        __setTuiPreferencesWatchTestHooks({
            readFile: () => {
                readCount += 1;
                return readCount === 1 ? pendingInitialRead : Promise.resolve(next);
            },
            watch: (_directory, listener) => {
                emitWatchEvent = listener;
                return { close() {} };
            },
        });

        const observed = new Promise<{ knowledge: boolean }>((resolve) => {
            const stop = watchTuiPreferences(() => {
                void readTuiPreferencesFile().then((root) => {
                    stop();
                    resolve({ knowledge: resolveMagicContextPrefs(root).sections.knowledge });
                });
            });
        });

        const replacement = `${file}.external.tmp`;
        await writeFile(replacement, next, "utf8");
        await rename(replacement, file);
        emitWatchEvent("rename", basename(file));
        resolveInitialRead(next);

        const result = await Promise.race([
            observed,
            new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
        ]);
        expect(result).toEqual({ knowledge: false });
    });
});

describe("resolveMagicContextPrefs (per-key validation)", () => {
    test("missing key → full defaults clone", () => {
        expect(resolveMagicContextPrefs({})).toEqual(DEFAULT_PREFS);
        // clone, not the shared object
        expect(resolveMagicContextPrefs({})).not.toBe(DEFAULT_PREFS);
    });

    test("one bad value never poisons the rest", () => {
        const prefs = resolveMagicContextPrefs({
            "magic-context": {
                order: "nope",
                rememberCollapsed: 1,
                collapsed: true,
                sections: { history: false, knowledge: "bad" },
            },
        });
        expect(prefs.order).toBe(DEFAULT_SLOT_ORDER); // bad → default
        expect(prefs.rememberCollapsed).toBe(true); // bad → default true
        expect(prefs.collapsed).toBe(true); // valid bool preserved
        expect(prefs.sections.history).toBe(false); // valid bool preserved
        expect(prefs.sections.knowledge).toBe(true); // bad → default true
    });

    test("section keys from the earlier panel are ignored without affecting the new ones", () => {
        const prefs = resolveMagicContextPrefs({
            "magic-context": {
                sections: {
                    historian: false,
                    memory: false,
                    status: false,
                    dreamer: false,
                    stats: false,
                },
            },
        });
        expect(prefs.sections).toEqual({
            context: true,
            history: true,
            cache: true,
            knowledge: true,
        });
    });

    test("order clamps to -10000..10000", () => {
        expect(resolveMagicContextPrefs({ "magic-context": { order: 99999 } }).order).toBe(10000);
        expect(resolveMagicContextPrefs({ "magic-context": { order: -99999 } }).order).toBe(-10000);
    });

    test("collapsed non-boolean → null (seed from startCollapsed)", () => {
        expect(resolveMagicContextPrefs({ "magic-context": {} }).collapsed).toBeNull();
    });

    test("header label clamps length, empty → default", () => {
        expect(
            resolveMagicContextPrefs({ "magic-context": { header: { label: "" } } }).header.label,
        ).toBe(DEFAULT_PREFS.header.label);
        expect(
            resolveMagicContextPrefs({
                "magic-context": { header: { label: "x".repeat(50) } },
            }).header.label.length,
        ).toBe(24);
    });
});

describe("computeEffectiveOrder (cross-plugin convention)", () => {
    test("default when key missing", () => {
        expect(computeEffectiveOrder({}, PLUGIN_KEY, DEFAULT_SLOT_ORDER)).toBe(DEFAULT_SLOT_ORDER);
    });

    test("explicit order clamped", () => {
        expect(computeEffectiveOrder({ "magic-context": { order: 250 } }, PLUGIN_KEY, 200)).toBe(
            250,
        );
    });

    test("forceToTop sorts below FORCE_TOP_BASE by key position", () => {
        const root = { aft: { forceToTop: true }, "magic-context": { forceToTop: true } };
        expect(computeEffectiveOrder(root, "aft", 200)).toBe(-100000 + 0);
        expect(computeEffectiveOrder(root, "magic-context", 200)).toBe(-100000 + 1);
        // forced always beats any manual order (clamped band is strictly above)
        expect(computeEffectiveOrder(root, "aft", 200)).toBeLessThan(-10000);
    });
});

describe("write path — comment-json full round-trip", () => {
    test("persists a nested key and reads back", async () => {
        await queueTuiPreferenceUpdate(PLUGIN_KEY, ["collapsed"], true);
        const prefs = resolveMagicContextPrefs(await readTuiPreferencesFile());
        expect(prefs.collapsed).toBe(true);
    });

    test("seeds the file from the template when absent", async () => {
        await queueTuiPreferenceUpdate(PLUGIN_KEY, ["order"], 205);
        const text = await readFile(file, "utf8");
        expect(text).toContain("Shared preferences for OpenCode TUI plugins");
        expect(resolveMagicContextPrefs(await readTuiPreferencesFile()).order).toBe(205);
    });

    test("INTEROP: a sibling plugin's values AND comments survive MC writing only its key", async () => {
        // A shared file owned partly by anthropic-auth, with comments and an
        // appearance block MC knows nothing about. MC must touch ONLY its key.
        await writeFile(
            file,
            `{
  // anthropic-auth section — DO NOT lose this BLOCK comment
  "anthropic-auth": {
    "order": 160,
    "header": { "label": "CLAUDE" },
    // bar appearance knobs MC has no schema for
    "appearance": { "barWidth": 10, "barFilledChar": "#" },
    "pollMs": 2000 // INLINE trailing comment — must survive too
  },
  "magic-context": { "order": 200 }
}
`,
            "utf8",
        );

        await queueTuiPreferenceUpdate(PLUGIN_KEY, ["collapsed"], true);

        const text = await readFile(file, "utf8");
        // sibling comments preserved — BOTH block and inline trailing
        // (comment-json round-trips both faithfully; enforce the guarantee).
        expect(text).toContain("anthropic-auth section — DO NOT lose this BLOCK comment");
        expect(text).toContain("bar appearance knobs MC has no schema for");
        expect(text).toContain("INLINE trailing comment — must survive too");

        // sibling VALUES intact (incl. nested keys MC has no schema for)
        const root = parse(text) as Record<string, Record<string, unknown>>;
        const aa = root["anthropic-auth"] as Record<string, unknown>;
        expect(aa.order).toBe(160);
        expect((aa.header as Record<string, unknown>).label).toBe("CLAUDE");
        const appearance = aa.appearance as Record<string, unknown>;
        expect(appearance.barWidth).toBe(10);
        expect(appearance.barFilledChar).toBe("#");

        // MC's own change landed
        expect(resolveMagicContextPrefs(root).collapsed).toBe(true);
        expect(resolveMagicContextPrefs(root).order).toBe(200);
    });

    test("malformed existing file → write is a no-op, sibling content untouched", async () => {
        const broken = `{ "anthropic-auth": { "order": 160 } broken `;
        await writeFile(file, broken, "utf8");
        await queueTuiPreferenceUpdate(PLUGIN_KEY, ["collapsed"], true);
        // unchanged — we never clobber a file we can't safely parse
        expect(await readFile(file, "utf8")).toBe(broken);
    });
});
