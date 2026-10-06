import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as dns from "node:dns/promises";
import { rmSync } from "node:fs";
import * as https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import {
    markNoteNudgeDelivered,
    peekNoteNudgeText,
    resetNoteNudgeCooldownOnly,
} from "../../../hooks/magic-context/note-nudger";
import { Database } from "../../../shared/sqlite";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { setPersistedNoteNudgeTrigger } from "../storage-meta-persisted";
import { addNote, getNotes } from "../storage-notes";
import type { SmartNoteCapabilityApi } from "./capabilities";
import { compileSmartNoteCheck } from "./compiler";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import { markSmartNoteCompilationFailure } from "./storage";
import { SmartNoteNetworkError } from "./types";

const directories: string[] = [];
const databases: Database[] = [];
let lookup: ReturnType<typeof spyOn<typeof dns, "lookup">>;
let request: ReturnType<typeof spyOn<typeof https, "request">>;
beforeEach(() => {
    // All HTTP data comes from injected capabilities. Fail closed if a future
    // compiler change accidentally bypasses those fixtures.
    lookup = spyOn(dns, "lookup").mockImplementation(() => {
        throw new Error("fixture must not perform DNS");
    });
    request = spyOn(https, "request").mockImplementation(() => {
        throw new Error("fixture must not open a network connection");
    });
});
afterEach(() => {
    const dnsCalls = lookup.mock.calls.length;
    const networkCalls = request.mock.calls.length;
    lookup.mockRestore();
    request.mockRestore();
    for (const db of databases.splice(0)) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    expect(dnsCalls).toBe(0);
    expect(networkCalls).toBe(0);
});
function tempDirectory(): string {
    const dir = createTestTempDirFromPath(path.join(tmpdir(), "smart-notes-fixture-"));
    directories.push(dir);
    return dir;
}
const emptyCapabilities: SmartNoteCapabilityApi = {
    readFile: async () => null,
    gitHeadSha: async () => null,
    gitTag: async () => null,
    gitLog: async () => [],
    httpGet: async () => {
        throw new Error("Unexpected HTTP request");
    },
};
function carrier(outputs: string[]) {
    const requests: string[] = [];
    let calls = 0;
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode2" },
        open: async () => ({ id: "fixture-compiler" }),
        attempt: async (_handle, request) => {
            requests.push(JSON.stringify(request));
        },
        collect: async () => ({
            text: outputs[Math.min(calls++, outputs.length - 1)],
            reasoning: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            lengthCapped: false,
        }),
        close: async () => {},
    };
    return { executor, requests };
}
function output(url: string): string {
    return JSON.stringify({
        compiled_check: `function check(cap) { var r = cap.httpGet(${JSON.stringify(url)}); return { met: r.status === 200 && JSON.parse(r.body).tag_name === "v0.70.0" }; }`,
        manifest: { capabilities: ["httpGet"], hosts: ["api.github.com"], urls: [url] },
        check_cron: "0 * * * *",
    });
}
function compile(
    condition: string,
    capabilities: SmartNoteCapabilityApi,
    executor?: HiddenCompletionExecutor,
) {
    return compileSmartNoteCheck({
        hiddenCompletionExecutor: executor,
        parentSessionId: undefined,
        sessionDirectory: tempDirectory(),
        projectIdentity: "cortexkit/insula",
        note: { id: 1, content: "waiting", surfaceCondition: condition },
        capabilityFactory: () => capabilities,
        signal: new AbortController().signal,
        deadline: Date.now() + 30_000,
    });
}

test("oversized release dry run recompiles once with feedback and fires on bounded latest fixture", async () => {
    const root = "https://api.github.com/repos/steipete/CodexBar/releases";
    const transport = carrier([output(root), output(`${root}/latest`)]);
    const urls: string[] = [];
    const result = await compile(
        "github.com/steipete/CodexBar has a release tag newer than v0.66.0",
        {
            ...emptyCapabilities,
            httpGet: async (url) => {
                urls.push(url);
                if (url === root)
                    throw new SmartNoteNetworkError(
                        `SMART_NOTE_NETWORK: response body too large at ${url} (received at least 98304 bytes; limit 65536)`,
                        { terminal: true, persistent: true },
                    );
                expect(url).toBe(`${root}/latest`);
                return { status: 200, body: JSON.stringify({ tag_name: "v0.70.0" }) };
            },
        },
        transport.executor,
    );
    expect(result).toMatchObject({ ok: true, dryRun: { met: true } });
    expect(urls).toEqual([root, `${root}/latest`]);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]).toContain("response body too large");
    expect(transport.requests[1]).toContain("Recompile using smaller bounded endpoints");
});

