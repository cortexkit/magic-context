import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CANONICAL_DREAM_TASKS } from "../../../../plugin/src/features/magic-context/dreamer/task-registry";
import { TASKS } from "./dreamer-task-data";

const RUST_CONFIG_PATH = resolve(import.meta.dir, "../../../src-tauri/src/config.rs");

function rustCanonicalTasks(): string[] {
  const source = readFileSync(RUST_CONFIG_PATH, "utf-8");
  const match = source.match(/CANONICAL_DREAM_TASKS:[^=]+ = \[([\s\S]*?)\];/);
  expect(match).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function rustDefaultSchedule(taskName: string): string {
  const source = readFileSync(RUST_CONFIG_PATH, "utf-8");
  const match = source.match(new RegExp(`"${taskName}"\\s*=>\\s*"([^"]*)"`));
  expect(match, `missing Rust default schedule arm for ${taskName}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("dashboard dreamer task metadata parity", () => {
  it("#given the core registry #then Solid task metadata matches it exactly", () => {
    expect(TASKS.map((task) => task.name)).toEqual([...CANONICAL_DREAM_TASKS]);
    for (const task of TASKS) {
      expect(task.label.trim().length, `${task.name} label`).toBeGreaterThan(0);
      expect(task.description.trim().length, `${task.name} description`).toBeGreaterThan(0);
    }
  });

  it("#given the core registry #then Rust canonical tasks match it exactly", () => {
    expect(rustCanonicalTasks()).toEqual([...CANONICAL_DREAM_TASKS]);
  });

  it("#given Solid task schedules #then Rust defaults stay in lockstep", () => {
    for (const task of TASKS) {
      expect(rustDefaultSchedule(task.name)).toBe(task.defaultSchedule);
    }
  });
});
