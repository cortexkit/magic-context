import { execFileSync, execSync } from "node:child_process";
import { extname } from "node:path";
import type { OpenCodeInstallation } from "./opencode-detect";

export interface OpenCodeCommandInvocation {
    command: string;
    args: string[];
    env?: Record<string, string>;
    windowsVerbatimArguments?: true;
}

const OPENCODE_BINARY_ENV = "MAGIC_CONTEXT_OPENCODE_BINARY";

export function getOpenCodeCommandInvocation(
    binary: string,
    args: string[],
): OpenCodeCommandInvocation {
    const extension = extname(binary).toLowerCase();
    if (extension !== ".cmd" && extension !== ".bat") {
        return { command: binary, args };
    }

    const command = process.env.ComSpec?.trim() || process.env.COMSPEC?.trim() || "cmd.exe";
    // cmd.exe needs the /c payload as one outer-quoted command string. Pass the
    // binary through the child environment so percent signs in a valid path are
    // not treated as another variable expansion. Current callers only supply the
    // fixed `--version` and `models` arguments.
    const commandLine = [`%${OPENCODE_BINARY_ENV}%`, ...args]
        .map((part) => `"${part}"`)
        .join(" ");
    return {
        command,
        args: ["/d", "/s", "/v:off", "/c", `"${commandLine}"`],
        env: { [OPENCODE_BINARY_ENV]: binary },
        windowsVerbatimArguments: true,
    };
}

/**
 * Run `opencode <args>`. If a `binary` path is given (an absolute path resolved
 * for a stock `~/.opencode/bin` install or a version-manager shim that is not on
 * PATH), invoke that exact path; otherwise fall back to a bare
 * `opencode` on PATH.
 */
function runOpenCode(args: string[], binary?: string | null, timeoutMs?: number): string | null {
    try {
        const options = { stdio: "pipe" as const, ...(timeoutMs ? { timeout: timeoutMs } : {}) };
        if (binary) {
            const invocation = getOpenCodeCommandInvocation(binary, args);
            return execFileSync(invocation.command, invocation.args, {
                ...options,
                ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}),
                ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            })
                .toString()
                .trim();
        }
        return execSync(`opencode ${args.join(" ")}`, options)
            .toString()
            .trim();
    } catch {
        return null;
    }
}

/**
 * Version probes must be bounded because a broken shim can wait forever. The
 * doctor probes every detected install, so a per-process timeout is important.
 */
export const OPENCODE_VERSION_PROBE_TIMEOUT_MS = 2_000;

export function getOpenCodeVersion(binary?: string | null): string | null {
    return runOpenCode(["--version"], binary, OPENCODE_VERSION_PROBE_TIMEOUT_MS);
}

export interface OpenCodeInstallationReport extends OpenCodeInstallation {
    version: string;
    active: boolean;
}

/** Probe versions for all detected installs, retaining the detection order. */
export function describeOpenCodeInstallations(
    installations: OpenCodeInstallation[],
): OpenCodeInstallationReport[] {
    return installations.map((installation, index) => ({
        ...installation,
        version:
            installation.kind === "cli"
                ? (getOpenCodeVersion(installation.path) ?? "unknown")
                : "unknown",
        active: index === 0,
    }));
}

export function getAvailableModels(binary?: string | null): string[] {
    const output = runOpenCode(["models"], binary);
    if (output === null) return [];
    return output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
}
