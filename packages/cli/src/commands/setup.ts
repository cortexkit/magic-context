/**
 * Unified `setup` command.
 *
 * Resolves the harness target via `--harness` flag or auto-detection
 * (`resolveAdaptersForCommand`), then dispatches to the per-harness
 * setup flows instead of collapsing them into one generic flow: OpenCode has
 * DCP/OMO conflicts, while Pi and OMP share the extension runtime but differ in
 * installation and native context/memory conflict handling.
 */
import type { HarnessAdapter } from "../adapters/types";
import { resolveAdaptersForCommand } from "../lib/harness-select";
import { intro, log, note, outro } from "../lib/prompts";
import { runSetup as runOmpSetup } from "./setup-omp";
import { runSetup as runOpenCodeSetup } from "./setup-opencode";
import { runSetup as runPiSetup } from "./setup-pi";

export async function runSetup(argv: string[]): Promise<number> {
    const dryRun = argv.includes("--dry-run");
    intro(dryRun ? "Magic Context setup (dry run)" : "Magic Context setup");

    let adapters: HarnessAdapter[];
    try {
        adapters = await resolveAdaptersForCommand(argv, {
            // Both harness wizards write the same Magic Context config. Keep setup
            // single-target until shared choices are collected once and registration
            // is split into harness-specific phases.
            allowMulti: false,
            verb: "setup",
        });
    } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        outro("Setup stopped — correct the command arguments and try again.");
        return 1;
    }

    if (adapters.length === 0) {
        outro("No harness selected. Nothing to do.");
        return 0;
    }

    let anyFailure = false;
    for (const adapter of adapters) {
        log.step(`Configuring ${adapter.displayName} (${adapter.pluginPackageName})…`);

        // Each harness owns its no-host flow. In particular, an explicit OpenCode
        // setup can continue for a Desktop or not-yet-installed host.
        const code = await dispatchSetup(adapter, dryRun);
        if (code !== 0) {
            anyFailure = true;
            continue;
        }
        if (!dryRun) printNextSteps(adapter);
    }

    if (anyFailure) {
        outro("Setup finished with warnings — see above.");
        return 1;
    }
    outro(dryRun ? "Dry run done — no changes were made." : "Done.");
    return 0;
}

async function dispatchSetup(adapter: HarnessAdapter, dryRun: boolean): Promise<number> {
    switch (adapter.kind) {
        case "opencode":
            return runOpenCodeSetup(dryRun);
        case "pi":
            return runPiSetup({ dryRun });
        case "omp":
            return runOmpSetup({ dryRun });
    }
}

function printNextSteps(adapter: HarnessAdapter): void {
    if (adapter.kind === "opencode") {
        note(
            [
                "Restart OpenCode (or reload your session) so the plugin loads.",
                "Verify with: npx @cortexkit/magic-context@latest doctor",
            ].join("\n"),
            "Next steps",
        );
        return;
    }
    if (adapter.kind === "pi") {
        note(
            [
                "Restart your Pi session so the extension registers.",
                "Verify with: npx @cortexkit/magic-context@latest doctor --harness pi",
            ].join("\n"),
            "Next steps",
        );
    }
    if (adapter.kind === "omp") {
        note(
            [
                "Restart OMP (or run /reload-plugins) so Magic Context registers.",
                "Verify with: npx @cortexkit/magic-context@latest doctor --harness omp",
            ].join("\n"),
            "Next steps",
        );
    }
}
