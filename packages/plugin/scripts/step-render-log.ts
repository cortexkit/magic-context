/** The runner emits this after rendering a model request, before sending it. */
export interface StepRender {
    sessionId: string;
    at: number;
    elapsed: number;
    /** wait_ms is the host plugin's whole wait for the runner's answer, not module time. */
    wait: number;
    entries?: number;
    view?: number | null;
}

export interface StepAnswer {
    sessionId: string;
    at: number;
    elapsed: number;
    module: number | null;
}

export function parseStepAnswer(line: string): StepAnswer | null {
    const at = Date.parse(line.match(/(?:\[)?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z)/)?.[1] ?? "");
    const step = line.match(/\bstep answer session=(\S+) elapsed_ms=(\d+)/);
    if (!step || !Number.isFinite(at)) return null;
    // setup_ms and ride_ms are round trips to the Magic Context module alone;
    // the answer's other timings belong to the runner. A dash means no call,
    // whereas absent fields in older runner logs leave module time unknown.
    const setup = line.match(/\bsetup_ms=(\d+|-)(?=\s|$)/)?.[1];
    const ride = line.match(/\bride_ms=(\d+|-)(?=\s|$)/)?.[1];
    const module = setup !== undefined && ride !== undefined
        ? (setup === "-" ? 0 : Number(setup)) + (ride === "-" ? 0 : Number(ride)) : null;
    return { sessionId: step[1]!, at, elapsed: Number(step[2]), module };
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
