// Temporary pure-guest control: variant and compute budget are explicit inputs.
import variant from "@jitl/quickjs-singlefile-cjs-release-asyncify";
import { newQuickJSAsyncWASMModuleFromVariant, newQuickJSWASMModule, type QuickJSAsyncContext } from "quickjs-emscripten";

const sync = process.argv.includes("--sync");
const budgetArg = process.argv.find((arg) => arg.startsWith("--budget="));
const budget = budgetArg ? Number(budgetArg.slice(9)) : 2_000;
const module = sync ? await newQuickJSWASMModule() : await newQuickJSAsyncWASMModuleFromVariant(variant);
console.log(JSON.stringify({ kind:"variant-control", variant:sync?"sync":"asyncify", budget, bun:Bun.version, platform:process.platform, arch:process.arch }));
for (let iteration = 1; iteration <= 30; iteration++) {
    const busy = iteration >= 2 && iteration <= 4;
    const start = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    const runtime = module.newRuntime();
    const context = runtime.newContext();
    runtime.setMemoryLimit(8 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const deadline = performance.now() + budget;
    runtime.setInterruptHandler(() => performance.now() >= deadline);
    try {
        const source = busy ? "while(true) {}" : "1 + 1";
        const evaluated = sync ? context.evalCode(source) : await (context as QuickJSAsyncContext).evalCodeAsync(source);
        if (busy) {
            if (!evaluated.error) throw new Error("busy guest was not interrupted");
            evaluated.error.dispose();
        } else {
            const result = context.unwrapResult(evaluated);
            if (context.getNumber(result) !== 2) throw new Error("guest result incorrect");
            result.dispose();
        }
    } finally { context.dispose(); runtime.dispose(); }
    const used = process.cpuUsage(cpu);
    console.log(JSON.stringify({iteration,busy,wallMs:Number(process.hrtime.bigint()-start)/1e6,userMs:used.user/1e3,systemMs:used.system/1e3}));
}
let quiet=0;
for (let window=1;window<=12;window++) {
    const start=process.hrtime.bigint(); const cpu=process.cpuUsage();
    await new Promise((resolve)=>setTimeout(resolve,5_000));
    const used=process.cpuUsage(cpu); const wallMs=Number(process.hrtime.bigint()-start)/1e6;
    const fraction=(used.user+used.system)/1e3/wallMs;
    console.log(JSON.stringify({kind:"variant-idle",window,wallMs,userMs:used.user/1e3,systemMs:used.system/1e3,cpuFraction:fraction}));
    quiet=fraction<0.1?quiet+1:0;
    if(quiet>=2) break;
}
console.log("VARIANT_CONTROL_COMPLETE 30");
