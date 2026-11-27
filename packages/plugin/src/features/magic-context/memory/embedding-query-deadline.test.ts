import { afterEach, expect, jest, test } from "bun:test";
import { EmbeddingQueryTimeoutError, withQueryEmbeddingDeadline } from "./embedding-query-deadline";

afterEach(() => jest.useRealTimers());

test("query deadline returns a ready vector without aborting the caller", async () => {
    const caller = new AbortController();
    const vector = new Float32Array([1, 2]);
    expect(await withQueryEmbeddingDeadline(async () => vector, caller.signal)).toBe(vector);
    expect(caller.signal.aborted).toBe(false);
});

test("already cancelled query does not start embedding", async () => {
    const caller = new AbortController();
    caller.abort();
    let calls = 0;
    expect(
        await withQueryEmbeddingDeadline(async () => {
            calls++;
            return null;
        }, caller.signal),
    ).toBeNull();
    expect(calls).toBe(0);
});

test("caller cancellation stops waiting even if the provider ignores the signal", async () => {
    const caller = new AbortController();
    const reason = new Error("caller cancelled");
    let received: AbortSignal | undefined;
    const pending = withQueryEmbeddingDeadline((signal) => {
        received = signal;
        return new Promise<null>(() => {});
    }, caller.signal);
    caller.abort(reason);
    expect(await pending).toBeNull();
    expect(received?.reason).toBe(reason);
    expect(received?.reason).not.toBeInstanceOf(EmbeddingQueryTimeoutError);
});

test("query budget stops a non-cooperative provider without cancelling keyword search", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    jest.setSystemTime(new Date("2026-08-11T12:00:00Z"));
    const caller = new AbortController();
    let received: AbortSignal | undefined;
    let settled = false;
    const pending = withQueryEmbeddingDeadline((signal) => {
        received = signal;
        return new Promise<null>(() => {});
    }, caller.signal).then((result) => {
        settled = true;
        return result;
    });
    jest.advanceTimersByTime(4_999);
    expect(received?.aborted).toBe(false);
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    expect(received?.reason).toBeInstanceOf(EmbeddingQueryTimeoutError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(await pending).toBeNull();
    expect(caller.signal.aborted).toBe(false);
}, 10_000);
