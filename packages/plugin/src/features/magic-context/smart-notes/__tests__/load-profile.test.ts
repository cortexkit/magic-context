import { afterEach, beforeEach } from "bun:test";
import { __sandboxRunnerTest } from "../sandbox-runner";

// The same observational seam is enabled in both worker-count probes. It starts
// no VM and changes no timers, promises, capability calls or fixture behavior.
beforeEach(() => {
    if (process.env.SMART_NOTE_LOAD_PROFILE === "1") {
        __sandboxRunnerTest.setModuleLoadObserver((profile) => {
            console.log("SMART_NOTE_LOAD_PROFILE", JSON.stringify(profile));
        });
    }
});
afterEach(() => __sandboxRunnerTest.setModuleLoadObserver(undefined));
