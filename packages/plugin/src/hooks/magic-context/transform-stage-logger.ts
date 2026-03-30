import { sessionLog } from "../../shared/logger";

export function logTransformTiming(
    sessionId: string,
    stage: string,
    startMs: number,
    extra?: string,
): void {
    const elapsed = (performance.now() - startMs).toFixed(1);
    const suffix = extra ? ` ${extra}` : "";
    sessionLog(sessionId, `transform stage: stage=${stage} elapsed=${elapsed}ms${suffix}`);
}