test("oversized repair failure stops after two compiler calls", async () => {
    const url = "https://api.github.com/repos/steipete/CodexBar/releases";
    const transport = carrier([output(url)]);
    const result = await compile(
        "release newer than v0.66.0",
        {
            ...emptyCapabilities,
            httpGet: async () => {
                throw new SmartNoteNetworkError(`response body too large at ${url}`, {
                    terminal: true,
                    persistent: true,
                });
            },
        },
        transport.executor,
    );
    expect(result).toMatchObject({ ok: false, persistent: true });
    expect(transport.requests).toHaveLength(2);
});

const original =
    "a tag on cortexkit/insula that isn't an ancestor of master, or a tag other than v0.1.0/v0.1.1 exists";
function tagRepository() {
    const dir = tempDirectory();
    const git = (...args: string[]) =>
        // Fixture commits must not invoke inherited hooks, signing agents or
        // user configuration: these can contact services or wait for input.
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            timeout: 5_000,
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        }).trim();
    git("init", "-b", "master");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "--allow-empty", "-m", "first");
    git("tag", "v0.1.0");
    git("commit", "--allow-empty", "-m", "second");
    git("tag", "-a", "v0.1.1", "-m", "annotated second");
    git("commit", "--allow-empty", "-m", "master tip");
    const capabilities: SmartNoteCapabilityApi = {
        ...emptyCapabilities,
        httpGet: async (url) => {
            const parsed = new URL(url);
            expect(parsed.hostname).toBe("api.github.com");
            if (parsed.pathname.endsWith("/tags")) {
                expect(parsed.searchParams.get("per_page")).toBe("100");
                const names = git("tag", "--list").split("\n").filter(Boolean);
                return { status: 200, body: JSON.stringify(names.map((name) => ({ name }))) };
            }
            expect(parsed.searchParams.get("per_page")).toBe("1");
            const [base, head] = parsed.pathname
                .split("/compare/")[1]
                .split("...")
                .map(decodeURIComponent);
            const baseSha = git("rev-parse", `${base}^{commit}`);
            const headSha = git("rev-parse", `${head}^{commit}`);
            let status = "identical";
            if (baseSha !== headSha) {
                try {
                    git("merge-base", "--is-ancestor", baseSha, headSha);
                    status = "ahead";
                } catch {
                    try {
                        git("merge-base", "--is-ancestor", headSha, baseSha);
                        status = "behind";
                    } catch {
                        status = "diverged";
                    }
                }
            }
            return { status: 200, body: JSON.stringify({ status }) };
        },
    };
    return { git, capabilities };
}

test("exclusion OR falsely fires on allowed ancestor tags despite a successful compiler dry run", async () => {
    const { git, capabilities } = tagRepository();
    expect(git("tag", "--list").split("\n")).toEqual(["v0.1.0", "v0.1.1"]);
    // A plausible lost-check failure: either allowed name satisfies this OR.
    // The deleted historical check is unavailable, so this is not a claim about
    // the exact code that previously fired in production.
    const unsafe = await runCompiledSmartNoteCheck({
        capabilities,
        compiledCheck: `function check(cap) { var tags = JSON.parse(cap.httpGet("https://api.github.com/repos/cortexkit/insula/tags?per_page=100").body); return { met: tags.some(function(t) { return t.name !== "v0.1.0" || t.name !== "v0.1.1"; }) }; }`,
    });
    expect(unsafe).toEqual({ ok: true, result: { met: true } });
    for (const tag of ["v0.1.0", "v0.1.1"]) {
        expect(git("merge-base", "--is-ancestor", `${tag}^{commit}`, "master")).toBe("");
    }
    const transport = carrier([
        JSON.stringify({
            compiled_check: `function check(cap) { var tags = JSON.parse(cap.httpGet("https://api.github.com/repos/cortexkit/insula/tags?per_page=100&page=1").body); return { met: tags.some(function(t) { return t.name !== "v0.1.0" || t.name !== "v0.1.1"; }) }; }`,
            manifest: { capabilities: ["httpGet"], hosts: ["api.github.com"] },
            check_cron: "0 * * * *",
        }),
    ]);
    // The sandbox validates execution and result shape, not the meaning of the
    // condition. This fixture demonstrates why a passing dry run is insufficient.
    expect(await compile(original, capabilities, transport.executor)).toMatchObject({
        ok: true,
        dryRun: { met: true },
    });
});

