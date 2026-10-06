// Temporary native-startup experiment: no test runner and no global isolation.
import variant from "@jitl/quickjs-singlefile-cjs-release-asyncify";
import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten";

const retained = [];
console.log(JSON.stringify({ kind: "plain-wasm-loop", bun: Bun.version, platform: process.platform, arch: process.arch, execute: process.argv.includes("--execute"), jsc: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("BUN_JSC_"))) }));
for (let iteration = 1; iteration <= 30; iteration++) {
    const wall = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    console.log(JSON.stringify({ iteration, phase: "start" }));
    const module = await newQuickJSAsyncWASMModuleFromVariant(variant);
    retained.push(module);
    if (process.argv.includes("--execute")) {
        const context = module.newContext();
        try {
            const result = context.unwrapResult(await context.evalCodeAsync("1 + 1"));
            if (context.getNumber(result) !== 2) throw new Error("real WASM evaluation failed");
            result.dispose();
        } finally { context.dispose(); }
    }
    const used = process.cpuUsage(cpu);
    console.log(JSON.stringify({ iteration, phase: "ready", wallMs: Number(process.hrtime.bigint() - wall) / 1e6, userMs: used.user / 1e3, systemMs: used.system / 1e3 }));
}
console.log(`PLAIN_WASM_LOOP_COMPLETE ${retained.length}`);
