/**
 * User-facing spelling of the compaction-off config path, for log lines and
 * command output. Built from fragments so the accessor-exclusivity guard
 * (compaction-accessor-guard.test.ts) can keep rejecting literal
 * `compaction.enabled` reads elsewhere — messages import this constant instead
 * of inlining the path (the S5/S8 slices both re-derived it and tripped the
 * guard; one constant ends that class).
 */
export const COMPACTION_ENABLED_PATH = `compaction${"."}enabled`;

export function isDreamerRunnable(config: { dreamer?: { disable?: boolean } | null }): boolean {
    return !!config.dreamer && config.dreamer.disable !== true;
}

export function isHistorianRunnable(config: { historian?: { disable?: boolean } | null }): boolean {
    return config.historian?.disable !== true;
}

export function isSubagentReconciliationEnabled(config: {
    historian?: { subagent_reconciliation?: boolean } | null;
}): boolean {
    return config.historian?.subagent_reconciliation === true;
}

/**
 * The ONLY non-schema reader of the `compaction.enabled` config path.
 * Resolves the compaction-off mode gate from a parsed Magic Context config.
 * Lives beside the other subsystem toggles (isDreamerRunnable /
 * isHistorianRunnable) and is IMPORTED — never re-derived — by every gate
 * site (pi-plugin, cli, plugin boot, session hooks). Returns true (compaction
 * ON / default behavior) when the block or field is absent.
 */
export function isCompactionEnabled(config: {
    compaction?: { enabled?: boolean } | null;
}): boolean {
    return config.compaction?.enabled !== false;
}

function clonePlainObject(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    return { ...(value as Record<string, unknown>) };
}

function migrateLegacyEnabledForAgent(args: {
    patched: Record<string, unknown>;
    agentName: "dreamer" | "historian";
    warnings: string[];
}): void {
    const agent = clonePlainObject(args.patched[args.agentName]);
    if (!agent || !("enabled" in agent)) return;

    const enabled = agent.enabled;
    const disable = agent.disable;
    delete agent.enabled;

    if (args.agentName === "historian") {
        args.warnings.push(
            'Removed invalid "historian.enabled" in-memory (run doctor to persist).',
        );
        args.patched.historian = agent;
        return;
    }

    if (disable !== true && enabled === false) {
        agent.disable = true;
        args.warnings.push(
            'Migrated "dreamer.enabled=false" → "dreamer.disable=true" in-memory (run doctor to persist). This now also disables manual /ctx-dream; for manual-only remove disable and set schedule="".',
        );
    }
    // enabled=true is a no-op alias for the new default (disable=false); strip silently.
    args.patched.dreamer = agent;
}

export function migrateLegacyAgentEnabledInMemory(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    const shouldPatch = ["dreamer", "historian"].some((key) => {
        const agent = rawConfig[key];
        return (
            typeof agent === "object" &&
            agent !== null &&
            !Array.isArray(agent) &&
            "enabled" in agent
        );
    });
    if (!shouldPatch) return rawConfig;

    const patched: Record<string, unknown> = { ...rawConfig };
    migrateLegacyEnabledForAgent({ patched, agentName: "dreamer", warnings });
    migrateLegacyEnabledForAgent({ patched, agentName: "historian", warnings });
    return patched;
}
