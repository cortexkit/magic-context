import { hasMeaningfulUserText } from "./read-session-formatting";
import { isTextPart } from "./tag-part-guards";
import type { MessageLike } from "./transform-operations";

/**
 * Check if a user message contains real user content (not just ignored
 * notifications, system reminders, or command output). Uses the same
 * logic the historian uses for protected-tail counting.
 */
function isMeaningfulUserMessage(msg: MessageLike): boolean {
    return msg.info.role === "user" && hasMeaningfulUserText(msg.parts as unknown[]);
}

export function findSessionId(messages: MessageLike[]): string | null {
    // Session ID is valid on any user message, including ignored ones
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info.role === "user" && typeof message.info.sessionID === "string") {
            return message.info.sessionID;
        }
    }

    return null;
}

export function findLastUserMessageId(messages: MessageLike[]): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (isMeaningfulUserMessage(message) && typeof message.info.id === "string") {
            return message.info.id;
        }
    }

    return null;
}

export function appendReminderToLatestUserMessage(
    messages: MessageLike[],
    reminder: string,
): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isMeaningfulUserMessage(message)) {
            continue;
        }

        appendReminderToUserMessage(message, reminder);
        return typeof message.info.id === "string" ? message.info.id : null;
    }

    return null;
}

export function appendReminderToUserMessageById(
    messages: MessageLike[],
    messageId: string,
    reminder: string,
): boolean {
    for (const message of messages) {
        if (message.info.id !== messageId || !isMeaningfulUserMessage(message)) {
            continue;
        }

        appendReminderToUserMessage(message, reminder);
        return true;
    }

    return false;
}

export function countMessagesSinceLastUser(messages: MessageLike[]): number {
    let messagesSinceLastUser = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (isMeaningfulUserMessage(messages[i])) break;
        messagesSinceLastUser += 1;
    }
    return messagesSinceLastUser;
}

function appendReminderToUserMessage(message: MessageLike, reminder: string): void {
    for (const part of message.parts) {
        if (!isTextPart(part)) {
            continue;
        }

        if (!part.text.includes(reminder)) {
            part.text += reminder;
        }
        return;
    }

    message.parts.unshift({ type: "text", text: reminder.trimStart() });
}
