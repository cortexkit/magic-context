export type RollingNudgeBand = "far" | "near" | "urgent" | "critical";

export function getRollingNudgeBand(
    percentage: number,
    executeThresholdPercentage: number,
): RollingNudgeBand {
    if (percentage >= executeThresholdPercentage) {
        return "critical";
    }
    if (percentage >= executeThresholdPercentage - 10) {
        return "urgent";
    }
    if (percentage >= executeThresholdPercentage - 20) {
        return "near";
    }
    return "far";
}

export function getRollingNudgeBandPriority(band: RollingNudgeBand | null): number {
    switch (band) {
        case "far":
            return 0;
        case "near":
            return 1;
        case "urgent":
            return 2;
        case "critical":
            return 3;
        default:
            return -1;
    }
}

export function formatRollingNudgeBand(band: RollingNudgeBand | null): string {
    return band ?? "none";
}

export function getRollingNudgeIntervalTokens(
    baseIntervalTokens: number,
    band: RollingNudgeBand,
): number {
    switch (band) {
        case "far":
            return baseIntervalTokens;
        case "near":
            return Math.max(1, Math.floor(baseIntervalTokens / 2));
        case "urgent":
            return Math.max(1, Math.floor(baseIntervalTokens / 4));
        case "critical":
            return Math.max(1, Math.floor(baseIntervalTokens / 8));
    }
}
