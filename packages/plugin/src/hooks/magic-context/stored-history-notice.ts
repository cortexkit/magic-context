type StoredHistoryNotice = (sessionId: string, gap: string) => Promise<boolean>;

const notices = new Map<string, StoredHistoryNotice>();

export function registerStoredHistoryNotice(directory: string, notice: StoredHistoryNotice) {
    notices.set(directory, notice);
    return () => {
        if (notices.get(directory) === notice) notices.delete(directory);
    };
}

/** True when the host owns the notice for this session (including if already delivered). */
export async function notifyStoredHistoryGap(
    directory: string | undefined,
    sessionId: string,
    validationError: string,
): Promise<boolean> {
    if (!directory || !validationError.startsWith("gap before message ")) return false;
    return (await notices.get(directory)?.(sessionId, validationError)) ?? false;
}
