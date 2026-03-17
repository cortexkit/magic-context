type MessageWithParts = {
    info: import("@opencode-ai/sdk").Message;
    parts: import("@opencode-ai/sdk").Part[];
};

type MessagesTransformOutput = { messages: MessageWithParts[] };

export function createMessagesTransformHandler(args: {
    magicContext: {
        "experimental.chat.messages.transform"?: (
            input: Record<string, never>,
            output: MessagesTransformOutput,
        ) => Promise<void>;
    } | null;
}): (input: Record<string, never>, output: MessagesTransformOutput) => Promise<void> {
    return async (input, output): Promise<void> => {
        await args.magicContext?.["experimental.chat.messages.transform"]?.(input, output);
    };
}
