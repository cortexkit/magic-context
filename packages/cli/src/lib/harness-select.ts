/**
 * Harness selection logic for the unified Magic Context CLI.
 *
 * Resolves which adapter(s) a command should target based on:
 *   1. `--harness opencode|pi` flag (hard override, no prompts)
 *   2. Auto-detect installed harnesses, prompting only when ambiguous
 *
 * Mirrors AFT's selection model — battle-tested cross-harness UX.
 */
import { getAdapter, getInstalledAdapters } from "../adapters";
import type { HarnessAdapter, HarnessKind } from "../adapters/types";
import { log, selectMany, selectOne } from "./prompts";

function parseHarnessFlag(argv: string[]): HarnessKind | null {
    const idx = argv.indexOf("--harness");
    if (idx === -1 || idx === argv.length - 1) return null;
    const value = argv[idx + 1];
    if (value === "opencode" || value === "pi") return value;
    return null;
}

export interface ResolveOptions {
    /** Allow the user to select multiple harnesses at once. Setup defaults to single. */
    allowMulti: boolean;
    /** Verb used in prompts ("setup" / "diagnose"). */
    verb: string;
}

/**
 * Resolve which adapter(s) to act on for the given command invocation.
 *
 * Decision tree:
 *   - `--harness opencode|pi` → return that single adapter (hard override)
 *   - 0 installed → prompt user to pick one (gives install hints)
 *   - 1 installed → use it silently
 *   - 2+ installed:
 *       - allowMulti=true → multiselect
 *       - allowMulti=false → single-select
 */
export async function resolveAdaptersForCommand(
    argv: string[],
    options: ResolveOptions,
): Promise<HarnessAdapter[]> {
    const flag = parseHarnessFlag(argv);
    if (flag) return [getAdapter(flag)];

    const installed = getInstalledAdapters();

    if (installed.length === 0) {
        log.warn("No supported harness was detected on PATH (opencode, pi).");
        const pick = await selectOne(`Which harness do you want to ${options.verb}?`, [
            {
                label: "OpenCode",
                value: "opencode",
                hint: "@cortexkit/opencode-magic-context",
            },
            {
                label: "Pi",
                value: "pi",
                hint: "@cortexkit/pi-magic-context",
            },
        ]);
        return [getAdapter(pick as HarnessKind)];
    }

    if (installed.length === 1) {
        const only = installed[0];
        log.info(`Detected ${only.displayName} — using it for ${options.verb}.`);
        return [only];
    }

    // Multiple installed.
    if (options.allowMulti) {
        const picks = await selectMany(
            `Multiple harnesses detected — which to ${options.verb}?`,
            installed.map((a) => ({ label: a.displayName, value: a.kind })),
            installed.map((a) => a.kind),
        );
        if (picks.length === 0) {
            log.warn("No harness selected; nothing to do.");
            return [];
        }
        return picks.map((kind) => getAdapter(kind as HarnessKind));
    }

    const pick = await selectOne(
        `Multiple harnesses detected — which one to ${options.verb}?`,
        installed.map((a) => ({ label: a.displayName, value: a.kind })),
    );
    return [getAdapter(pick as HarnessKind)];
}
