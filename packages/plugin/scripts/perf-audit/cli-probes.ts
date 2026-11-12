// Actual identity-split and migration-boundary routines on isolated fixtures.
// timeout 180 bun .../cli-probes.ts <throwaway-root>
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("throwaway root required");
mkdirSync(root, { recursive: true });
const moduleUrl = new URL("../../../cli/src/commands/doctor-identity-splits.ts", import.meta.url).href;
const { findIdentitySplits } = await import(moduleUrl);
const migrate = readFileSync(new URL("../../../cli/src/commands/migrate.ts", import.meta.url), "utf8");
const start = migrate.indexOf("function remapBoundaryId(");
const end = migrate.indexOf("\ninterface CopyMagicContextStateResult", start);
if (start < 0 || end < 0) throw new Error("boundary routine moved; update benchmark extraction");
const remap = new Function(new Bun.Transpiler({ loader: "ts" }).transformSync(`${migrate.slice(start, end)}\nreturn remapBoundaryId;`))() as (
    boundary: string, edge: string, first: Map<string, string>, last: Map<string, string>, ids: string[],
) => { piEntryId: string; exact: boolean } | undefined;
console.log(`Bun ${Bun.version}`);
for (const count of [1_000, 10_000, 60_000]) {
    const host = new Database(":memory:");
    const context = new Database(":memory:");
    host.exec("CREATE TABLE session(id TEXT, directory TEXT)");
    context.exec("CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT); CREATE TABLE memories(project_path TEXT); CREATE TABLE notes(project_path TEXT)");
    const directory = join(root, "project");
    mkdirSync(directory, { recursive: true });
    const insertHost = host.prepare("INSERT INTO session VALUES (?, ?)");
    const insertContext = context.prepare("INSERT INTO session_projects VALUES (?, 'opencode', ?)");
    host.exec("BEGIN"); context.exec("BEGIN");
    for (let i = 0; i < count; i++) { insertHost.run(`s${i}`, directory); insertContext.run(`s${i}`, i % 2 ? "git:aaa" : "dir:bbb"); }
    host.exec("COMMIT; PRAGMA query_only=ON"); context.exec("COMMIT; PRAGMA query_only=ON");
    const before = performance.now();
    const splits = findIdentitySplits(context, host);
    const done = performance.now();
    if (splits.length !== 1 || splits[0].identities.length !== 2) throw new Error("identity fixture not reached");
    console.log(`UI-17 ${count} sessions: ${(done - before).toFixed(3)} ms; ${splits.length} split`);
    const ids = Array.from({ length: count }, (_, i) => `msg_${String(i).padStart(8, "0")}`);
    const last = new Map(ids.map((id) => [id, `pi_${id}`]));
    const boundary = `${ids[count - 1]}~`;
    const iterations = 200;
    const t = performance.now();
    for (let pass = 0; pass < iterations; pass++) {
        const result = remap(boundary, "end", new Map(), last, ids);
        if (result?.piEntryId !== `pi_${ids[count - 1]}` || result.exact) throw new Error("boundary fixture not reached");
    }
    console.log(`UI-19 ${count} source IDs: ${((performance.now() - t) / iterations).toFixed(3)} ms/boundary (${iterations} worst-case missing boundaries)`);
    host.close(); context.close();
}
