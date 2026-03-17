import { log } from "../../shared/logger";

export function logTransformTiming(
    sessionId: string,
    stage: string,
    startMs: number,
    extra?: string,
): void {
    const elapsed = (performance.now() - startMs).toFixed(1);
    const suffix = extra ? ` ${extra}` : "";
    log(
        `[magic-context] transform stage: session=${sessionId} stage=${stage} elapsed=${elapsed}ms${suffix}`,
    );
}
