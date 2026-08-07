import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { findOnPath, isExecutableFile } from "./find-on-path";
import { getOmpPackageDir } from "./paths";
import { getPiCommandInvocation } from "./pi-helpers";
export interface OmpBinaryInfo {
    path: string;
    source: "path" | "home" | "package";
}

export interface OmpCommandResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

export interface OmpPluginInfo {
    name: string;
    version: string;
    enabled: boolean;
    path?: string;
}

export const OMP_PLUGIN_PACKAGE = "@cortexkit/pi-magic-context";

/**
 * OMP's published CLI is a Bun script (`#!/usr/bin/env bun`), not a native
 * executable, and Windows ignores shebangs entirely. A bare `dist/cli.js` path
 * is therefore only usable when we can run it through Bun ourselves, so
 * package-root discovery reports nothing unless Bun is resolvable.
 */
function detectOmpPackageCli(): string | null {
    const packageDir = getOmpPackageDir();
    if (!packageDir) return null;
    if (!findOnPath("bun")) return null;
    try {
        const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8")) as {
            name?: unknown;
        };
        if (manifest.name !== "@oh-my-pi/pi-coding-agent") return null;
        const cli = join(packageDir, "dist", "cli.js");
        return existsSync(cli) ? cli : null;
    } catch {
        return null;
    }
}

/** Build the argv for an OMP path, routing Bun scripts through the Bun runtime. */
export function getOmpCommandInvocation(
    ompPath: string,
    args: string[],
): { command: string; args: string[] } {
    if (extname(ompPath).toLowerCase() === ".js") {
        const bun = findOnPath("bun");
        if (bun) return { command: bun, args: [ompPath, ...args] };
    }
    return getPiCommandInvocation(ompPath, args);
}

export function getOmpFallbackCandidates(
    platform: NodeJS.Platform,
    home: string,
    appData?: string,
): string[] {
    if (platform !== "win32") {
        return [join(home, ".bun", "bin", "omp"), join(home, ".local", "bin", "omp")];
    }
    const npmRoot = appData?.trim();
    return [
        ...(npmRoot ? [join(npmRoot, "npm", "omp.cmd"), join(npmRoot, "npm", "omp.exe")] : []),
        join(home, ".bun", "bin", "omp.exe"),
        join(home, ".bun", "bin", "omp.cmd"),
    ];
}

export function detectOmpBinary(): OmpBinaryInfo | null {
    const fromPath = findOnPath("omp");
    if (fromPath) return { path: fromPath, source: "path" };

    const fromPackage = detectOmpPackageCli();
    if (fromPackage) return { path: fromPackage, source: "package" };

    const home = process.env.HOME?.trim() || homedir();
    const candidates = getOmpFallbackCandidates(process.platform, home, process.env.APPDATA);
    const candidate = candidates.find((path) => isExecutableFile(path));
    return candidate ? { path: candidate, source: "home" } : null;
}

export function runOmpCommand(ompPath: string, args: string[], timeout = 30_000): OmpCommandResult {
    try {
        const invocation = getOmpCommandInvocation(ompPath, args);
        const result = spawnSync(invocation.command, invocation.args, {
            encoding: "utf-8",
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return {
            ok: result.status === 0 && !result.error,
            stdout: result.stdout?.trim() ?? "",
            stderr: result.stderr?.trim() || result.error?.message || "",
        };
    } catch (error) {
        return {
            ok: false,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
        };
    }
}

export function getOmpVersion(ompPath: string): string | null {
    const result = runOmpCommand(ompPath, ["--version"], 10_000);
    if (!result.ok) return null;
    const match = (result.stdout || result.stderr).match(
        /(?:omp\/)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/,
    );
    return match?.[1] ?? null;
}

export function parseOmpModelsOutput(output: string): string[] {
    try {
        const parsed = JSON.parse(output) as { models?: unknown };
        if (!Array.isArray(parsed.models)) return [];
        const models = new Set<string>();
        for (const entry of parsed.models) {
            if (!entry || typeof entry !== "object") continue;
            const value = entry as Record<string, unknown>;
            if (typeof value.selector === "string" && value.selector.length > 0) {
                models.add(value.selector);
                continue;
            }
            if (
                typeof value.provider === "string" &&
                value.provider.length > 0 &&
                typeof value.id === "string" &&
                value.id.length > 0
            ) {
                models.add(`${value.provider}/${value.id}`);
            }
        }
        return [...models];
    } catch {
        return [];
    }
}

export function getOmpAvailableModels(ompPath: string): string[] {
    const result = runOmpCommand(ompPath, ["models", "--json"], 30_000);
    return result.ok ? parseOmpModelsOutput(result.stdout) : [];
}

export function listOmpPlugins(ompPath: string): OmpPluginInfo[] | null {
    const result = runOmpCommand(ompPath, ["plugin", "list", "--json"], 30_000);
    if (!result.ok) return null;
    try {
        const parsed = JSON.parse(result.stdout) as { npm?: unknown };
        if (!Array.isArray(parsed.npm)) return [];
        return parsed.npm.flatMap((entry): OmpPluginInfo[] => {
            if (!entry || typeof entry !== "object") return [];
            const value = entry as Record<string, unknown>;
            if (typeof value.name !== "string" || typeof value.version !== "string") return [];
            return [
                {
                    name: value.name,
                    version: value.version,
                    enabled: value.enabled !== false,
                    ...(typeof value.path === "string" ? { path: value.path } : {}),
                },
            ];
        });
    } catch {
        return null;
    }
}

export function getOmpSetting(ompPath: string, key: "compaction.enabled"): boolean | null;
export function getOmpSetting(ompPath: string, key: "memory.backend"): string | null;
export function getOmpSetting(
    ompPath: string,
    key: "compaction.enabled" | "memory.backend",
): boolean | string | null {
    const result = runOmpCommand(ompPath, ["config", "get", key, "--json"], 10_000);
    if (!result.ok) return null;
    try {
        const parsed = JSON.parse(result.stdout) as { value?: unknown };
        return typeof parsed.value === "boolean" || typeof parsed.value === "string"
            ? parsed.value
            : null;
    } catch {
        return null;
    }
}