test("tag guidance reaches the compiler transport for original and reworded conditions", async () => {
    const { capabilities } = tagRepository();
    const compiledCheck = `function check(cap) {
        var allowed = ["v0.1.0", "v0.1.1"];
        var urls = ["https://api.github.com/repos/cortexkit/insula/compare/v0.1.0...master?per_page=1", "https://api.github.com/repos/cortexkit/insula/compare/v0.1.1...master?per_page=1"];
        var response = cap.httpGet("https://api.github.com/repos/cortexkit/insula/tags?per_page=100&page=1");
        if (response.status !== 200) throw new Error("Tag source unavailable");
        var tags = JSON.parse(response.body);
        if (!Array.isArray(tags) || tags.length >= 100) throw new Error("Incomplete tag fixture");
        for (var i = 0; i < tags.length; i++) {
            var name = tags[i].name;
            if (allowed.indexOf(name) === -1) return { met: true };
            var comparison = cap.httpGet(urls[allowed.indexOf(name)]);
            if (comparison.status !== 200) throw new Error("Comparison unavailable");
            var status = JSON.parse(comparison.body).status;
            if (status === "behind" || status === "diverged") return { met: true };
            if (status !== "ahead" && status !== "identical") throw new Error("Unknown comparison status");
        }
        return { met: false };
    }`;
    for (const condition of [
        original,
        "Notify me if master does not descend from any tag, or a tag outside the v0.1.0 and v0.1.1 set appears on cortexkit/insula.",
    ]) {
        const transport = carrier([
            JSON.stringify({
                compiled_check: compiledCheck,
                manifest: { capabilities: ["httpGet"], hosts: ["api.github.com"] },
                check_cron: "0 * * * *",
            }),
        ]);
        expect(await compile(condition, capabilities, transport.executor)).toMatchObject({
            ok: true,
            dryRun: { met: false },
        });
        expect(transport.requests).toHaveLength(1);
        const request = JSON.parse(transport.requests[0]);
        expect(request.body.parts[0].text).toContain(condition);
        const system = request.body.system;
        expect(system).toContain("allowed.indexOf(name) === -1");
        expect(system).toContain("Never use name !== A || name !== B");
        expect(system).toContain("GET /compare/X...BASE?per_page=1");
        expect(system).toContain(
            "Status ahead means BASE descends from X; identical also satisfies ancestry",
        );
        expect(system).toContain("Behind means X descends from BASE");
        expect(system).toContain(
            "reverse /compare/BASE...X?per_page=1, behind or identical proves X is ancestral",
        );
        expect(system).toContain("Enumerate every tag using bounded pagination");
        expect(system).toContain("Stop only on a short page");
        expect(system).toContain("if its final page is full, throw an error");
    }
});

test("persistent compilation failure nudges its owner once with the reason, not a met verdict", () => {
    const db = new Database(path.join(tempDirectory(), "notes.sqlite"));
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "failure-owner";
    db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(sessionId);
    const note = addNote(db, "smart", {
        sessionId,
        projectPath: "fixture",
        content: "release watch",
        surfaceCondition: "a release arrives",
    });
    markSmartNoteCompilationFailure(db, note.id, Date.now(), 3, "response body too large", true);
    expect(peekNoteNudgeText(db, "other-owner", "m1", "fixture")).toBeNull();
    expect(peekNoteNudgeText(db, sessionId, "m1", "fixture")).toBeNull();
    const text = peekNoteNudgeText(db, sessionId, "m2", "fixture");
    expect(text).toContain("response body too large");
    expect(text).toContain("NOT evidence that the condition is met");
    expect(markNoteNudgeDelivered(db, sessionId, text ?? "", "m2").ok).toBe(true);
    resetNoteNudgeCooldownOnly(sessionId);
    markSmartNoteCompilationFailure(
        db,
        note.id,
        Date.now(),
        3,
        "response body too large again",
        true,
    );
    setPersistedNoteNudgeTrigger(db, sessionId);
    expect(peekNoteNudgeText(db, sessionId, "m3", "fixture")).toBeNull();
    expect(peekNoteNudgeText(db, sessionId, "m4", "fixture")).toBeNull();
    expect(getNotes(db, { sessionId, type: "session" })).toHaveLength(1);
    expect(getNotes(db, { type: "smart" })[0].status).toBe("pending");
});
