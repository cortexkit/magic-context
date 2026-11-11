import { describe, expect, test } from "bun:test";
import { MIN_OPENCODE1_SIDEBAR_VERSION, unsupportedTuiHostMessage } from "./host-floor";

describe("unsupportedTuiHostMessage", () => {
    test("declines OpenCode 1 releases older than the sidebar's floor", () => {
        for (const version of ["1.18.3", "1.18.0", "1.17.13", "1.17.10", "1.15.0"]) {
            expect(unsupportedTuiHostMessage(version)).toBe(
                `Magic Context's sidebar needs OpenCode ${MIN_OPENCODE1_SIDEBAR_VERSION} or later (this is ${version}); context management keeps running.`,
            );
        }
    });

    test("loads on the floor release and every later one, including OpenCode 2", () => {
        for (const version of ["1.18.4", "1.18.30", "1.19.3", "1.20.0", "2.0.22", "2.1.0"]) {
            expect(unsupportedTuiHostMessage(version)).toBeNull();
        }
    });

    test("lets through a version it cannot place against the floor", () => {
        for (const version of [undefined, "", "local", "0.0.0-dev-202611010000", "1.18"]) {
            expect(unsupportedTuiHostMessage(version)).toBeNull();
        }
    });
});
