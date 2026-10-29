import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { networkInterfaces } from "node:os";
import { attestHost, disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { underRoot } from "./activation-driver";

/** Reproduce released extension-discovery policy without dispatching a provider prompt. */
if (import.meta.main) {
    const [root, install] = process.argv.slice(2);
    const env = disposableEnvironment(root);
    underRoot(root, install);
    if (Object.keys(networkInterfaces()).some((name) => name !== "lo")) throw new Error("offline_probe_required");
    const agent = join(root, "released-policy-agent");
    const cwd = join(root, "released-policy-work");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const require = createRequire(join(install, "packages/pi-plugin/package.json"));
    const typebox = require.resolve("typebox");
    writeFileSync(join(agent, "extensions/released-probe.ts"), `import { Type } from ${JSON.stringify(typebox)};
export default function (api) { api.registerTool({ name: "discovered_extension_probe", label: "Discovery probe", description: "Inert tool used only to inspect discovery", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "unused" }] }; } }); }
`);
    writeFileSync(join(agent, "config.yml"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-model", quietStartup: true, enableInstallTelemetry: false, compaction: { enabled: false } }));
    writeFileSync(join(agent, "models.yml"), JSON.stringify({ providers: { mock: { api: "anthropic-messages", baseUrl: "http://127.0.0.1:9", apiKey: "not-a-credential", models: [{ id: "mock-model", name: "mock", input: ["text"], contextWindow: 200000, maxTokens: 8192, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const argv = [join(install, "host-dist/node_modules/.bin/omp"), "--mode", "rpc", "--no-session", "--no-tools", "--no-skills", "--no-rules"];
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { PATH: process.env.PATH, ...env, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", MAGIC_CONTEXT_PI_SUBAGENT: "1" }, stdio: ["pipe", "pipe", "ignore"] });
    const lines = createInterface({ input: child.stdout });
    const commands: string[] = [];
    try {
        const tools = await new Promise<unknown[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("inventory_timeout")), 15000);
            lines.on("line", (line) => {
                try {
                    const event = JSON.parse(line);
                    if (event.type === "ready") { commands.push("get_state"); child.stdin.write('{"id":"released-policy","type":"get_state"}\n'); }
                    if (event.id === "released-policy") {
                        clearTimeout(timer);
                        if (!event.success || !Array.isArray(event.data?.dumpTools)) reject(new Error("inventory_unobservable"));
                        else resolve(event.data.dumpTools);
                    }
                } catch { /* A startup banner is not an inventory response. */ }
            });
        });
        const isolation = await attestHost(root, env, child.pid!);
        if (isolation.proof.tool !== "lsof -Fpn") throw new Error("lsof_required");
        const names = tools.map((tool) => (tool as { name: string }).name);
        if (!names.includes("discovered_extension_probe") || commands.some((command) => command !== "get_state")) throw new Error("discovery_reproduction_failed");
        const result = { sourceRef: "master/v0.49.22@8dd1bd1c7988bc55c98525db1db3dfc9f05bc8eb", releasedPluginBundleExecuted: false,
            caveat: "The released ordinary historian tool/discovery flags are reproduced; RPC replaces print/json only to read inventory without inference. This is not execution of a released plugin bundle.", argv, commands, toolNames: names, isolation, providerPromptsSent: 0 };
        writeFileSync(join(root, "released-policy-inventory.json"), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ toolNames: names, commands, artifact: join(root, "released-policy-inventory.json") }));
    } finally { lines.close(); const exited = new Promise<void>((resolve) => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited; }
}
