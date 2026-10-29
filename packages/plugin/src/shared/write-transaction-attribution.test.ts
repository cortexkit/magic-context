import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestTempDirFromPath } from "./test-temp-dir";

const repoRoot = resolve(import.meta.dir, "../../../../");
const beginImmediate = /\b(?:[A-Za-z_$][\w$]*\.)?exec\("BEGIN IMMEDIATE"\)/g;

const fencedSources: Array<{ path: string; sites: string[]; reporterCalls?: string[] }> = [
    {
        path: "packages/plugin/src/features/magic-context/smart-notes/storage.ts",
        sites: ["smart_note_commit"],
    },
    {
        path: "packages/plugin/src/hooks/magic-context/inject-compartments.ts",
        sites: ["opencode_materialize_cache", "opencode_soft_refresh_cache"],
    },
    {
        path: "packages/plugin/src/features/magic-context/message-index.ts",
        sites: ["message_index_incremental", "message_index_reconcile"],
    },
    {
        path: "packages/plugin/src/features/magic-context/storage-meta-persisted.ts",
        sites: [
            "storage_meta_wrapup_expiry_cleanup",
            "storage_meta_wrapup_acquire",
            "storage_meta_wrapup_update",
            "storage_meta_wrapup_release",
        ],
    },

    {
        path: "packages/plugin/src/features/magic-context/compartment-storage.ts",
        sites: ["compartment_state_replace", "recomp_staging_promote"],
    },
    {
        path: "packages/plugin/src/features/magic-context/project-embedding-registry.ts",
        sites: ["embedding_identity_record", "embedding_stale_gc"],
    },
    {
        path: "packages/plugin/src/features/magic-context/workspaces.ts",
        sites: ["workspace_epoch_bump", "workspace_epoch_bump"],
    },
    {
        // The chokepoint cannot import the logging chain (Node executes it
        // directly), so it reports through the injected reporter instead.
        path: "packages/plugin/src/shared/sqlite.ts",
        sites: ["async_acquisition_dynamic_site", "privileged_writer"],
        reporterCalls: ["reportSqliteDiagnostic(", "reportSlowPrivilegedWrite?.("],
    },
    {
        path: "packages/plugin/src/features/magic-context/git-commits/sweep-coordinator.ts",
        sites: ["git_sweep_lease"],
    },
    {
        path: "packages/plugin/src/features/magic-context/session-project-backfill.ts",
        sites: ["session_project_backfill"],
    },
    {
        path: "packages/plugin/src/tools/ctx-memory/verification-recording.ts",
        sites: ["ctx_memory_mutation"],
    },
    {
        path: "packages/plugin/src/features/magic-context/storage-clone.ts",
        sites: ["storage_clone_copy"],
    },
    {
        path: "packages/plugin/src/hooks/magic-context/compartment-runner-recomp.ts",
        sites: ["historian-publish:recomp"],
    },
    {
        path: "packages/plugin/src/features/magic-context/dreamer/lease.ts",
        sites: ["lease_dynamic_site"],
    },
    {
        path: "packages/pi-plugin/src/inject-compartments-pi.ts",
        sites: ["pi_materialize_cache", "pi_soft_refresh_cache"],
    },
    {
        path: "packages/pi-plugin/src/pi-historian-runner.ts",
        sites: ["pi_historian_publish"],
    },
    {
        path: "packages/pi-plugin/src/context-handler.ts",
        sites: ["pi_fallback_adoption"],
    },
];

const nonBeginCoveredSites: Array<{ path: string; site: string }> = [
    {
        path: "packages/plugin/src/hooks/magic-context/lkg-persist.ts",
        site: "lkg_stale_gc",
    },
    {
        path: "packages/plugin/src/hooks/magic-context/compartment-runner-incremental.ts",
        site: "historian-publish",
    },
    {
        path: "packages/plugin/src/features/magic-context/message-index.ts",
        site: "message_index_clear",
    },
    {
        path: "packages/plugin/src/features/magic-context/message-fts-rowid-map.ts",
        site: "message_fts_rowid_backfill",
    },
    {
        path: "packages/plugin/src/hooks/magic-context/note-nudger.ts",
        site: "note_nudge_trigger",
    },
    {
        path: "packages/plugin/src/features/magic-context/user-memory/storage-user-memory.ts",
        site: "user_memory_candidate_insert",
    },
];

