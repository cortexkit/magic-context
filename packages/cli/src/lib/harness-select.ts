/**
 * Harness selection logic for the unified Magic Context CLI.
 *
 * Resolves which adapter(s) a command should target based on:
 *   1. `--harness opencode|pi|omp` flag (hard override, no prompts)
 *   2. Auto-detect installed harnesses, prompting only when ambiguous
 *
 * Mirrors AFT's selection model — battle-tested cross-harness UX.
 */
import { getAdapter, getInstalledAdapters } from "../adapters";
import type { HarnessAdapter, HarnessKind } from "../adapters/types";
import { log, selectMany, selectOne } from "./prompts";

type HarnessFlagResult =
    | { kind: "absent" }
    | { kind: "valid"; harness: HarnessKind }
    | { kind: "invalid"; value: string | null };

function parseHarnessFlag(argv: string[]): HarnessFlagResult {
    const idx = argv.indexOf("--harness");
    if (idx === -1) return { kind: "absent" };
    const value = argv[idx + 1];
    if (!value || value.startsWith("--")) return { kind: "invalid", value: null };
    if (value === "opencode" || value === "pi" || value === "omp") {
        return { kind: "valid", harness: value };
    }
    return { kind: "invalid", value };
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
 *   - `--harness opencode|pi|omp` → return that single adapter (hard override)
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
    if (flag.kind === "valid") return [getAdapter(flag.harness)];
    if (flag.kind === "invalid") {
        throw new Error(
            flag.value === null
                ? "Missing value for --harness (expected opencode, pi, or omp)"
                : `Invalid --harness value: ${flag.value} (expected opencode, pi, or omp)`,
        );
    }

    const installed = getInstalledAdapters();

    if (installed.length === 0) {
        log.warn("No supported harness was detected on PATH (opencode, pi, omp).");
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
            {
                label: "Oh My Pi (OMP)",
                value: "omp",
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
