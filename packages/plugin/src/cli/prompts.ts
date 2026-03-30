import {
    confirm as clackConfirm,
    intro,
    isCancel,
    log,
    note,
    outro,
    select,
    spinner,
} from "@clack/prompts";

export { intro, log, note, outro, spinner };

function handleCancel(value: unknown): void {
    if (isCancel(value)) {
        log.warn("Setup cancelled.");
        process.exit(0);
    }
}

export async function confirm(message: string, defaultYes = true): Promise<boolean> {
    const result = await clackConfirm({
        message,
        initialValue: defaultYes,
    });
    handleCancel(result);
    return result as boolean;
}

export async function selectOne(
    message: string,
    options: { label: string; value: string; recommended?: boolean }[],
): Promise<string> {
    const result = await select({
        message,
        options: options.map((opt) => ({
            label: opt.recommended ? `${opt.label} (recommended)` : opt.label,
            value: opt.value,
            hint: opt.recommended ? "recommended" : undefined,
        })),
    });
    handleCancel(result);
    return result as string;
}
