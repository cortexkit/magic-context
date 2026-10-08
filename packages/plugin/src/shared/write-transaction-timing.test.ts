import { expect, spyOn, test } from "bun:test";
import * as logger from "./logger";
import { logSlowWriteTransaction } from "./write-transaction-timing";

test("slow-write diagnostics distinguish preparation from held rendering and writes", () => {
    const log = spyOn(logger, "log").mockImplementation(() => {});
    try {
        logSlowWriteTransaction("fold", 100, 1000, 1400, {
            pre_metadata: 1,
            pre_onFoldPrepare: 200,
            staleCheck: 5,
            m1Render: 100,
            persistCachedM0: 600,
            sessionMeta: 5,
            onFoldCommit: 10,
            commit: 580,
        });
        expect(log.mock.calls).toEqual([
            [
                "[magic-context] slow write transaction: site=fold held=1300.0ms pre_metadata=1.0ms pre_onFoldPrepare=200.0ms staleCheck=5.0ms m1Render=100.0ms persistCachedM0=600.0ms sessionMeta=5.0ms onFoldCommit=10.0ms commit=580.0ms",
            ],
        ]);
        logSlowWriteTransaction("fast", 100, 1000, 101);
        expect(log).toHaveBeenCalledTimes(1);
    } finally {
        log.mockRestore();
    }
});

test("step diagnostics cannot make a committed write appear to fail", () => {
    const log = spyOn(logger, "log").mockImplementation(() => {
        throw new Error("logging failed");
    });
    try {
        expect(() => logSlowWriteTransaction("fold", 0, 1000, 2000, { commit: 10 })).not.toThrow();
    } finally {
        log.mockRestore();
    }
});
