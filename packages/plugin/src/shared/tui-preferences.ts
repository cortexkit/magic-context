import { readFileSync, watch } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "comment-json";

// Shared preferences file for OpenCode TUI plugins. One top-level key per plugin
// (short, non-integer-like name, e.g. "magic-context"). The file is OPTIONAL:
// every reader falls back to defaults when it is missing or malformed.
//
// Cross-plugin convention (anthropic-auth / aft / magic-context all mirror it):
//   - same file name + env override + lookup order,
//   - byte-identical `computeEffectiveOrder` so the three sort consistently,
//   - a coordinated default-order ladder (anthropic-auth 160, MC 170, AFT 180).
//
// MC uses `comment-json` (already a dep, Bun-safe) for the WRITE path — a full
// parse → mutate-one-key → stringify round-trip that preserves comments and
// sibling plugins' keys. (anthropic-auth uses jsonc-parser's surgical `modify`;
// AFT and MC use comment-json. Both are interop-safe as long as a sibling key's
// values AND comments survive — asserted by the interop test.)

export const TUI_PREFS_FILE_ENV = "OPENCODE_TUI_PREFERENCES_FILE";
const FILE_NAME = "tui-preferences.jsonc";

export function getTuiPreferencesFile(): string {
    const override = process.env[TUI_PREFS_FILE_ENV];
    if (override) return override;
    const configDir =
        process.env.OPENCODE_CONFIG_DIR ||
        join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
    return join(configDir, FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Tolerant read: a missing file, parse error, or non-object root all resolve to
// {} so the sidebar never crashes on hand-edited content. Never throws.
export async function readTuiPreferencesFile(): Promise<Record<string, unknown>> {
    try {
        const raw = await readFile(getTuiPreferencesFile(), "utf8");
        if (raw.trim() === "") return {};
        const root: unknown = parse(raw);
        return isRecord(root) ? (root as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

// Synchronous tolerant read — used once at slot mount to seed the initial
// collapse state and effective order WITHOUT a frame of async flicker (the
// sidebar must render at its final width/collapse on the very first paint).
// Same tolerance contract as the async reader. Never throws.
export function readTuiPreferencesFileSync(): Record<string, unknown> {
    try {
        const raw = readFileSync(getTuiPreferencesFile(), "utf8");
        if (raw.trim() === "") return {};
        const root: unknown = parse(raw);
        return isRecord(root) ? (root as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export const PLUGIN_KEY = "magic-context";
export const DEFAULT_SLOT_ORDER = 170;

export interface MagicContextTuiPrefs {
    forceToTop: boolean;
    order: number;
    startCollapsed: boolean;
    rememberCollapsed: boolean;
    // null = never persisted; seed the UI from `startCollapsed` instead.
    collapsed: boolean | null;
    header: {
        label: string;
    };
    // One switch per section of the expanded panel. Keys from earlier panel
    // layouts are ignored.
    sections: {
        context: boolean;
        history: boolean;
        cache: boolean;
        knowledge: boolean;
    };
}

export type TuiSections = MagicContextTuiPrefs["sections"];

export const DEFAULT_PREFS: MagicContextTuiPrefs = {
    forceToTop: false,
    order: DEFAULT_SLOT_ORDER,
    startCollapsed: false,
    rememberCollapsed: true,
    collapsed: null,
    header: { label: "MAGIC CONTEXT" },
    sections: {
        context: true,
        history: true,
        cache: true,
        knowledge: true,
    },
};

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), min), max);
}

function label(value: unknown, fallback: string, maxLength: number): string {
    if (typeof value !== "string" || value.length === 0) return fallback;
    return value.slice(0, maxLength);
}

// Per-key validation: every value is independently clamped/defaulted so one bad
// entry never poisons the rest. Never throws. A missing/non-object MC key →
// full defaults clone.
export function resolveMagicContextPrefs(root: Record<string, unknown>): MagicContextTuiPrefs {
    const entry = root[PLUGIN_KEY];
    if (!isRecord(entry)) return structuredClone(DEFAULT_PREFS);

    const d = DEFAULT_PREFS;
    const header = isRecord(entry.header) ? entry.header : {};
    const sections = isRecord(entry.sections) ? entry.sections : {};

    return {
        forceToTop: bool(entry.forceToTop, d.forceToTop),
        order: int(entry.order, d.order, -10000, 10000),
        startCollapsed: bool(entry.startCollapsed, d.startCollapsed),
        rememberCollapsed: bool(entry.rememberCollapsed, d.rememberCollapsed),
        collapsed: typeof entry.collapsed === "boolean" ? entry.collapsed : null,
        header: {
            label: label(header.label, d.header.label, 24),
        },
        sections: {
            context: bool(sections.context, d.sections.context),
            history: bool(sections.history, d.sections.history),
            cache: bool(sections.cache, d.sections.cache),
            knowledge: bool(sections.knowledge, d.sections.knowledge),
        },
    };
}

const FORCE_TOP_BASE = -100000;

// Shared forceToTop convention — MUST stay byte-identical across anthropic-auth,
// AFT, and magic-context or the three sort inconsistently against each other.
// Forced plugins sort below FORCE_TOP_BASE, ordered among themselves by their
// top-level key's position in the file, so users reprioritize by reordering
// keys. The user-facing `order` knob clamps to -10000..10000, strictly above the
// forced band, so a manual order can never beat forceToTop. Host slots render
// ascending by order; OpenCode's built-ins occupy 100-500.
//
// Key-naming requirement: plugin keys must be non-integer-like short names (e.g.
// "magic-context"). JS object key iteration hoists integer-like keys ("0", "42")
// ahead of string keys, which would skew the indexOf-based ordering of forced
// plugins. The shared convention requires non-numeric names.
export function computeEffectiveOrder(
    root: Record<string, unknown>,
    pluginKey: string,
    defaultOrder: number,
): number {
    const entry = root[pluginKey];
    if (!isRecord(entry)) return defaultOrder;
    if (entry.forceToTop === true) {
        return FORCE_TOP_BASE + Object.keys(root).indexOf(pluginKey);
    }
    return int(entry.order, defaultOrder, -10000, 10000);
}

const TEMPLATE = `// Shared preferences for OpenCode TUI plugins.
// One top-level key per plugin (short name). See each plugin's README for its
// supported settings. This file is safe to hand-edit; plugins update individual
// keys and preserve the rest (values and comments).
{}
`;

type JsonValue = string | number | boolean | null;

// Set a nested path on a comment-json root, creating intermediate plain objects
// as needed. Mutating an existing leaf preserves its comments; sibling keys are
// untouched. Returns false when the path is blocked by a non-object value.
function setDeep(root: Record<string, unknown>, path: string[], value: JsonValue): boolean {
    let node: Record<string, unknown> = root;
    for (let i = 0; i < path.length - 1; i += 1) {
        const key = path[i];
        const child = node[key];
        if (child === undefined || child === null) {
            node[key] = {};
        } else if (!isRecord(child)) {
            return false;
        }
        node = node[key] as Record<string, unknown>;
    }
    node[path[path.length - 1]] = value;
    return true;
}

async function writePreference(pluginKey: string, path: string[], value: JsonValue): Promise<void> {
    const file = getTuiPreferencesFile();
    await mkdir(dirname(file), { recursive: true });
    let text: string;
    try {
        text = await readFile(file, "utf8");
    } catch {
        text = "";
    }
    if (text.trim() === "") text = TEMPLATE;

    let root: unknown;
    try {
        root = parse(text);
    } catch {
        // The shared file is currently malformed. Skip the write rather than
        // clobber sibling plugins' keys — the user fixes the file, persistence
        // resumes. (Collapse just won't survive restart until then.)
        return;
    }
    if (!isRecord(root)) root = {};
    if (!setDeep(root as Record<string, unknown>, [pluginKey, ...path], value)) {
        return;
    }

    const next = `${stringify(root, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, next, "utf8");
    await rename(tmp, file);
}

let writeChain: Promise<void> = Promise.resolve();

// Writes are serialized on a promise chain: each update re-reads the file,
// applies a comment-preserving edit to one property, and replaces the file
// atomically (temp + rename in the same directory — the only safe cross-process
// swap). Best-effort by design; preferences are never worth crashing the TUI.
export function queueTuiPreferenceUpdate(
    pluginKey: string,
    path: string[],
    value: JsonValue,
): Promise<void> {
    writeChain = writeChain.then(() => writePreference(pluginKey, path, value)).catch(() => {});
    return writeChain;
}

const WATCH_DEBOUNCE_MS = 150;

type WatchReadFile = (file: string) => Promise<string>;
type WatchDirectory = (
    directory: string,
    listener: (event: string, filename: string | null) => void,
) => { close(): void };

let watchReadFile: WatchReadFile = (file) => readFile(file, "utf8");
let watchDirectory: WatchDirectory = (directory, listener) => watch(directory, listener);

export function __setTuiPreferencesWatchTestHooks(hooks: {
    readFile?: WatchReadFile;
    watch?: WatchDirectory;
}): void {
    watchReadFile = hooks.readFile ?? ((file) => readFile(file, "utf8"));
    watchDirectory = hooks.watch ?? ((directory, listener) => watch(directory, listener));
}

export function __resetTuiPreferencesWatchTestHooks(): void {
    watchReadFile = (file) => readFile(file, "utf8");
    watchDirectory = (directory, listener) => watch(directory, listener);
}

// Watches the DIRECTORY, not the file: editors and our own atomic writes replace
// the file via rename, which kills file-level watchers.
//
// Two-stage filtering: (1) a cheap filename pre-filter on the prefs name or our
// `.tmp`; (2) inside the debounce, re-read and compare against last-seen content
// — the authority. Some platforms (macOS FSEvents, some inotify backends)
// misattribute a sibling rename to the real filename, so a name filter alone
// still produces strays; the content compare is robust against that, coalesced
// events, and mtime granularity.
//
// Returns a disposer; never throws.
export function watchTuiPreferences(onChange: () => void): () => void {
    const file = getTuiPreferencesFile();
    const name = basename(file);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeen: string | null = null;
    try {
        lastSeen = readFileSync(file, "utf8");
    } catch {
        // A missing or temporarily unreadable baseline is retried after registration.
    }
    const reconcile = (): void => {
        void watchReadFile(file)
            .catch(() => null)
            .then((text) => {
                if (text === null || text === lastSeen) return;
                lastSeen = text;
                onChange();
            });
    };
    try {
        const watcher = watchDirectory(dirname(file), (_event, filename) => {
            const isOurs =
                filename === name ||
                (filename?.startsWith(`${name}.`) && filename.endsWith(".tmp"));
            if (filename != null && !isOurs) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                reconcile();
            }, WATCH_DEBOUNCE_MS);
        });
        // Reconcile after registration: a change between the baseline read and
        // watcher installation is observed here, while later changes schedule
        // the same reconciliation path through the watcher callback above.
        reconcile();
        return () => {
            if (timer) clearTimeout(timer);
            watcher.close();
        };
    } catch {
        return () => {};
    }
}
