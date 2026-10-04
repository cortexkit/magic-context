import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bindStaleBuildNotice } from "../plugin/stale-build-notice";
import { __resetNotificationStateForTests, drainNotifications } from "./rpc-notifications";
import {
    classifyStalePluginBuild,
    importPluginModule,
    registerStalePluginBuildHost,
    StalePluginBuildError,
    stalePluginBuildDiagnostic,
} from "./stale-plugin-build";

function reset(): void {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("magic-context.stale-plugin-build")];
    __resetNotificationStateForTests();
}
beforeEach(reset);
afterEach(reset);

const dist = "/tmp/magic-context/fixture/packages/pi-plugin/dist";
const missing = (path: string) =>
    new Error(`Cannot find module '${path}' imported from ${dist}/index.js`);

describe("stale plugin build classification", () => {
    it("recognizes Node, Bun, file URLs and relative imports only inside the loaded package dist", () => {
        registerStalePluginBuildHost({ moduleUrl: `file://${dist}/index.js`, harness: "pi" });
        for (const error of [
            missing(`${dist}/index-old.js`),
            missing(`file://${dist}/index-old.js`),
            new Error(`Cannot find module './index-old.js' from '${dist}/index.js'`),
            `BuildMessage: ENOENT reading "${dist}/index-old.js"`,
        ]) {
            expect(classifyStalePluginBuild(error)?.chunk).toBe(`${dist}/index-old.js`);
        }
        for (const error of [
            missing("quickjs-emscripten"),
            missing(`${dist}-other/index-old.js`),
            missing(`${dist}/../src/index-old.js`),
            missing("/another/package/dist/index-old.js"),
            new Error(`ENOENT: no such file or directory, open '${dist}/note.txt'`),
            new Error(`network error mentioning ${dist}/index-old.js`),
            new Error(`Cannot find module '../src/missing.js' from '${dist}/index.js'`),
        ])
            expect(classifyStalePluginBuild(error)).toBeNull();
    });

    it("recognizes Windows paths without confusing an external package for our dist", () => {
        registerStalePluginBuildHost({
            moduleUrl: "file:///C:/dev/pi-plugin/dist/index.js",
            harness: "pi",
        });
        expect(
            classifyStalePluginBuild(missing("C:\\dev\\pi-plugin\\dist\\index-old.js"))?.chunk,
        ).toBe("c:/dev/pi-plugin/dist/index-old.js");
        expect(classifyStalePluginBuild(missing("C:\\other\\dist\\index-old.js"))).toBeNull();
    });

    it("does not classify source-mode missing modules using the error's dist path", () => {
        registerStalePluginBuildHost({
            moduleUrl: "file:///tmp/plugin/src/index.ts",
            harness: "pi",
        });
        expect(classifyStalePluginBuild(missing(`${dist}/index-old.js`))).toBeNull();
    });

    it("warns once per process and logs once per missing chunk across registrations and wakes", () => {
        const notices: string[] = [];
        const host = {
            moduleUrl: `file://${dist}/index.js`,
            harness: "pi" as const,
            notify: (message: string) => notices.push(message),
        };
        registerStalePluginBuildHost(host);
        const error = missing(`${dist}/index-first.js`);
        expect(stalePluginBuildDiagnostic(error)).toContain("stale plugin build");
        registerStalePluginBuildHost(host); // Another instance or a reload.
        expect(stalePluginBuildDiagnostic(error)).toBeNull();
        expect(stalePluginBuildDiagnostic(`dry-run failed: ${error.message}`)).toBeNull();
        expect(stalePluginBuildDiagnostic(missing(`${dist}/index-second.js`))).toContain(
            "index-second.js",
        );
        expect(notices).toEqual([
            "Magic Context was rebuilt while this Pi was running; type /reload to load the new build",
        ]);
        expect(stalePluginBuildDiagnostic(new Error(notices[0]))).toBeNull();
    });

    it("delivers an early failure when the Pi UI becomes available, without logging it again", () => {
        const notices: string[] = [];
        registerStalePluginBuildHost({ moduleUrl: `file://${dist}/index.js`, harness: "pi" });
        expect(stalePluginBuildDiagnostic(missing(`${dist}/index-first.js`))).toContain(
            "stale plugin build",
        );
        registerStalePluginBuildHost({
            moduleUrl: `file://${dist}/index.js`,
            harness: "pi",
            notify: (message) => notices.push(message),
        });
        expect(stalePluginBuildDiagnostic(missing(`${dist}/index-first.js`))).toBeNull();
        expect(notices).toHaveLength(1);
    });

    it("queues useful OpenCode 2 guidance even without the legacy SDK toast API", () => {
        bindStaleBuildNotice({}, "file:///tmp/plugin/dist/v2/server.js", "opencode2");
        stalePluginBuildDiagnostic(missing("/tmp/plugin/dist/v2/index-old.js"));
        stalePluginBuildDiagnostic(missing("/tmp/plugin/dist/v2/index-old.js"));
        const notifications = drainNotifications();
        expect(notifications).toHaveLength(1);
        expect(notifications[0].payload.message).toBe(
            "Magic Context was rebuilt while this OpenCode host was running; restart the host to load the new build",
        );
    });

    it("tells a Claude Code user to restart Claude Code, not an OpenCode host", () => {
        const claudeDist = "/tmp/plugins/cache/cortexkit/magic-context/1.0.0/dist";
        registerStalePluginBuildHost({
            moduleUrl: `file://${claudeDist}/mcp-server.js`,
            harness: "claude-code",
        });
        expect(classifyStalePluginBuild(missing(`${claudeDist}/chunk-old.js`))?.guidance).toBe(
            "Magic Context was rebuilt while this Claude Code session was running; restart Claude Code to load the new build",
        );
    });

    it("guards arbitrary lazy imports while preserving unrelated errors", async () => {
        registerStalePluginBuildHost({ moduleUrl: `file://${dist}/index.js`, harness: "pi" });
        const error = missing(`${dist}/index-old.js`);
        await expect(
            importPluginModule(async () => {
                throw error;
            }),
        ).rejects.toBeInstanceOf(StalePluginBuildError);
        const unrelated = missing("an-external-dependency");
        await expect(
            importPluginModule(async () => {
                throw unrelated;
            }),
        ).rejects.toBe(unrelated);
        expect(await importPluginModule(async () => 4)).toBe(4);
    });
});
