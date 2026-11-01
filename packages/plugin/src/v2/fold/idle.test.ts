import { expect, test } from "bun:test";
import { HostFoldIdle } from "./idle";

function fixture() {
    let now = 10_000;
    const pending = new Map<number, { at: number; callback: () => void }>();
    let serial = 0;
    const calls: Array<{ sessionID: string; eligible: () => boolean }> = [];
    const idle = new HostFoldIdle(
        async (sessionID, eligible) => {
            calls.push({ sessionID, eligible });
        },
        () => now,
        {
            setTimeout: ((callback: () => void, ms: number) => {
                const id = ++serial;
                pending.set(id, { at: now + ms, callback });
                return id;
            }) as unknown as typeof setTimeout,
            clearTimeout: ((id: number) => {
                pending.delete(id);
            }) as unknown as typeof clearTimeout,
        },
    );
    return {
        idle,
        calls,
        pending,
        advance(ms: number) {
            now += ms;
            for (const [id, timer] of [...pending]) {
                if (timer.at <= now) {
                    pending.delete(id);
                    timer.callback();
                }
            }
        },
    };
}

test("automatic host folding waits strictly past the frozen idle cache lifetime", () => {
    const f = fixture();
    f.idle.idle("s", "5m", 10_000);
    expect(f.calls).toHaveLength(0);
    f.advance(300_000);
    expect(f.calls).toHaveLength(0);
    f.advance(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.eligible()).toBe(true);
    f.advance(300_000);
    expect(f.calls).toHaveLength(1);
});

test("a new turn cancels an idle deadline and invalidates a pending admission", () => {
    const f = fixture();
    f.idle.idle("s", "100", 10_000);
    f.idle.active("s");
    f.advance(200);
    expect(f.calls).toHaveLength(0);
    f.idle.idle("s", "100", 10_200);
    f.advance(101);
    expect(f.calls).toHaveLength(1);
    f.idle.active("s");
    expect(f.calls[0]!.eligible()).toBe(false);
    expect(f.pending.size).toBe(0);
});

test("never and fresh sessions have no host fold timer and disposal cancels every session", () => {
    const f = fixture();
    f.idle.idle("never", "never", 10_000);
    f.idle.idle("fresh", "5m", 0);
    expect(f.pending.size).toBe(0);
    f.idle.idle("a", "5m", 10_000);
    f.idle.idle("b", "30m", 10_000);
    expect(f.pending.size).toBe(2);
    f.idle.dispose();
    expect(f.pending.size).toBe(0);
    f.advance(1_800_001);
    expect(f.calls).toHaveLength(0);
});

test("a repeated idle notification replaces its deadline rather than queuing twice", () => {
    const f = fixture();
    f.idle.idle("s", "100", 10_000);
    f.idle.idle("s", "100", 10_000);
    expect(f.pending.size).toBe(1);
    f.advance(101);
    expect(f.calls).toHaveLength(1);
});
