const TAG_PREFIX_REGEX = /^(\u00a7\d+\u00a7\s*)+/;

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },
        output: { text: string },
    ): Promise<void> => {
        output.text = output.text.replace(TAG_PREFIX_REGEX, "");
    };
}
