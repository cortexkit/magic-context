/**
 * Unified `doctor` command.
 *
 * Dispatches to the per-harness doctor based on `--harness` or auto-detection.
 * Supports `--force`, `--issue`, and `--clear` flags identically across both.
 *
 * `--clear` is special: it presents an interactive picker that lets the user
 * choose which caches to clear across all installed harnesses. It does NOT
 * dispatch through the per-harness flows because the goal is a single "what
 * do I want to nuke?" prompt rather than two separate flows.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { getInstalledAdapters } from "../adapters";
import type { HarnessAdapter } from "../adapters/types";
import {
    openExistingContextDatabase,
    openExistingContextDatabaseForMutation,
} from "../lib/database-access";
import { resolveAdaptersForCommand } from "../lib/harness-select";
import { confirm, intro, log, outro, selectMany, spinner } from "../lib/prompts";
import {
    hasV22Command,
    runV22BackfillCommands,
    type V22BackfillCommandArgs,
} from "../lib/v22-backfill-commands";
import { runDoctor as runOmpDoctor } from "./doctor-omp";
import { runDoctor as runOpenCodeDoctor } from "./doctor-opencode";
import { doctor as runPiDoctor } from "./doctor-pi";

export interface RunDoctorOptions extends V22BackfillCommandArgs {
    force?: boolean;
    issue?: boolean;
    clear?: boolean;
    argv?: string[];
}

export async function runDoctor(options: RunDoctorOptions): Promise<number> {
    if (options.clear) return runClear();

    const argv = options.argv ?? [];
    const adapters = await resolveAdaptersForCommand(argv, {
        allowMulti: true,
        verb: "diagnose",
    });

    if (adapters.length === 0) {
        log.warn("No harness selected.");
        return 0;
    }

    // The v22 backfill commands operate on the SHARED cortexkit DB (harness-
    // agnostic — there is no per-harness shard for backfill state). Run them
    // exactly ONCE here, not once per adapter: dispatching to both an OpenCode
    // and a Pi adapter would run the same rekey/retry/check against the same
    // physical DB twice, producing confusing doubled output (e.g. the second
    // pass reports "Re-keyed 0 row(s)" because the first already moved them).
    if (hasV22Command(options)) {
        let v22Db: ReturnType<typeof openExistingContextDatabase> = null;
        const result = await runV22BackfillCommands(
            {
                name: "Magic Context",
                openDatabase: (readonly = true) => {
                    const dbPath = join(getMagicContextStorageDir(), "context.db");
                    v22Db = readonly
                        ? openExistingContextDatabase(dbPath, { readonly: true })
                        : openExistingContextDatabaseForMutation(dbPath);
                    return v22Db;
                },
                closeDatabase: () => {
                    v22Db?.close();
                    v22Db = null;
                },
                log,
            },
            options,
        );
        if (result.handled) return result.exitCode;
    }

    let anyFailure = false;
    for (const adapter of adapters) {
        log.step(`Running doctor for ${adapter.displayName}…`);
        const code = await dispatchDoctor(adapter, options);
        if (code !== 0) anyFailure = true;
    }
    return anyFailure ? 1 : 0;
}

async function dispatchDoctor(adapter: HarnessAdapter, options: RunDoctorOptions): Promise<number> {
    switch (adapter.kind) {
        // v22 backfill flags are handled once in runDoctor (shared DB), so the
        // per-harness doctors below are NOT forwarded them — that's what
        // prevented the doubled-output bug when both harnesses are installed.
        case "opencode": {
            return runOpenCodeDoctor({
                force: options.force,
                issue: options.issue,
            });
        }
        case "pi": {
            const piArgs: string[] = [];
            if (options.force) piArgs.push("--force");
            if (options.issue) piArgs.push("--issue");
            return runPiDoctor(piArgs);
        }
        case "omp":
            return runOmpDoctor({
                force: options.force,
                issue: options.issue,
            });
    }
}

/**
 * Interactive cache-clear flow. Presents one combined picker showing
 * cleanable caches across every installed harness with their current
 * sizes; the user selects which to clear.
 */
async function runClear(): Promise<number> {
    intro("Magic Context — Clear caches");

    const installed = getInstalledAdapters();
    if (installed.length === 0) {
        log.warn("No installed harnesses detected. Nothing to clear.");
        outro("Done.");
        return 0;
    }

    const items: { adapter: HarnessAdapter; path: string; sizeBytes: number }[] = [];
    for (const adapter of installed) {
        const cache = adapter.getPluginCacheInfo();
        if (cache.path && cache.exists) {
            items.push({ adapter, path: cache.path, sizeBytes: cache.sizeBytes });
        }
    }

    if (items.length === 0) {
        log.info("No clearable plugin caches found across installed harnesses.");
        outro("Done.");
        return 0;
    }

    const picks = await selectMany(
        "Select caches to clear:",
        items.map((item, idx) => ({
            label: `${item.adapter.displayName}: ${formatSize(item.sizeBytes)} — ${item.path}`,
            value: String(idx),
        })),
    );

    if (picks.length === 0) {
        log.info("Nothing selected. Done.");
        outro("Done.");
        return 0;
    }

    const confirmed = await confirm(
        `Delete ${picks.length} cache director${picks.length === 1 ? "y" : "ies"}? This is irreversible.`,
        false,
    );
    if (!confirmed) {
        log.info("Cancelled.");
        outro("Done.");
        return 0;
    }

    let failed = 0;
    for (const idxStr of picks) {
        const idx = Number.parseInt(idxStr, 10);
        const item = items[idx];
        if (!item) continue;
        const s = spinner();
        s.start(`Clearing ${item.path}`);
        try {
            if (existsSync(item.path)) {
                rmSync(item.path, { recursive: true, force: true });
            }
            s.stop(`Cleared ${item.path}`);
        } catch (err) {
            s.stop(`Failed: ${item.path}`);
            log.error((err as Error).message);
            failed += 1;
        }
    }

    outro(failed === 0 ? "Done." : `Done with ${failed} failure(s).`);
    return failed === 0 ? 0 : 1;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
