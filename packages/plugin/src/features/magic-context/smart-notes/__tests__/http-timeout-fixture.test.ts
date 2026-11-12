import { expect, spyOn } from "bun:test";
import * as dns from "node:dns/promises";
import { realpathSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Database } from "../../../../shared/sqlite";
import { listOpenFiles } from "../../../../shared/test-open-files";
import { createTestTempDirFromPath } from "../../../../shared/test-temp-dir";
import { runMigrations } from "../../migrations";
import { initializeDatabase } from "../../storage-db";

export const TIMEOUT_URL = "https://smart-note-timeout.test/resource";
export const HTTP_CHECK = `function check(cap) {
    return {met: JSON.parse(cap.httpGet("${TIMEOUT_URL}").body).ready};
}`;
export const COMPILER_OUTPUT = JSON.stringify({
    compiled_check: HTTP_CHECK,
    manifest: { capabilities: ["httpGet"], urls: [TIMEOUT_URL] },
    check_cron: "*/15 * * * *",
});

/** Only the final connector is redirected; the real guard and transport still execute. */
export async function withLocalHttpServer<T>(
    delayMs: number | null,
    run: (requests: () => number) => Promise<T>,
): Promise<T> {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const fixture = await localSmartNoteHttpTransport(
        "smart-note-timeout.test",
        (_request, response) => {
            if (delayMs === null) return;
            const timer = setTimeout(() => {
                timers.delete(timer);
                response.end('{"ready":false}');
            }, delayMs);
            timers.add(timer);
        },
    );
    try {
        return await run(() => fixture.paths.length);
    } finally {
        for (const timer of timers) clearTimeout(timer);
        await fixture.dispose();
    }
}

/** Run the real HTTP stream lifecycle without opening public sockets or doing DNS. */
export async function localSmartNoteHttpTransport(
    hostnames: string | readonly string[],
    respond: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ paths: string[]; dispose: () => Promise<void> }> {
    const allowedHostnames = new Set(typeof hostnames === "string" ? [hostnames] : hostnames);
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
        paths.push(request.url ?? "");
        respond(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const lookup = spyOn(dns, "lookup").mockImplementation((async (target: string) => {
        if (!allowedHostnames.has(target)) throw new Error(`unexpected DNS: ${target}`);
        return [{ address: "1.1.1.1", family: 4 }];
    }) as typeof dns.lookup);
    const request = spyOn(https, "request").mockImplementation(((
        options: https.RequestOptions,
        callback: (response: http.IncomingMessage) => void,
    ) => {
        if (!allowedHostnames.has(String(options.hostname)))
            throw new Error(`unexpected network destination: ${options.hostname}`);
        // SSRF policy stays production-strict. Only this test connector may reach
        // loopback, and no DNS, TLS or socket is opened against a public service.
        return http.request(
            {
                ...options,
                protocol: "http:",
                hostname: "127.0.0.1",
                port: address.port,
                lookup: undefined,
                agent: false,
            },
            callback,
        );
    }) as typeof https.request);
    return {
        paths,
        dispose: async () => {
            request.mockRestore();
            lookup.mockRestore();
            const closed = new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
            server.closeAllConnections();
            await closed;
        },
    };
}

let isolationProven = false;
export function timeoutTestDatabase(): { db: Database; dispose: () => void } {
    const configuredRoot = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    if (!configuredRoot) throw new Error("test preload must isolate storage");
    const root = realpathSync(configuredRoot);
    if (relative(realpathSync(tmpdir()), root).startsWith(".."))
        throw new Error("test preload must isolate storage below the temp directory");
    const directory = createTestTempDirFromPath(join(root, "smart-note-http-"));
    const path = join(directory, "timeout.db");
    const db = new Database(path);
    initializeDatabase(db);
    runMigrations(db);
    if (!isolationProven && process.platform !== "win32") {
        const inventory = listOpenFiles();
        // Without an inventory the live-store isolation proof would be meaningless.
        if (!inventory.available) throw new Error(inventory.reason);
        const dbLines = inventory.paths.filter((path) => /\.db(?:[-\s]|$)/.test(path));
        expect(dbLines.some((line) => line.includes(path))).toBe(true);
        // The test runner shares one process across test files, so other files' throwaway
        // databases may still be open here. The invariant is that every database this
        // process holds lives under the temp directory, never in a live store.
        const tempRoot = realpathSync(tmpdir());
        for (const line of dbLines) expect(line).toContain(tempRoot);
        console.log(`pid ${process.pid}: isolated database descriptors\n${dbLines.join("\n")}`);
        isolationProven = true;
    }
    return {
        db,
        dispose: () => {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
