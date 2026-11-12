// SQL/IPC lower bounds when the native dashboard build is unavailable. These
// are NOT native command or DOM timings. Use only a scrubbed VACUUM INTO copy:
// timeout 120 bun .../dashboard-sql.ts <throwaway-root> <session-id>
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
const session = process.argv[3];
if (!process.argv[2] || !session) throw new Error("throwaway root and session required");
const host = new Database(join(root, "data/opencode/opencode.db"), { readonly: true });
const context = new Database(join(root, "data/cortexkit/magic-context/context.db"), { readonly: true });
const handles = execFileSync("lsof", ["-p", String(process.pid)], { encoding: "utf8" }).split("\n").filter((line) => /\.db(?:\s|$|-shm|-wal)/.test(line));
if (!handles.length || handles.some((line) => !line.includes(root))) throw new Error("unisolated database handle");
console.log(`Bun ${Bun.version}; SQLite ${host.query("SELECT sqlite_version() v").get() && JSON.stringify(host.query("SELECT sqlite_version() v").get())}; isolated DB handles: ${handles.length}`);
const timed = <T>(label: string, run: () => T) => {
    const start = performance.now();
    const value = run();
    console.log(`${label}: ${(performance.now() - start).toFixed(3)} ms`);
    return value;
};
for (const pass of ["cold", "warm"]) {
    console.log(`=== ${pass} ===`);
    const ids = timed("UI-7 all session IDs", () => host.query("SELECT id FROM session").all());
    console.log(`UI-7 IDs=${ids.length}`);
    timed("UI-7 point ID", () => host.query("SELECT EXISTS(SELECT 1 FROM session WHERE id=?)").get(session));
    const rows = timed("UI-1 raw message metadata read", () => host.query<{ id: string; time_created: number; data: string }, [string]>("SELECT id, time_created, data FROM message WHERE session_id=? ORDER BY time_created ASC").all(session));
    const parsed = timed("UI-1 raw JSON parse", () => rows.map((row) => ({ message_id: row.id, timestamp_ms: row.time_created, raw_json: JSON.parse(row.data) as unknown })));
    const wire = timed("UI-1 metadata-only wire serialize", () => JSON.stringify(parsed));
    timed("UI-1 metadata-only JS IPC parse", () => JSON.parse(wire) as unknown);
    const withoutRaw = JSON.stringify(parsed.map(({ raw_json: _, ...row }) => row));
    console.log(`UI-1 rows=${rows.length} unused_raw_json_bytes=${Buffer.byteLength(wire) - Buffer.byteLength(withoutRaw)} metadata_only_IPC_bytes=${Buffer.byteLength(wire)}`);
    timed("UI-8 badge count", () => host.query("SELECT COUNT(*) n FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' AND COALESCE(CAST(json_extract(data,'$.tokens.total') AS INTEGER),0)>0").get(session));
    const sessions = timed("UI-9 full session-table read", () => host.query("SELECT id, time_updated FROM session ORDER BY time_updated DESC").all());
    console.log(`UI-9 rows=${sessions.length}`);
    timed("UI-13 status COUNTs (no category/embedding queries)", () => {
        context.query("SELECT COUNT(*) FROM memories").get();
        for (const status of ["active", "permanent", "archived"]) context.query("SELECT COUNT(*) FROM memories WHERE status=?").get(status);
    });
}
host.close();
context.close();
