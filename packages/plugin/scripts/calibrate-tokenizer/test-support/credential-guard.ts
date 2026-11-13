/** Child-only traps: no home-folder read or provider request may reach the machine. */
import fs from "node:fs";
import promises from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "bun:test";

const read = fs.readFileSync;
const exists = fs.existsSync;
const home = resolve(homedir());
const inHome = (path: unknown) => String(path).startsWith(`${home}${sep}`);
function guardHome(path: unknown): void {
    if (!inHome(path)) return;
    console.error("TEST: credential file read under home");
    throw new Error("TEST: credential file read under home");
}
fs.existsSync = (path) => inHome(path) || exists(path);
fs.readFileSync = ((path, ...args) => {
    guardHome(path);
    return Reflect.apply(read, fs, [path, ...args]);
}) as typeof fs.readFileSync;
for (const name of ["readFile", "open", "openSync", "createReadStream"] as const) {
    const original = fs[name];
    Object.assign(fs, { [name]: (path: unknown, ...args: unknown[]) => {
        guardHome(path);
        return Reflect.apply(original, fs, [path, ...args]);
    } });
}
for (const name of ["readFile", "open"] as const) {
    const original = promises[name];
    Object.assign(promises, { [name]: (path: unknown, ...args: unknown[]) => {
        guardHome(path);
        return Reflect.apply(original, promises, [path, ...args]);
    } });
}
const bunFile = Bun.file;
Bun.file = ((path: string, ...args: unknown[]) => {
    guardHome(path);
    return Reflect.apply(bunFile, Bun, [path, ...args]);
}) as typeof Bun.file;
fs.writeFileSync = () => { throw new Error("TEST: unexpected file write"); };
// Results are not credentials, but tests must not overwrite the checked-in measurements.
const write = fs.writeFileSync;
fs.writeFileSync = ((path, ...args) => {
    if (String(path).endsWith(`${sep}calibrate-tokenizer${sep}results.json`)) return;
    return Reflect.apply(write, fs, [path, ...args]);
}) as typeof fs.writeFileSync;
syncBuiltinESMExports();
mock.module("node:fs", () => ({ ...fs, default: fs }));
mock.module("node:fs/promises", () => ({ ...promises, default: promises }));

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model?: string };
    console.log(`TEST FETCH ${body.model} ${String(url)}`);
    return Response.json({ error: { message: "secret-response-body" } }, {
        status: Number(process.env.MC_TEST_HTTP_STATUS ?? 500), headers: { "secret-header": "secret-response-header" },
    });
}) as typeof fetch;

if (process.env.MC_TEST_PROBE_GUARD) fs.readFileSync(resolve(home, ".config", "fake.key"));
