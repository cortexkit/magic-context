/**
 * Identifier for the host harness this plugin is running inside.
 *
 * Magic Context's SQLite database lives at a vendor-scoped path
 * (`~/.local/share/cortexkit/magic-context/`) so OpenCode and Pi can share
 * project memories, embedding cache, dreamer runs, and other project-scoped
 * state. Session-scoped tables carry a `harness` column populated from this
 * module so we can disambiguate which harness wrote each session row,
 * filter by harness in the dashboard, and (eventually) migrate sessions
 * between harnesses.
 *
 * Each plugin entry point sets this once at boot, before any DB write
 * happens:
 * - OpenCode plugin: relies on the default ("opencode") — no setHarness call
 *   needed
 * - Pi plugin: calls `setHarness("pi")` before opening the database
 *
 * NEVER read this from configuration or session state — it is a
 * boot-time constant per plugin instance. Cross-harness leakage is a
 * correctness bug, not a feature.
 */
export type HarnessId = "opencode" | "pi";

let currentHarness: HarnessId = "opencode";
let harnessLocked = false;

/**
 * Set the harness identifier for this plugin instance. Must be called once
 * at boot before any DB write happens. Subsequent calls with a different
 * value throw to prevent accidental mid-session swaps that would corrupt
 * the harness column and break per-harness session scoping.
 *
 * Calling with the same value as the current is a no-op (safe to call
 * defensively).
 */
export function setHarness(value: HarnessId): void {
    if (harnessLocked && currentHarness !== value) {
        throw new Error(
            `Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`,
        );
    }
    currentHarness = value;
    harnessLocked = true;
}

/**
 * Get the current harness identifier. Used by storage modules when
 * INSERTing session-scoped rows so each row is correctly attributed.
 */
export function getHarness(): HarnessId {
    return currentHarness;
}

/**
 * Test-only helper to reset harness state between test cases. Do NOT call
 * from production code paths.
 */
export function _resetHarnessForTesting(): void {
    currentHarness = "opencode";
    harnessLocked = false;
}
