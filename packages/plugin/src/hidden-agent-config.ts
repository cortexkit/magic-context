import { buildAllowOnlyPermission } from "./agents/permissions";

/**
 * Build a hidden-agent config with a deny-everything-by-default permission
 * baseline and a hard tool-iteration ceiling. User overrides may lower
 * `steps`/`maxSteps`, but cannot raise either above the built-in cap.
 *
 * Lives in its own module — NOT in the plugin entry (`index.ts`) — because
 * opencode 1.17 invokes EVERY exported function in a plugin's entry module as
 * its own plugin factory. Exporting this helper from `index.ts` made opencode
 * call it as `buildHiddenAgentConfig(ctx)`, passing the plugin context as
 * `prompt` and `undefined` as `allowedTools`, which crashed plugin load
 * ("undefined is not an object (evaluating 'allowedTools')"). The entry module
 * must export only `default`; helpers that need to be exported (e.g. for tests)
 * live in sibling modules like this one.
 */
export function buildHiddenAgentConfig(
    prompt: string,
    allowedTools: readonly string[],
    maxSteps: number,
    overrides?: Record<string, unknown>,
) {
    const { permission: overridePermission, ...restOverrides } = (overrides ?? {}) as {
        permission?: Record<string, unknown>;
        [key: string]: unknown;
    };
    const basePermission = buildAllowOnlyPermission(allowedTools);
    return {
        prompt,
        // No builtin fallback chain: the user's `fallback_models` (if any) flow
        // through `restOverrides`. A hardcoded chain names providers the user may
        // not have, producing `Model not found` retry storms.
        ...restOverrides,
        steps: clampHiddenAgentStepLimit(restOverrides.steps, maxSteps),
        maxSteps: clampHiddenAgentStepLimit(restOverrides.maxSteps, maxSteps),
        // Permission baseline goes after `restOverrides` so that accidental
        // `permission` keys in user overrides we DIDN'T explicitly destructure
        // can't bypass the deny. The explicit override (destructured above) is
        // then layered on top.
        permission: {
            ...basePermission,
            ...(overridePermission ?? {}),
        },
        mode: "subagent" as const,
        hidden: true,
    };
}

function clampHiddenAgentStepLimit(value: unknown, cap: number): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(value, cap) : cap;
}
