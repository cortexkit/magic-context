import { isTextPart } from "./tag-part-guards";
import type { MessageLike } from "./transform-operations";

export function findSessionId(messages: MessageLike[]): string | null {
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
        if (message.info.role === "user" && typeof message.info.id === "string") {
            return message.info.id;
        }
    }

    return null;
}

export function appendReminderToLatestUserMessage(
    messages: MessageLike[],
    reminder: string,
): boolean {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info.role !== "user") {
            continue;
        }

        for (const part of message.parts) {
            if (!isTextPart(part)) {
                continue;
            }

            if (!part.text.includes(reminder)) {
                part.text += reminder;
            }
            return true;
        }

        message.parts.unshift({ type: "text", text: reminder.trimStart() });
        return true;
    }

    return false;
}

export function countMessagesSinceLastUser(messages: MessageLike[]): number {
    let messagesSinceLastUser = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].info.role === "user") break;
        messagesSinceLastUser += 1;
    }
    return messagesSinceLastUser;
}
