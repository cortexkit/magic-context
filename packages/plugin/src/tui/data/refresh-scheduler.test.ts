import { expect, test } from "bun:test";
import { createRefreshScheduler, type RefreshClock } from "./refresh-scheduler";

function fakeClock() {
    let now = 0;
    let next = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const clock: RefreshClock = {
        now: () => now,
        setTimeout(callback, delay) {
            const id = ++next;
            timers.set(id, { at: now + delay, callback });
            return id;
        },
        clearTimeout(handle) {
            timers.delete(handle as number);
        },
    };
    const advance = async (ms: number) => {
        const end = now + ms;
        for (;;) {
            await Promise.resolve();
            await Promise.resolve();
            const due = [...timers.entries()]
                .filter(([, t]) => t.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].callback();
        }
        now = end;
        await Promise.resolve();
        await Promise.resolve();
    };
    return { clock, advance, timers };
}

test("debounces host events by 200ms and limits a stream to one read per second without starvation", async () => {
    const { clock, advance } = fakeClock();
    const starts: number[] = [];
    const scheduler = createRefreshScheduler({
        clock,
        read: async () => {
            starts.push(clock.now());
            return false;
        },
        onSnapshot: () => {},
        isRunning: () => false,
    });
    scheduler.event();
    await advance(100);
    scheduler.event();
    await advance(199);
    expect(starts).toEqual([]);
    await advance(1);
    expect(starts).toEqual([300]);
    for (let i = 0; i < 30; i++) {
        scheduler.event();
        await advance(100);
    }
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(starts.slice(1).every((time, i) => time - starts[i] >= 1000)).toBe(true);
    scheduler.dispose();
});

test("never overlaps reads, coalesces in-flight requests and ignores stale session results", async () => {
    const { clock, advance } = fakeClock();
    const releases: ((value: number) => void)[] = [];
    const snapshots: number[] = [];
    const scheduler = createRefreshScheduler({
        clock,
        read: () => new Promise<number>((resolve) => releases.push(resolve)),
        onSnapshot: (value) => snapshots.push(value),
        isRunning: () => false,
    });
    scheduler.refresh();
    await advance(0);
    scheduler.event();
    scheduler.refresh();
    scheduler.reset();
    await advance(5000);
    expect(releases).toHaveLength(1);
    releases[0](1);
    await advance(1000);
    expect(snapshots).toEqual([]);
    expect(releases).toHaveLength(2);
    releases[1](2);
    await advance(0);
    expect(snapshots).toEqual([2]);
    scheduler.dispose();
});

test("failed reads keep the last good snapshot and block all attempts for 30 seconds", async () => {
    const { clock, advance } = fakeClock();
    const snapshots: number[] = [];
    let attempts = 0;
    const scheduler = createRefreshScheduler({
        clock,
        read: async () => {
            if (++attempts === 2) throw new Error("offline");
            return attempts;
        },
        onSnapshot: (value) => snapshots.push(value),
        isRunning: () => false,
    });
    scheduler.refresh();
    await advance(1000);
    scheduler.refresh();
    await advance(0);
    expect(attempts).toBe(2);
    scheduler.event();
    scheduler.refresh();
    await advance(29999);
    expect(attempts).toBe(2);
    expect(snapshots).toEqual([1]);
    await advance(1);
    expect(attempts).toBe(3);
    expect(snapshots).toEqual([1, 3]);
    scheduler.dispose();
});

test("polls every two seconds only while a background worker runs and stops on idle or disposal", async () => {
    const { clock, advance, timers } = fakeClock();
    let reads = 0;
    const scheduler = createRefreshScheduler({
        clock,
        read: async () => ++reads < 3,
        onSnapshot: () => {},
        isRunning: (running) => running,
    });
    scheduler.refresh();
    await advance(0);
    expect(reads).toBe(1);
    await advance(1999);
    expect(reads).toBe(1);
    await advance(1);
    expect(reads).toBe(2);
    await advance(2000);
    expect(reads).toBe(3);
    await advance(20000);
    expect(reads).toBe(3);
    expect(timers.size).toBe(0);
    scheduler.dispose();
    scheduler.event();
    scheduler.refresh();
    await advance(30000);
    expect(reads).toBe(3);
});
