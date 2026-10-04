// Load probe for the built plugin: start dist/mcp-server.js under Node the way
// Claude Code does, and check that it answers `initialize` and `ping`. Neither
// opens storage, so the probe never touches the shared database. Exits non-zero
// on any failure.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
for (const file of [
    "mcp-server.js",
    "hook.js",
    "prompt-hook.js",
    "stop-hook.js",
    "embedding-worker.js",
    "migration-worker.js",
]) {
    if (!existsSync(join(dist, file))) {
        console.error(`claude-code-plugin probe: dist/${file} is missing; run the build`);
        process.exit(1);
    }
}

const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(dist, "mcp-server.js")],
    { stdio: ["pipe", "pipe", "inherit"] },
);
const timer = setTimeout(() => {
    console.error("claude-code-plugin probe: no answer within 15s");
    child.kill("SIGKILL");
    process.exit(1);
}, 15_000);

let buffer = "";
const answered = new Set();
child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.error) {
            console.error(`claude-code-plugin probe: ${JSON.stringify(message.error)}`);
            process.exit(1);
        }
        answered.add(message.id);
        if (answered.size === 2) child.stdin.end();
    }
});
child.on("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0 || answered.size !== 2) {
        console.error(`claude-code-plugin probe: exit ${code}, ${answered.size}/2 answers`);
        process.exit(1);
    }
    console.log("claude-code-plugin dist LOAD OK");
});

const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
send({
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe" } },
});
send({ id: 2, method: "ping" });
