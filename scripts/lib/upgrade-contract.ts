export const EFFECTS = {
    96: "additive LKG columns and served markers; original content unchanged",
    97: "host-runner tables; original content unchanged",
    98: "score tables and metadata watermarks; archive unchanged",
    99: "memory lifecycle tables and revision/verification columns; memory content unchanged",
    100: "nullable served-prefix and held-release metadata",
    101: "trimmed-source tag retirement indexes",
    102: "nullable served digest on served markers",
    103: "relocate thirteen inline session metadata payloads to render cache and chunk tables, preserving bytes, storage class and NULL versus empty",
    104: "memory placement and device-local sync tables",
    105: "nullable safety-critical memory assessment",
} as const;

export function assertEffects(context: number): void {
	if (context !== Math.max(...Object.keys(EFFECTS).map(Number)))
        throw new Error(`Migration effects manifest needs review for context ${context}`);
}

export function newest049(versions: string[]): string {
    const matches = versions
        .filter((v) => /^0\.49\.\d+$/.test(v))
        .sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2]));
    if (!matches.length) throw new Error("No released 0.49.x plugin found");
    return matches.at(-1)!;
}

export function assertDoctor(output: string): void {
    const result = JSON.parse(output) as Record<string, boolean>;
    if (
        [
            "schema",
            "integrity",
            "foreignKeys",
            "shadowBackfills",
            "maintenance",
            "compartments",
        ].some((name) => result[name] !== true)
    )
        throw new Error(`Doctor did not report a clean migrated store: ${output}`);
}

export function assertFullDoctorTarget(output: string, directory: string, host: string): void {
    if (
        !output.includes(directory) ||
        output.includes("TEST BACKSTOP") ||
        (host === "pi" && !output.includes("SQLite integrity_check: ok"))
    )
        throw new Error(`Full ${host} doctor did not inspect the intended migrated store`);
}

export type MigrationMetric = {
    database: string;
    version: number;
    seconds: number;
    peakKiB: number;
    beforeMainWal: number[];
    afterMainWal: number[];
};
export function assertMigrationMetrics(metrics: MigrationMetric[]): void {
    for (let version = 96; version <= 105; version++) {
        const rows = metrics.filter((row) => row.database === "context" && row.version === version);
        if (
            rows.length !== 1 ||
            !Number.isFinite(rows[0].seconds) ||
            rows[0].seconds < 0 ||
            !(rows[0].peakKiB > 0) ||
            rows[0].beforeMainWal.length !== 2 ||
            rows[0].afterMainWal.length !== 2
        )
            throw new Error(`Missing or invalid migration measurement: context ${version}`);
    }
}

export function assertHostPasses(
    rows: { host: string; status: string; version: number; requests: number; tagged: boolean }[],
): void {
    for (const host of ["opencode", "opencode2", "pi"]) {
        const matches = rows.filter((r) => r.host === host);
        if (
            matches.length !== 1 ||
            matches[0].status !== "PASS" ||
            matches[0].version !== 105 ||
            matches[0].requests !== 1 ||
            !matches[0].tagged
        )
            throw new Error(`Missing managed first provider pass: ${host}`);
    }
}
