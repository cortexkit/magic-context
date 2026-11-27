import { createHash } from "node:crypto";
import { isRecord } from "../../../shared/record-type-guard";
import type { Database } from "../../../shared/sqlite";
import { getDreamState } from "./storage-dream-state";

interface MappingRetry {
    content: string;
    failures: number;
    deferUntil: number;
}

type MappingContent = { category: string; content: string };

export function mapMemoryRetryKey(project: string): string {
    return `map-memories:retry:${project}`;
}

export function readMapMemoryRetries(db: Database, project: string): Record<string, MappingRetry> {
    try {
        const parsed: unknown = JSON.parse(getDreamState(db, mapMemoryRetryKey(project)) ?? "{}");
        if (!isRecord(parsed)) return {};
        const retries: Record<string, MappingRetry> = {};
        for (const [id, value] of Object.entries(parsed)) {
            if (
                isRecord(value) &&
                typeof value.content === "string" &&
                typeof value.failures === "number" &&
                typeof value.deferUntil === "number"
            ) {
                retries[id] = {
                    content: value.content,
                    failures: value.failures,
                    deferUntil: value.deferUntil,
                };
            }
        }
        return retries;
    } catch {
        return {};
    }
}

function contentKey(memory: MappingContent): string {
    return createHash("sha256").update(`${memory.category}\n${memory.content}`).digest("hex");
}

export function isMapMemoryDeferred(
    memory: MappingContent & { id: number },
    retries: Record<string, MappingRetry>,
    now = Date.now(),
): boolean {
    const retry = retries[memory.id];
    return !!retry && retry.deferUntil > now && retry.content === contentKey(memory);
}

export function nextMapMemoryRetry(memory: MappingContent, prior?: MappingRetry): MappingRetry {
    const content = contentKey(memory);
    const failures = (prior?.content === content ? prior.failures : 0) + 1;
    const maxWaitHours = 7 * 24;
    return {
        content,
        failures,
        deferUntil:
            failures < 2 ? 0 : Date.now() + Math.min(maxWaitHours, 2 ** (failures - 2)) * 3_600_000,
    };
}
