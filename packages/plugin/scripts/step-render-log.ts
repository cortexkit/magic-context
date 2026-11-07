/** The runner emits this after rendering a model request, before sending it. */
export interface StepRender {
    sessionId: string;
    at: number;
    elapsed: number;
    wait: number;
    entries?: number;
    view?: number | null;
}

export function parseStepRender(line: string): StepRender | null {
    const at = Date.parse(line.match(/(?:\[)?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)/)?.[1] ?? "");
    const step = line.match(/\bstep render session=(\S+) elapsed_ms=(\d+) wait_ms=(\d+)/);
    if (!step || !Number.isFinite(at)) return null;
    const entries = line.match(/\bentries=(\d+)/)?.[1];
    const view = line.match(/\bview=(\d+|none)\b/)?.[1];
    return {
        sessionId: step[1]!, at, elapsed: Number(step[2]), wait: Number(step[3]),
        ...(entries ? { entries: Number(entries) } : {}),
        ...(view ? { view: view === "none" ? null : Number(view) } : {}),
    };
}
