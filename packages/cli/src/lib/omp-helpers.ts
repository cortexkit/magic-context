import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath, isExecutableFile } from "./find-on-path";
import { getPiCommandInvocation } from "./pi-helpers";

export interface OmpBinaryInfo {
    path: string;
    source: "path" | "home";
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

export function detectOmpBinary(): OmpBinaryInfo | null {
    const fromPath = findOnPath("omp");
    if (fromPath) return { path: fromPath, source: "path" };

    const home = process.env.HOME?.trim() || homedir();
    const candidates =
        process.platform === "win32"
            ? [join(home, ".bun", "bin", "omp.exe"), join(home, ".bun", "bin", "omp.cmd")]
            : [join(home, ".bun", "bin", "omp"), join(home, ".local", "bin", "omp")];
    const candidate = candidates.find((path) => isExecutableFile(path));
    return candidate ? { path: candidate, source: "home" } : null;
}

export function runOmpCommand(ompPath: string, args: string[], timeout = 30_000): OmpCommandResult {
    try {
        const invocation = getPiCommandInvocation(ompPath, args);
        const result = spawnSync(invocation.command, invocation.args, {
            encoding: "utf-8",
            timeout,
            stdio: ["ignore", "pipe", "pipe"],
        });
        return {
            ok: result.status === 0 && !result.error,
            stdout: result.stdout?.trim() ?? "",
            stderr: result.stderr?.trim() ?? result.error?.message ?? "",
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