let scenarioRoot: string | null = null;
let scenarioLogPath: string | null = null;

const newlyCoveredSites = [
    "opencode_materialize_cache",
    "opencode_soft_refresh_cache",
    "message_index_incremental",
    "message_index_reconcile",
    "message_index_clear",
    "message_fts_rowid_backfill",
    "storage_meta_wrapup_expiry_cleanup",
    "storage_meta_wrapup_acquire",
    "storage_meta_wrapup_update",
    "storage_meta_wrapup_release",
    "authority_marker_capture",
    "authority_capture_check",
    "compartment_state_replace",
    "recomp_staging_promote",
    "embedding_identity_record",
    "embedding_stale_gc",
    "workspace_epoch_bump",
    "privileged_writer",
    "git_sweep_lease",
    "session_project_backfill",
    "ctx_memory_mutation",
    "storage_clone_copy",
    "smart_note_commit",
    "pi_materialize_cache",
    "pi_soft_refresh_cache",
    "pi_historian_publish",
    "pi_fallback_adoption",
    "note_nudge_trigger",
    "user_memory_candidate_insert",
] as const;

function sourceFor(relativePath: string): string {
    return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function assertCoveredBeginImmediate(
    source: string,
    sites: string[],
    reporterCalls: string[] = [],
): void {
    const matches = [...source.matchAll(beginImmediate)];
    expect(matches).toHaveLength(sites.length);
    for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const nextBegin = matches[index + 1]?.index ?? source.length;
        const transactionRegion = source.slice(match.index, nextBegin);
        expect(transactionRegion).toContain(reporterCalls[index] ?? "logSlowWriteTransaction(");
        if (sites[index] === "async_acquisition_dynamic_site") {
            expect(transactionRegion).toContain("site=${site}");
        } else if (sites[index] === "lease_dynamic_site") {
            expect(transactionRegion).toContain("logSlowWriteTransaction(site");
        } else {
            expect(transactionRegion).toContain(`"${sites[index]}"`);
        }
    }
}

describe("write transaction attribution fences", () => {
    beforeAll(async () => {
        scenarioRoot = createTestTempDirFromPath(
            join(tmpdir(), "magic-context-write-attribution-"),
        );
        scenarioLogPath = join(scenarioRoot, "transactions.log");
        const scenario = `
            const timing = await import(${JSON.stringify(new URL("./write-transaction-timing.ts", import.meta.url).href)});
            const logger = await import(${JSON.stringify(new URL("./logger.ts", import.meta.url).href)});
            for (const site of ${JSON.stringify(newlyCoveredSites)}) {
                timing.logSlowWriteTransaction(site, 1_000, 1_000, 2_100);
                timing.logSlowWriteTransaction(site, 2_000, 1_000, 2_100);
            }
            logger.flushLogger();
        `;
        const child = Bun.spawn({
            windowsHide: true,
            cmd: ["bun", "--eval", scenario],
            cwd: import.meta.dir,
            env: {
                ...process.env,
                NODE_ENV: "production",
                MAGIC_CONTEXT_LOG_PATH: scenarioLogPath,
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
        ]);
        expect(exitCode, stderr).toBe(0);
    });

    afterAll(() => {
        if (scenarioRoot) rmSync(scenarioRoot, { recursive: true, force: true });
        scenarioRoot = null;
        scenarioLogPath = null;
    });

    test("lists every BEGIN IMMEDIATE writer and requires a covered site", () => {
        for (const fencedSource of fencedSources) {
            assertCoveredBeginImmediate(
                sourceFor(fencedSource.path),
                fencedSource.sites,
                fencedSource.reporterCalls,
            );
        }
        for (const coveredSite of nonBeginCoveredSites) {
            expect(sourceFor(coveredSite.path)).toContain(
                `logSlowWriteTransaction("${coveredSite.site}"`,
            );
        }
    });

    for (const site of newlyCoveredSites) {
        test(`logs a slow and suppresses a sub-threshold transaction at site=${site}`, () => {
            if (!scenarioLogPath) throw new Error("timing scenario did not start");
            const lines = readFileSync(scenarioLogPath, "utf8")
                .split("\n")
                .filter((line) => line.includes(`site=${site}`));
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain("held=1100.0ms");
        });
    }
});
