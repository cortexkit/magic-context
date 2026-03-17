import type { Database } from "bun:sqlite";
import {
    buildCompartmentBlock,
    getCompartments,
    getSessionFacts,
} from "../../features/magic-context/compartment-storage";
import { getSessionNotes } from "../../features/magic-context/storage";
import { log } from "../../shared/logger";
import type { MessageLike } from "./tag-messages";

export interface PreparedCompartmentInjection {
    block: string;
    compartmentEndMessage: number;
    compartmentCount: number;
    skippedVisibleMessages: number;
    factCount: number;
    noteCount: number;
}

export interface CompartmentInjectionResult {
    injected: boolean;
    compartmentEndMessage: number;
    compartmentCount: number;
    skippedVisibleMessages: number;
}

export function prepareCompartmentInjection(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
): PreparedCompartmentInjection | null {
    const compartments = getCompartments(db, sessionId);
    if (compartments.length === 0) {
        return null;
    }

    const facts = getSessionFacts(db, sessionId);
    const notes = getSessionNotes(db, sessionId);
    const block = buildCompartmentBlock(compartments, facts, notes);
    const lastCompartment = compartments[compartments.length - 1];
    const lastEnd = lastCompartment.endMessage;
    const lastEndMessageId = lastCompartment.endMessageId;

    if (lastEndMessageId.length === 0) {
        log(
            "[magic-context] injecting legacy compartments without visible-prefix trimming because latest stored compartment has no end_message_id",
            {
                sessionId,
                compartmentCount: compartments.length,
                compartmentEndMessage: lastEnd,
            },
        );
        return {
            block,
            compartmentEndMessage: lastEnd,
            compartmentCount: compartments.length,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            noteCount: notes.length,
        };
    }

    let skippedVisibleMessages = 0;
    const cutoffIndex = messages.findIndex((message) => message.info.id === lastEndMessageId);
    if (cutoffIndex >= 0) {
        skippedVisibleMessages = cutoffIndex + 1;
        const remaining = messages.slice(cutoffIndex + 1);
        messages.splice(0, messages.length, ...remaining);
    }

    return {
        block,
        compartmentEndMessage: lastEnd,
        compartmentCount: compartments.length,
        skippedVisibleMessages,
        factCount: facts.length,
        noteCount: notes.length,
    };
}

export function renderCompartmentInjection(
    sessionId: string,
    messages: MessageLike[],
    prepared: PreparedCompartmentInjection,
): CompartmentInjectionResult {
    const historyBlock = `<session-history>\n${prepared.block}\n</session-history>`;
    const firstMessage = messages[0];
    const textPart = firstMessage ? findFirstTextPart(firstMessage.parts) : null;
    if (!firstMessage || !textPart || isDroppedPlaceholder(textPart.text)) {
        messages.unshift({
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: historyBlock }],
        });
    } else {
        textPart.text = `${historyBlock}\n\n${textPart.text}`;
    }

    log(
        `[magic-context] injected ${prepared.compartmentCount} compartments + ${prepared.factCount} facts + ${prepared.noteCount} notes into message[0]`,
    );

    return {
        injected: true,
        compartmentEndMessage: prepared.compartmentEndMessage,
        compartmentCount: prepared.compartmentCount,
        skippedVisibleMessages: prepared.skippedVisibleMessages,
    };
}

function findFirstTextPart(parts: unknown[]): { type: string; text: string } | null {
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
            return p as unknown as { type: string; text: string };
        }
    }
    return null;
}

function isDroppedPlaceholder(text: string): boolean {
    return /^\[dropped §\d+§\]$/.test(text.trim());
}
