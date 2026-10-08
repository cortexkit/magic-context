import { describe, expect, test } from "bun:test";
import { createLogPoll } from "./log-poll";

describe("Log live polling", () => {
  test("measures backend refreshes per minute in foreground, background and hidden", async () => {
    const measured: number[] = [];
    for (const [hidden, focused] of [
      [false, true],
      [false, false],
      [true, false],
    ]) {
      let reads = 0;
      const tick = createLogPoll(
        () => ({ hidden: !!hidden, focused: !!focused, paused: false, loading: false }),
        async () => {
          reads += 1;
        },
      );
      for (let second = 3; second <= 60; second += 3) await tick();
      measured.push(reads);
    }
    expect(measured).toEqual([20, 2, 0]);
    console.log(
      "Log backend refreshes/minute (excluding mount): before=20/20/20, after=20/2/0 (focused/unfocused/hidden)",
    );
  });

  test("hidden and paused return events never dispatch backend work", async () => {
    const state = { hidden: true, focused: true, paused: false, loading: false };
    let reads = 0;
    const tick = createLogPoll(
      () => state,
      async () => {
        reads += 1;
      },
    );
    await tick(true);
    state.hidden = false;
    state.paused = true;
    await tick(true);
    expect(reads).toBe(0);
    state.paused = false;
    state.focused = false;
    await tick(true);
    expect(reads).toBe(1);
  });

  test("latches slow reads and refreshes immediately after an in-flight return", async () => {
    const state = { hidden: false, focused: true, paused: false, loading: true };
    let reads = 0;
    let finish = () => {};
    const tick = createLogPoll(
      () => state,
      () => {
        reads += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    await tick();
    expect(reads).toBe(0); // The resource's initial load is also latched.
    state.loading = false;
    const pending = tick();
    await tick();
    await tick(true);
    expect(reads).toBe(1);
    finish();
    await Promise.resolve();
    expect(reads).toBe(2);
    finish();
    await pending;
    state.hidden = true;
    await tick(true);
    state.hidden = false;
    state.focused = false;
    const returned = tick(true);
    expect(reads).toBe(3);
    finish();
    await returned;
  });
});
