import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";

import { createSmartNoteCapabilities, type SmartNoteCapabilityApi } from "./capabilities";
import {
    dryRunSmartNoteCheck,
    manifestAdvisoryWarnings,
    normalizeCompiledCheck,
    normalizeCron,
    normalizeManifest,
    parseCompilerOutput,
} from "./compiler";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import { SmartNoteNetworkError } from "./types";

const fakeCap: SmartNoteCapabilityApi = {
    readFile: async (filePath) => (filePath === "ready.txt" ? "ready" : null),
    gitHeadSha: async () => "abc123",
    gitTag: async () => "v1.2.3",
    gitLog: async () => [{ sha: "abc", subject: "initial", authorDate: "2026-01-01T00:00:00Z" }],
    httpGet: async () => ({ status: 200, body: "ok" }),
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await createTestTempDirFromPath(path.join(tmpdir(), "mc-smart-note-compiler-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("smart-note compiler runtime boundary", () => {
    test("blocks .envrc reads at runtime", async () => {
        await withTempDir(async (dir) => {
            await writeFile(path.join(dir, ".envrc"), "SECRET=1", "utf8");
            const result = await runCompiledSmartNoteCheck({
                compiledCheck: `function check(cap) { return { met: cap.readFile(".envrc") !== null }; }`,
                capabilities: createSmartNoteCapabilities({
                    projectRoot: dir,
                    signal: new AbortController().signal,
                }),
            });

            expect(result).toEqual({ ok: true, result: { met: false } });
        });
    });

    test("blocks internal metadata IP fetches at runtime", async () => {
        await withTempDir(async (dir) => {
            const result = await runCompiledSmartNoteCheck({
                compiledCheck: `function check(cap) { cap.httpGet("https://169.254.169.254/latest/meta-data/"); return { met: true }; }`,
                capabilities: createSmartNoteCapabilities({
                    projectRoot: dir,
                    signal: new AbortController().signal,
                }),
            });

            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain("internal address");
        });
    });

    test("enforces sandbox time limits", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { while (true) {} }`,
            capabilities: fakeCap,
            timeoutMs: 100,
        });

        expect(result.ok).toBe(false);
    });

    test("enforces sandbox memory limits", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { const chunks = []; for (let i = 0; i < 100; i++) chunks.push(new ArrayBuffer(1024 * 1024)); return { met: false }; }`,
            capabilities: fakeCap,
            heapLimitBytes: 64 * 1024,
            timeoutMs: 1_000,
        });

        expect(result.ok).toBe(false);
    });

    test("does not expose the raw host capability bridge to guest code", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" && typeof __mcHostCap === "undefined" && !Object.prototype.hasOwnProperty.call(globalThis, "__mcHostCap") }; }`,
            capabilities: fakeCap,
        });

        expect(result).toEqual({ ok: true, result: { met: true } });
    });

    test("treats manifest drift as advisory instead of enforcement", async () => {
        const compiledCheck = `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`;
        expect(manifestAdvisoryWarnings(compiledCheck, { capabilities: [] })).toContain(
            "manifest omits capability readFile",
        );

        const result = await runCompiledSmartNoteCheck({ compiledCheck, capabilities: fakeCap });
        expect(result).toEqual({ ok: true, result: { met: true } });
    });
});

describe("smart-note compiler dry-run sources", () => {
    const check = `function check(cap) {
        var first = cap.httpGet("https://raw.githubusercontent.com/cortexkit/claustrum/main/CHANGELOG.md");
        if (first.status === 200 && first.body.includes("credential_categories")) return { met: true };
        var second = cap.httpGet("https://raw.githubusercontent.com/cortexkit/claustrum/main/schema.sql");
        return { met: second.status === 200 && second.body.includes("credential_categories") };
    }`;

    test("keeps all-404 sources compilable and reports an advisory", async () => {
        const result = await dryRunSmartNoteCheck(check, () => ({
            ...fakeCap,
            httpGet: async () => ({ status: 404, body: "404: Not Found" }),
        }));
        expect(result).toMatchObject({ ok: true, result: { met: false } });
        expect(result.advisories[0]).toContain("CHANGELOG.md (HTTP 404)");
        expect(result.advisories[0]).toContain("schema.sql (HTTP 404)");
    });

    test("retains a large-response network error instead of treating it as unmet", async () => {
        const url = "https://raw.githubusercontent.com/cortexkit/claustrum/main/CHANGELOG.md";
        const result = await dryRunSmartNoteCheck(check, () => ({
            ...fakeCap,
            httpGet: async () => {
                throw new SmartNoteNetworkError(
                    `SMART_NOTE_NETWORK: response body too large at ${url} (received at least 65537 bytes; limit 65536)`,
                    { terminal: true, persistent: true },
                );
            },
        }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain(url);
            expect(result.error).toContain("65537 bytes");
            expect(result.persistent).toBe(true);
        }
    });

    test("a reachable source prevents an all-inaccessible failure", async () => {
        const result = await dryRunSmartNoteCheck(check, () => ({
            ...fakeCap,
            httpGet: async (url) => ({
                status: url.endsWith("schema.sql") ? 200 : 404,
                body: "no category yet",
            }),
        }));
        expect(result).toEqual({ ok: true, result: { met: false }, advisories: [] });
    });

    test("a terminal timeout does not become a persistent compilation failure", async () => {
        const result = await dryRunSmartNoteCheck(check, () => ({
            ...fakeCap,
            httpGet: async () => {
                throw new SmartNoteNetworkError("request timed out", { terminal: true });
            },
        }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.persistent).toBe(false);
    });
});

describe("smart-note compiler output bounds", () => {
    test("rejects impossible cron expressions within the scheduling ceiling", () => {
        expect(() => normalizeCron("0 0 31 2 *")).toThrow(/scheduling ceiling/);
        // Proves the search stops at the smart-note ceiling (24 h) rather than at the
        // cron scanner's own, much longer default horizon: a schedule whose next run
        // is two days out is real, so only the ceiling can refuse it. This replaces a
        // millisecond timing bound that measured machine load instead of the search.
        const twoDaysOut = new Date(Date.now() + 48 * 60 * 60 * 1000);
        const once = `${twoDaysOut.getMinutes()} ${twoDaysOut.getHours()} ${twoDaysOut.getDate()} ${twoDaysOut.getMonth() + 1} *`;
        expect(() => normalizeCron(once)).toThrow(/scheduling ceiling/);
    });

    test("bounds compiler output, source, manifest entries, and cron length", () => {
        expect(() => parseCompilerOutput("x".repeat(128 * 1024 + 1))).toThrow(/128 KiB/);
        expect(() =>
            normalizeCompiledCheck(
                `function check() { return { met: false }; }/*${"x".repeat(64 * 1024)}*/`,
            ),
        ).toThrow(/64 KiB/);
        expect(
            normalizeManifest({
                capabilities: [],
                signals: Array.from({ length: 100 }, (_, index) => `signal-${index}`),
            }).signals,
        ).toHaveLength(64);
        expect(() => normalizeCron("*".repeat(257))).toThrow(/256 characters/);
    });
});
