import { log } from "../../../shared/logger";
import type { Memory } from "../memory";
import { V2_MEMORY_CATEGORIES } from "../memory/constants";
import { isDirectiveShapedProjectRule } from "./memory-claim-safety";

const PROJECT_SCOPED_CATEGORIES: ReadonlySet<string> = new Set(V2_MEMORY_CATEGORIES);
const USER_PROFILE_REFERENCE = /\buser(?:[\s_-]+)(?:profile|preferences?)\b|\bU\d+\b/i;

export type CurateMutationVerdict = "archive" | "update";
export type CurateSafetyRefusalReason =
    | "missing-active-same-category-successor"
    | "user-profile-is-not-project-memory"
    | "directive-shaped-project-rule"
    | "content-loss";

export interface CurateSafetyRefusal {
    memoryId: number;
    verdict: CurateMutationVerdict;
    reason: CurateSafetyRefusalReason;
    originalChars?: number;
    replacementChars?: number;
}

const refusalCountsBySession = new Map<string, number>();

function isSurvivingConsolidationTarget(
    memory: Memory,
    successor: Memory | null,
    projectIdentity: (memory: Memory) => string,
): successor is Memory {
    return (
        successor !== null &&
        successor.id !== memory.id &&
        successor.status === "active" &&
        successor.supersededByMemoryId === null &&
        (successor.expiresAt === null || successor.expiresAt > Date.now()) &&
        projectIdentity(successor) === projectIdentity(memory) &&
        successor.category === memory.category
    );
}

export function assessCurateMutationSafety(args: {
    memory: Memory;
    verdict: CurateMutationVerdict;
    reason?: string;
    replacementContent?: string;
    successor: Memory | null;
    projectIdentity: (memory: Memory) => string;
}): CurateSafetyRefusal | null {
    const { memory, successor, verdict } = args;
    if (verdict === "archive") {
        if (!isSurvivingConsolidationTarget(memory, successor, args.projectIdentity)) {
            return {
                memoryId: memory.id,
                verdict,
                reason: "missing-active-same-category-successor",
            };
        }
        if (
            PROJECT_SCOPED_CATEGORIES.has(memory.category) &&
            USER_PROFILE_REFERENCE.test(args.reason ?? "")
        ) {
            return {
                memoryId: memory.id,
                verdict,
                reason: "user-profile-is-not-project-memory",
            };
        }
    }

    if (isDirectiveShapedProjectRule(memory.category, memory.content)) {
        return {
            memoryId: memory.id,
            verdict,
            reason: "directive-shaped-project-rule",
        };
    }

    if (verdict === "update") {
        const originalChars = memory.content.trim().length;
        const replacementChars = args.replacementContent?.trim().length ?? 0;
        if (
            replacementChars * 2 < originalChars &&
            !isSurvivingConsolidationTarget(memory, successor, args.projectIdentity)
        ) {
            return {
                memoryId: memory.id,
                verdict,
                reason: "content-loss",
                originalChars,
                replacementChars,
            };
        }
    }

    return null;
}

export function recordCurateSafetyRefusal(sessionId: string, refusal: CurateSafetyRefusal): number {
    const count = (refusalCountsBySession.get(sessionId) ?? 0) + 1;
    refusalCountsBySession.set(sessionId, count);
    const lengths =
        refusal.originalChars === undefined
            ? ""
            : ` original_chars=${refusal.originalChars} replacement_chars=${refusal.replacementChars ?? 0}`;
    log(
        `[dreamer] curate safety refusal: session_id=${sessionId} memory_id=${refusal.memoryId} verdict=${refusal.verdict} reason=${refusal.reason}${lengths} refused=${count}`,
    );
    return count;
}

export function takeCurateSafetyRefusalCount(sessionId: string): number {
    const count = refusalCountsBySession.get(sessionId) ?? 0;
    refusalCountsBySession.delete(sessionId);
    return count;
}
