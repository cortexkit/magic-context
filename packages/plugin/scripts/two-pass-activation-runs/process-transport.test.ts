import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { processActivationTransport, type ActivationHost } from "./activation-driver";

test("process transport preserves lazy observations and stops the launched process", async () => {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "process-contract-"));
    const installRoot = join(root, "install");
    mkdirSync(installRoot);
    let carrier: ActivationHost["carrier"] = "unobservable";
    let store: string | null = null;
    const material = "mock-prefetched-material";
    const env = { ...disposableEnvironment(root), ANTHROPIC_API_KEY: material };
    const transport = processActivationTransport({
        stage: (cwd) => ({ argv: ["true"], cwd }),
        build: (cwd) => ({ argv: ["true"], cwd }),
        entrypoint: () => join(installRoot, "fixture.js"),
        launch: () => ({ argv: [process.execPath, "-e", 'const {createHash}=await import("node:crypto");console.log(createHash("sha256").update(process.env.ANTHROPIC_API_KEY ?? "missing").digest("hex"));setInterval(() => {}, 1000)'], cwd: root }),
        async connect({ stdout }) {
            const digest = await new Promise<string>((resolve) => stdout.once("data", (chunk) => resolve(chunk.toString().trim())));
            expect(digest).toBe(createHash("sha256").update(material).digest("hex"));
            return { lane: "opencode-2", get carrier() { return carrier; }, get storePath() { return store; },
                async runSession() { carrier = "hidden-completion"; store = join(root, "fixture.db"); return { fixture: true }; } };
        },
    });
    let host: ActivationHost | undefined;
    try {
        host = await transport.start({ installRoot, pluginEntrypoint: join(installRoot, "fixture.js"), env,
            meter: { beforeSend() { throw new Error("no_provider_dispatch_expected"); }, settle() { throw new Error("no_provider_dispatch_expected"); } } });
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(host.carrier).toBe("unobservable");
        expect(host.storePath).toBeNull();
        await host.runSession("fixture");
        expect(host.carrier).toBe("hidden-completion");
        expect(host.storePath).toBe(join(root, "fixture.db"));
        await host.stop();
        expect(() => process.kill(host!.pid, 0)).toThrow();
    } finally { await host?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("process transport refuses prefetched material in argv and forgets it on failure", async () => {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "argv-contract-"));
    let connections = 0;
    const env = { ...disposableEnvironment(root), ANTHROPIC_API_KEY: "mock-prefetched-argv-material" };
    const transport = processActivationTransport({
        stage: (cwd) => ({ argv: ["true"], cwd }), build: (cwd) => ({ argv: ["true"], cwd }), entrypoint: () => join(root, "fixture.js"),
        launch: () => ({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)", env.ANTHROPIC_API_KEY], cwd: root }),
        async connect() { connections++; throw new Error("must_not_connect"); },
    });
    try {
        await expect(transport.start({ installRoot: root, pluginEntrypoint: join(root, "fixture.js"), env,
            meter: { beforeSend() { throw new Error("no_dispatch"); }, settle() {} } })).rejects.toThrow("credential_in_argv");
        expect(connections).toBe(0);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
});
