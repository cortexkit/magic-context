import type { ContextDatabase } from "../../features/magic-context/storage";
import { updateTagMessageId } from "../../features/magic-context/storage";
import type { Tagger } from "../../features/magic-context/tagger";

type TaggableContentType = "message" | "file";

interface ScopedAssignment {
    tagNumber: number;
    contentId: string;
    partIndex: number;
}

type ScopedAssignments = Record<TaggableContentType, ScopedAssignment[]>;

interface ParsedContentId {
    messageId: string;
    type: TaggableContentType;
    partIndex: number;
}

export interface ExistingTagResolver {
    resolve: (
        messageId: string,
        type: TaggableContentType,
        currentContentId: string,
        ordinal: number,
    ) => number | undefined;
}

function parseScopedContentId(contentId: string): ParsedContentId | null {
    const match = /^(.*):(p|file)(\d+)$/.exec(contentId);
    if (!match) return null;

    return {
        messageId: match[1],
        type: match[2] === "file" ? "file" : "message",
        partIndex: Number.parseInt(match[3], 10),
    };
}

function createScopedAssignments(
    assignments: ReadonlyMap<string, number>,
): Map<string, ScopedAssignments> {
    const scoped = new Map<string, ScopedAssignments>();

    for (const [contentId, tagNumber] of assignments) {
        const parsed = parseScopedContentId(contentId);
        if (!parsed) continue;

        const entry = scoped.get(parsed.messageId) ?? { message: [], file: [] };
        entry[parsed.type].push({ tagNumber, contentId, partIndex: parsed.partIndex });
        scoped.set(parsed.messageId, entry);
    }

    for (const entry of scoped.values()) {
        entry.message.sort((left, right) => left.partIndex - right.partIndex);
        entry.file.sort((left, right) => left.partIndex - right.partIndex);
    }

    return scoped;
}

export function createExistingTagResolver(
    sessionId: string,
    tagger: Tagger,
    db: ContextDatabase,
): ExistingTagResolver {
    const assignments = new Map(tagger.getAssignments(sessionId));
    const scopedAssignments = createScopedAssignments(assignments);
    const usedTagNumbers = new Set<number>();

    return {
        resolve(messageId, type, currentContentId, ordinal) {
            const exactTagId = assignments.get(currentContentId);
            if (exactTagId !== undefined) {
                usedTagNumbers.add(exactTagId);
                return exactTagId;
            }

            const fallback = scopedAssignments.get(messageId)?.[type][ordinal];
            if (!fallback || usedTagNumbers.has(fallback.tagNumber)) {
                return undefined;
            }

            updateTagMessageId(db, sessionId, fallback.tagNumber, currentContentId);
            tagger.bindTag(sessionId, currentContentId, fallback.tagNumber);
            assignments.set(currentContentId, fallback.tagNumber);
            usedTagNumbers.add(fallback.tagNumber);
            return fallback.tagNumber;
        },
    };
}
