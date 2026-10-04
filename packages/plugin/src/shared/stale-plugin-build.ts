import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { getHarness, type HarnessId } from "./harness";
import { log } from "./logger";

interface BuildHost {
    dist: string;
    harness: HarnessId;
    notify?: (message: string) => unknown;
}
interface StaleBuildState {
    hosts: Map<string, BuildHost>;
    loggedChunks: Set<string>;
    pendingNotice?: string;
    notified: boolean;
}

// Pi reloads modules and OpenCode can create several plugin instances. Neither
// should reset the process-wide warning or replay an old import rejection.
const STATE = Symbol.for("magic-context.stale-plugin-build");
function state(): StaleBuildState {
    const globals = globalThis as Record<symbol, unknown>;
    return (globals[STATE] ??= {
        hosts: new Map(),
        loggedChunks: new Set(),
        notified: false,
    }) as StaleBuildState;
}

function absolutePath(value: string): string | undefined {
    let path = value;
    if (path.startsWith("file:")) {
        try {
            path = fileURLToPath(path);
        } catch {
            return undefined;
        }
    }
    path = path.replaceAll("\\", "/").replace(/^\/(?=[A-Za-z]:\/)/, "");
    if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path)) return undefined;
    path = posix.normalize(path);
    // Windows paths are case insensitive; POSIX paths are not.
    return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

function distForModule(moduleUrl: string): string | undefined {
    const path = absolutePath(moduleUrl);
    if (!path) return undefined;
    // Use the actual loaded module's location, not a checkout name or cwd: npm
    // installs, linked packages and the dist/v2 entry all use different roots.
    const dist = path.lastIndexOf("/dist/");
    return dist < 0 ? undefined : path.slice(0, dist + "/dist".length);
}

export function stalePluginBuildGuidance(harness: HarnessId): string {
    if (harness === "pi" || harness === "omp")
        return "Magic Context was rebuilt while this Pi was running; type /reload to load the new build";
    if (harness === "claude-code")
        return "Magic Context was rebuilt while this Claude Code session was running; restart Claude Code to load the new build";
    return "Magic Context was rebuilt while this OpenCode host was running; restart the host to load the new build";
}

function deliverNotice(host: BuildHost): void {
    const current = state();
    if (current.notified || !current.pendingNotice || !host.notify) return;
    current.notified = true; // Claim before calling a reentrant or async UI.
    try {
        void Promise.resolve(host.notify(current.pendingNotice)).catch(() => {});
    } catch {
        // The single diagnostic remains available when the UI is shutting down.
    }
}

export function registerStalePluginBuildHost(options: {
    moduleUrl: string;
    harness: HarnessId;
    notify?: (message: string) => unknown;
}): void {
    const dist = distForModule(options.moduleUrl);
    if (!dist) return; // Source-mode imports are not a stale split distribution.
    const host = { ...options, dist };
    state().hosts.set(dist, host);
    deliverNotice(host);
}

export interface StalePluginBuild {
    chunk: string;
    guidance: string;
}

export function classifyStalePluginBuild(error: unknown): StalePluginBuild | null {
    if (error instanceof StalePluginBuildError) return error.build;
    const message = error instanceof Error ? error.message : String(error);
    const missing = message.match(/(?:Cannot find module|ENOENT reading)\s+(['"])(.*?)\1/);
    if (!missing) return null;
    let chunk = absolutePath(missing[2]);
    if (!chunk && /^\.\.?[/\\]/.test(missing[2])) {
        const importer = message
            .slice((missing.index ?? 0) + missing[0].length)
            .match(/(?:imported from|from)\s+(?:['"]([^'"]+)['"]|([^\n]+))/);
        const from = importer && absolutePath((importer[1] ?? importer[2]).trim());
        if (from)
            chunk = absolutePath(posix.join(posix.dirname(from), missing[2].replaceAll("\\", "/")));
    }
    if (!chunk) return null;
    for (const host of state().hosts.values()) {
        if (chunk.startsWith(`${host.dist}/`)) {
            return { chunk, guidance: stalePluginBuildGuidance(host.harness) };
        }
    }
    // Workers and early boot failures can precede host registration. In a split
    // bundle this module also lives in dist; do not guess from the error's path.
    const ownDist = distForModule(import.meta.url);
    return ownDist && chunk.startsWith(`${ownDist}/`)
        ? { chunk, guidance: stalePluginBuildGuidance(getHarness()) }
        : null;
}

export class StalePluginBuildError extends Error {
    constructor(readonly build: StalePluginBuild) {
        super(build.guidance);
        this.name = "StalePluginBuildError";
    }
}

/** undefined means ordinary logging; null means an already reported occurrence. */
export function stalePluginBuildDiagnostic(error: unknown): string | null | undefined {
    // Catch paths sometimes interpolate or rewrap a guarded import's error;
    // reloaded modules also have a different StalePluginBuildError constructor.
    const pending = state().pendingNotice;
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (pending && message.includes(pending)) return null;
    const build = classifyStalePluginBuild(error);
    if (!build) return undefined;
    const current = state();
    current.pendingNotice ??= build.guidance;
    for (const host of current.hosts.values()) deliverNotice(host);
    if (current.loggedChunks.has(build.chunk)) return null;
    current.loggedChunks.add(build.chunk);
    return `[magic-context] stale plugin build: missing ${build.chunk.replace(/[\r\n]/g, " ")}; ${build.guidance}`;
}

/** Keep the import lazy, but classify failures before an outer catch loses their identity. */
export async function importPluginModule<T>(load: () => Promise<T>): Promise<T> {
    try {
        return await load();
    } catch (error) {
        const build = classifyStalePluginBuild(error);
        if (!build) throw error;
        log("[magic-context] lazy import failed", error);
        throw new StalePluginBuildError(build);
    }
}
