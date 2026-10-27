export const CONTEXT_CRASH_VERSIONS = [96, 98, 100, 103] as const;
export const STORE_CRASH_VERSIONS = [64, 66, 70, 71, 72, 73, 74, 75] as const;

export const EFFECTS = {
    context: {
        96: "additive lkg_slots columns and lkg_served_markers; no original content rewrite",
        97: "new host_runner_* tables; no original content rewrite",
        98: "new rescore/score tables, metadata watermark default 0 and activation clock; archive unchanged",
        99: "memory lifecycle tables and revision/verification columns; memory content unchanged",
        100: "nullable served_prefix and held_release metadata; existing keys unchanged",
        101: "trimmed-source tag retirement indexes; no content rewrite",
        102: "nullable served_digest on served markers; existing NULL certifies no content",
        103: "moves five render-cache values into session_render_cache and eight collections into session_meta_chunks with durable revisions, then drops the 13 inline columns; preserves SQLite storage class, NULL versus empty and raw UTF-8 bytes through production accessors; refuses non-UTF-8 databases before changes",
    },
    store: {
        64: "new move inventory tables; no released-domain reset",
        65: "new provider sessions/catalogs; no released cache reset",
        66: "copies provider records into conversation/message/answer/view/tag ledgers; released 63 has no provider rows",
        67: "fence only; no rewrite",
        68: "provider policy summaries/triggers; no old cache reset",
        69: "memory projection tables; no memory content reset",
        70: "rebuilds provider conversations with native generation columns, preserving identities and recreating triggers",
        71: "policy revision/preparation caches and invalidation triggers; no released-63 table rewrite",
        72: "discards undeployed provider projections introduced at 65+, adds policy facts/cuts/overrides/views; all released-63 rows remain audited",
        73: "resets only undeployed v1-view conversations and drops v1 views; v2 recipes replace them; released 63 has no such rows",
        74: "adds mc_async_compaction, mc_async_compaction_entries, mc_async_compaction_views and mc_async_compaction_baselines for async state, held transcripts, published views and engine baselines; additive tables only, no existing row reset or rewrite",
        75: "adds a nullable mid column to held async entries backfilled from entry_json plus session and (session_ref, mid) indexes; existing rows and entry content unchanged",
    },
} as const;

export function assertEffects(context: number, store: number): void {
    for (const [kind, baseline, head] of [["context", 95, context], ["store", 63, store]] as const) {
        const effects: Record<number, string> = EFFECTS[kind];
        if (head !== Math.max(...Object.keys(effects).map(Number)))
            throw new Error(`Migration effects manifest needs review for ${kind} ${head}`);
        for (let version = baseline + 1; version <= head; version++)
            if (!effects[version]) throw new Error(`Missing ${kind} migration effect ${version}`);
    }
}

export function assertCrashCoverage(results: { name: string; migration: number; complete?: boolean }[]): void {
    for (const route of ["typescript", "rust", "store"])
        for (const migration of route === "store" ? STORE_CRASH_VERSIONS : CONTEXT_CRASH_VERSIONS)
            if (!results.some((r) => r.name === route && r.migration === migration && r.complete === true))
                throw new Error(`Missing crash/reopen proof ${route} ${migration}`);
}

export function assertBundles(loaded: string[]): void {
    for (const bundle of ["plugin", "pi-plugin"])
        if (!loaded.includes(bundle)) throw new Error(`Bundle did not load: ${bundle}`);
}

export function assertDoctor(output: string): void {
    const result = JSON.parse(output) as Record<string, boolean>;
    if (["schema", "integrity", "foreignKeys", "shadowBackfills", "maintenance", "compartments"].some((name) => result[name] !== true))
        throw new Error(`Doctor did not report a clean migrated store: ${output}`);
}

export function assertFullDoctorTarget(output: string, directory: string, host: string): void {
    if (!output.includes(directory) || output.includes("TEST BACKSTOP") || (host === "pi" && !output.includes("SQLite integrity_check: ok")))
        throw new Error(`Full ${host} doctor did not inspect the intended migrated store`);
}

export type MigrationMetric = {database: string; version: number; seconds: number; peakKiB: number; beforeMainWal: number[]; afterMainWal: number[]};
export function assertMigrationMetrics(metrics: MigrationMetric[]): void {
    for (const [database, start, end] of [["context", 96, 103], ["store", 64, 75]] as const)
        for (let version = start; version <= end; version++) {
            const rows = metrics.filter((row) => row.database === database && row.version === version);
            if (rows.length !== 1 || !Number.isFinite(rows[0].seconds) || rows[0].seconds < 0 || !(rows[0].peakKiB > 0) || rows[0].beforeMainWal.length !== 2 || rows[0].afterMainWal.length !== 2)
                throw new Error(`Missing or invalid migration measurement: ${database} ${version}`);
        }
}

export function assertArtifactIdentity(manifest: {candidate: string; arch: string; platform: string}, expected: string, arch: string): void {
    if (!/^[0-9a-f]{40}$/.test(expected) || manifest.candidate !== expected || manifest.arch !== arch || manifest.platform !== "linux")
        throw new Error("Prebuilt artifact revision/architecture mismatch");
}
