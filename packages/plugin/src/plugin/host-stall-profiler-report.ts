/**
 * Pure helpers for the host stall profiler: turning raw JavaScriptCore
 * sampling-profiler traces into an aggregated, owner-attributed report.
 *
 * Kept separate from the runtime controller (`host-stall-profiler.ts`) so the
 * attribution rules can be tested without timers, files or `bun:jsc`.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

/** One frame as `bun:jsc` `samplingProfilerStackTraces()` reports it. */
export interface JscSampleFrame {
    name?: string;
    sourceURL?: string;
    line?: number;
    column?: number;
    category?: string;
}

/** One sample: `frames[0]` is the innermost (currently executing) frame. */
export interface JscSampleTrace {
    /** JSC monotonic clock, seconds. Not the same origin as `performance.now()`. */
    timestamp?: number;
    frames?: JscSampleFrame[];
}

/** Deepest stack kept per sample; deeper frames are folded into one marker. */
export const MAX_STACK_DEPTH = 64;
export const TOP_STACK_COUNT = 30;
export const TOP_FRAME_COUNT = 30;

/** JSC uses UINT32_MAX for "no line/column known". */
const UNKNOWN_POSITION = 4294967295;

/**
 * Owners that never explain a stall by themselves: a native host function is
 * attributed to its JavaScript caller, and OpenCode/runtime frames sit below
 * every plugin hook. A sample is attributed to the innermost frame whose owner
 * is NOT one of these, so a plugin calling a blocking native API is blamed,
 * not the native API or the host that invoked the plugin.
 */
const BACKGROUND_OWNERS = new Set(["native", "runtime", "opencode"]);

const packageNameCache = new Map<string, string | null>();

function urlToPath(url: string): string {
    if (url.startsWith("file://")) {
        try {
            return decodeURIComponent(new URL(url).pathname);
        } catch {
            return url.slice("file://".length);
        }
    }
    return url;
}

/**
 * Nearest `package.json` name above a source file, memoized per directory.
 * Only reached for sources outside `node_modules` (a plugin loaded from a
 * local checkout), and only after a stall has ended, so the bounded
 * synchronous reads never run on a hot path.
 */
function nearestPackageName(filePath: string): string | null {
    let dir = path.dirname(filePath);
    const visited: string[] = [];
    for (let depth = 0; depth < 12; depth++) {
        const cached = packageNameCache.get(dir);
        if (cached !== undefined) {
            for (const seen of visited) packageNameCache.set(seen, cached);
            return cached;
        }
        visited.push(dir);
        try {
            const parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
                name?: unknown;
            };
            const name = typeof parsed.name === "string" && parsed.name ? parsed.name : null;
            if (name) {
                for (const seen of visited) packageNameCache.set(seen, name);
                return name;
            }
        } catch {
            // No readable package.json at this level; keep walking up.
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    for (const seen of visited) packageNameCache.set(seen, null);
    return null;
}

/**
 * Map a frame's source URL to the code that owns it.
 *
 * - no URL: `native` (a host function such as a SQLite `get` or `readFileSync`)
 * - Bun/Node builtin modules: `runtime`
 * - the compiled OpenCode binary's embedded filesystem (`$bunfs`, `~BUN`): `opencode`
 * - anything under `node_modules/<pkg>`: `npm:<pkg>` (the innermost package)
 * - a file in an OpenCode `plugin/` or `plugins/` directory: `plugin:<file>`
 * - any other file: `pkg:<name>` from the nearest package.json, else `file:<path>`
 */
export function sourceOwner(sourceURL: string | undefined): string {
    if (!sourceURL) return "native";
    if (/^(?:node|bun|builtin|internal):/.test(sourceURL)) return "runtime";
    if (sourceURL.includes("$bunfs") || sourceURL.includes("~BUN")) return "opencode";
    const filePath = urlToPath(sourceURL).replaceAll("\\", "/");
    const modules = [...filePath.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/g)];
    const innermost = modules.at(-1);
    if (innermost) return `npm:${innermost[1]}`;
    const pluginDir = filePath.match(/\/plugins?\/([^/]+)$/);
    if (pluginDir && /\/(?:\.?opencode)\/plugins?\//.test(filePath)) {
        return `plugin:${pluginDir[1]}`;
    }
    const name = nearestPackageName(filePath);
    return name ? `pkg:${name}` : `file:${filePath}`;
}

