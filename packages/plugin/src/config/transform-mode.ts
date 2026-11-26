import { log } from "../shared/logger";

/**
 * The transform implementation a host runs. Plugin config always resolves to
 * "ts" now. "rust" stays in the type because the CortexKit bridge sets it in its
 * own transform deps, which it builds without reading `transform_mode`.
 */
export type ResolvedTransformMode = "ts" | "rust";

/** Accepted for older call sites; every argument is ignored. */
export interface ResolveTransformModeArgs {
    configured?: ResolvedTransformMode;
    userTierHasSubc?: boolean;
    compactionEnabled?: boolean;
}

export const TRANSFORM_MODE_DEPRECATION_WARNING =
    "transform_mode is no longer used; Magic Context runs its TypeScript transform. Sessions that moved to CortexKit are managed there.";

/** Config keys that used to select the Rust transform. They are still accepted, but ignored. */
export const DEPRECATED_TRANSFORM_KEYS = ["transform_mode", "rust_pipeline"] as const;

/**
 * Every host runs the TypeScript transform. The full-array Rust transform and
 * the in-tree OpenCode provider pipeline are no longer selectable from config;
 * sessions that use the Rust step contract reach it through the CortexKit bridge.
 */
export function resolveTransformMode(_args?: ResolveTransformModeArgs): { mode: "ts" } {
    return { mode: "ts" };
}

/** True when a raw config layer sets `transform_mode` or `rust_pipeline`. */
export function hasDeprecatedTransformKeys(raw: Record<string, unknown> | undefined): boolean {
    return raw !== undefined && DEPRECATED_TRANSFORM_KEYS.some((key) => Object.hasOwn(raw, key));
}

let warnedTransformModeDeprecation = false;

/**
 * Log the deprecation once per process. Config is loaded many times in one
 * process (each OpenCode project, each OpenCode 2 session, live reloads, the
 * bridge), so a per-load warning would repeat.
 */
export function warnTransformModeDeprecatedOnce(): void {
    if (warnedTransformModeDeprecation) return;
    warnedTransformModeDeprecation = true;
    log(`[magic-context] ${TRANSFORM_MODE_DEPRECATION_WARNING}`);
}

export function resetTransformModeDeprecationWarningForTest(): void {
    warnedTransformModeDeprecation = false;
}
