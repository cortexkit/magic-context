// Temporary stable-realm host control, including real CPU-budget interruptions.
import { runCompiledSmartNoteCheck } from "../src/features/magic-context/smart-notes/sandbox-runner";

const capabilities = {
    readFile: async () => "ready", gitHeadSha: async () => null,
    gitTag: async () => null, gitLog: async () => [],
    httpGet: async () => ({ status: 200, body: "ok" }),
};
console.log(JSON.stringify({ kind: "stable-smart-note-host", bun: Bun.version, platform: process.platform, arch: process.arch }));
for (let iteration = 1; iteration <= 30; iteration++) {
    const busy = iteration >= 2 && iteration <= 4;
    const wall = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    const result = await runCompiledSmartNoteCheck({
        compiledCheck: busy ? "function check() { while (true) {} }" : 'function check(cap) { return {met:cap.readFile("ready.txt") === "ready"}; }',
        capabilities,
    });
    const used = process.cpuUsage(cpu);
    console.log(JSON.stringify({ iteration, busy, result, wallMs: Number(process.hrtime.bigint() - wall) / 1e6, userMs: used.user / 1e3, systemMs: used.system / 1e3 }));
    if (busy ? result.ok || result.cancelled || result.network : !result.ok || !result.result.met) throw new Error("host control verdict failed");
}
const idleWall = process.hrtime.bigint();
const idleCpu = process.cpuUsage();
await new Promise((resolve) => setTimeout(resolve, 5_000));
const used = process.cpuUsage(idleCpu);
console.log(JSON.stringify({ kind: "idle-after-hot-wasm", wallMs: Number(process.hrtime.bigint() - idleWall) / 1e6, userMs: used.user / 1e3, systemMs: used.system / 1e3 }));
console.log("STABLE_HOST_CONTROL_COMPLETE 30");