function frameLabel(frame: JscSampleFrame): string {
    const name = frame.name && frame.name.length > 0 ? frame.name : "(anonymous)";
    if (!frame.sourceURL) return `${name} [native]`;
    const line =
        typeof frame.line === "number" && frame.line !== UNKNOWN_POSITION ? `:${frame.line}` : "";
    return `${name} ${frame.sourceURL}${line}`;
}

export interface OwnedFrame {
    label: string;
    owner: string;
}

/** The innermost frame that explains the sample (see `BACKGROUND_OWNERS`). */
export function attributeSample(frames: OwnedFrame[]): string {
    for (const frame of frames) {
        if (!BACKGROUND_OWNERS.has(frame.owner)) return frame.owner;
    }
    for (const frame of frames) {
        if (frame.owner !== "native") return frame.owner;
    }
    return "native";
}

export interface CountedFrame {
    frame: string;
    owner: string;
    samples: number;
}

export interface CountedStack {
    samples: number;
    owner: string;
    frames: string[];
}

export interface StallAggregate {
    samples: number;
    owners: Array<{ owner: string; samples: number; percent: number }>;
    /** Innermost frame of each sample, native host functions included. */
    top_frames: CountedFrame[];
    /** Innermost frame that has JavaScript source, i.e. the JS caller of any native frame. */
    top_js_frames: CountedFrame[];
    top_stacks: CountedStack[];
}

function bump<T>(map: Map<string, T & { samples: number }>, key: string, init: () => T): void {
    const existing = map.get(key);
    if (existing) existing.samples += 1;
    else map.set(key, { ...init(), samples: 1 });
}

function topBySamples<T extends { samples: number }>(values: Iterable<T>, limit: number): T[] {
    return [...values].sort((a, b) => b.samples - a.samples).slice(0, limit);
}

export function aggregateTraces(traces: JscSampleTrace[]): StallAggregate {
    const ownerOf = new Map<string, string>();
    const owned = (frame: JscSampleFrame): OwnedFrame => {
        const url = frame.sourceURL ?? "";
        let owner = ownerOf.get(url);
        if (owner === undefined) {
            owner = sourceOwner(frame.sourceURL);
            ownerOf.set(url, owner);
        }
        return { label: frameLabel(frame), owner };
    };

    const owners = new Map<string, { owner: string; samples: number }>();
    const topFrames = new Map<string, CountedFrame>();
    const topJsFrames = new Map<string, CountedFrame>();
    const stacks = new Map<string, CountedStack>();
    let samples = 0;

    for (const trace of traces) {
        const raw = Array.isArray(trace.frames) ? trace.frames : [];
        if (raw.length === 0) continue;
        samples += 1;
        const frames = raw.slice(0, MAX_STACK_DEPTH).map(owned);
        const owner = attributeSample(frames);
        bump(owners, owner, () => ({ owner }));

        const leaf = frames[0];
        bump(topFrames, `${leaf.owner}\u0000${leaf.label}`, () => ({
            frame: leaf.label,
            owner: leaf.owner,
        }));
        const jsIndex = raw.findIndex(
            (frame, index) => index < MAX_STACK_DEPTH && !!frame.sourceURL,
        );
        if (jsIndex >= 0) {
            const js = frames[jsIndex];
            bump(topJsFrames, `${js.owner}\u0000${js.label}`, () => ({
                frame: js.label,
                owner: js.owner,
            }));
        }

        const labels = frames.map((frame) => `${frame.label} (${frame.owner})`);
        if (raw.length > MAX_STACK_DEPTH) {
            labels.push(`… ${raw.length - MAX_STACK_DEPTH} outer frames omitted`);
        }
        bump(stacks, labels.join("\n"), () => ({ owner, frames: labels }));
    }

    return {
        samples,
        owners: topBySamples(owners.values(), Number.POSITIVE_INFINITY).map((entry) => ({
            ...entry,
            percent: samples === 0 ? 0 : Math.round((entry.samples / samples) * 1000) / 10,
        })),
        top_frames: topBySamples(topFrames.values(), TOP_FRAME_COUNT),
        top_js_frames: topBySamples(topJsFrames.values(), TOP_FRAME_COUNT),
        top_stacks: topBySamples(stacks.values(), TOP_STACK_COUNT),
    };
}
