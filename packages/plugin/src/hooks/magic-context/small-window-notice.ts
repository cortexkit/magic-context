import { sessionLog } from "../../shared/logger";
import { isTuiConnected, pushNotification } from "../../shared/rpc-notifications";
import { formatSmallWindowCondition, smallWindowCondition } from "../../shared/small-window";

/** Sessions and models already shown the toast in this process. */
const toasted = new Set<string>();
/** Sessions and models whose condition holds, with the text awaiting a terminal. */
const pending = new Map<string, string>();
/** Sessions and models already decided, with the inputs they were decided for. */
const decided = new Map<string, string>();

/** The numbers the notice reads, all in calibrated tokens. */
export interface SmallWindowNumbers {
    systemPromptTokens: number | undefined;
    toolDefinitionTokens: number | undefined;
    reductionPointTokens: number | undefined;
}

/**
 * Tell the user, once per session and model in this process, that the system
 * prompt and tool definitions take more than half of the reduction point. It
 * is shown only where Magic Context already shows things without touching the
 * conversation: a terminal toast when a terminal client is attached to the
 * session, and the log. It never adds a row to the session, never starts a
 * model step and never changes the request, so it cannot affect what the model
 * reads or the provider cache. `/ctx-status` and the sidebar derive the same
 * condition from their own numbers on every refresh, so they carry it across
 * restarts without stored state.
 *
 * On a pass whose `decisionKey` (the inputs the decision depends on, such as
 * the tool-set revision and the reduction point) matches the last decision
 * for this session and model, `measure` does not run, so there is no
 * calibration read and no sizing of tool definitions; the caller still builds
 * the key. Once the condition holds, later passes only check whether a
 * terminal has attached. With any number unknown nothing is reported. The
 * decisions are kept for the life of the process, for quiet sessions too.
 */
export function reportSmallWindow(input: {
    sessionId: string;
    modelKey: string;
    decisionKey: string;
    measure: () => SmallWindowNumbers | undefined;
}): void {
    const key = `${input.sessionId}\0${input.modelKey}`;
    if (toasted.has(key)) return;
    if (!pending.has(key)) {
        if (decided.get(key) === input.decisionKey) return;
        decided.set(key, input.decisionKey);
        const numbers = input.measure();
        const condition = numbers ? smallWindowCondition(numbers) : null;
        if (!condition) return;
        const text = formatSmallWindowCondition(condition, input.modelKey);
        pending.set(key, text);
        sessionLog(input.sessionId, `small window: ${text}`);
    }
    if (!isTuiConnected(input.sessionId)) return;
    const text = pending.get(key);
    pending.delete(key);
    toasted.add(key);
    pushNotification(
        "toast",
        { title: "Magic Context", message: text, variant: "warning", duration: 15_000 },
        input.sessionId,
    );
}

/** Test helper: forget which sessions were told or decided. */
export function resetSmallWindowReportsForTest(): void {
    toasted.clear();
    pending.clear();
    decided.clear();
}
