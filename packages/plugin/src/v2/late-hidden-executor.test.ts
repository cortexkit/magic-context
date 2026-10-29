/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type {
    HiddenCompletionExecutor,
    HiddenRunHandle,
} from "../hooks/magic-context/compartment-runner-types";
import { createLateHiddenExecutor, V2_HIDDEN_EXECUTOR_CAPABILITIES } from "./hidden-completion";

describe("createLateHiddenExecutor", () => {
    it("refuses before an executor is wired, then forwards to the one wired later", async () => {
        let wired: HiddenCompletionExecutor | undefined;
        const late = createLateHiddenExecutor(() => wired);
        const run = { role: "historian" } as unknown as Parameters<
            HiddenCompletionExecutor["open"]
        >[0];

        expect(late.capabilities).toEqual(V2_HIDDEN_EXECUTOR_CAPABILITIES);
        expect(() => late.open(run)).toThrow("unavailable until the context database opens");

        const handle = { id: "run" } as unknown as HiddenRunHandle;
        const opened: unknown[] = [];
        wired = {
            capabilities: { tools: false, harness: "opencode2" },
            open: async (identity) => {
                opened.push(identity);
                return handle;
            },
            attempt: async () => {},
            collect: async () => ({ text: "done" }) as never,
            close: async () => {},
        };

        expect(await late.open(run)).toBe(handle);
        expect(opened).toEqual([run]);
        expect(late.capabilities).toEqual({ tools: false, harness: "opencode2" });
        expect(await late.collectPartial?.(handle, 200)).toEqual({ text: "done" });
        wired.collectPartial = async () => ({ text: "unfinished" }) as never;
        expect(await late.collectPartial?.(handle, 200)).toEqual({ text: "unfinished" });
    });
});
