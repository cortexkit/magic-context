import { formatDreamTaskBacklogs } from "./task-registry";
import type { ManualRunResult } from "./task-scheduler";

/**
 * Render a manual `/ctx-dream` run for the user. Shared by the v1 command
 * output and the v2 RPC notification so the two surfaces stay identical.
 */
export function summarizeManualDream(summary: ManualRunResult): string {
    const lines: string[] = ["## /ctx-dream", ""];
    if (summary.ran.length > 0) lines.push(`Ran: ${summary.ran.join(", ")}`);
    if ((summary.details?.length ?? 0) > 0) {
        lines.push("Details:", ...(summary.details ?? []).map((detail) => `- ${detail}`));
    }
    if (summary.failed.length > 0) lines.push(`Failed: ${summary.failed.join(", ")}`);
    if ((summary.failureDetails?.length ?? 0) > 0) {
        lines.push(
            "Failure details:",
            ...(summary.failureDetails ?? []).map((detail) => `- ${detail}`),
        );
    }
    if (summary.skippedNoWork.length > 0)
        lines.push(`Skipped (no work): ${summary.skippedNoWork.join(", ")}`);
    if (summary.deferredBusy.length > 0)
        lines.push(
            // "Busy" means the task's DOMAIN lease is held — usually a sibling
            // task (e.g. a scheduled verify blocking a manual curate), not
            // this task itself. Say so, or the message reads as a lie.
            `Busy: ${summary.deferredBusy.join(", ")} — another dream task holds this domain's lease; retry in a minute`,
        );
    if (Object.keys(summary.backlogBefore ?? {}).length > 0) {
        lines.push(
            "",
            "Backlog at run start:",
            formatDreamTaskBacklogs(summary.backlogBefore ?? {}),
        );
    }
    if (Object.keys(summary.backlogAfter ?? {}).length > 0) {
        lines.push("", "Backlog at run end:", formatDreamTaskBacklogs(summary.backlogAfter ?? {}));
    }
    if (
        summary.ran.length === 0 &&
        summary.failed.length === 0 &&
        summary.skippedNoWork.length === 0 &&
        summary.deferredBusy.length === 0
    ) {
        lines.push("No enabled dream tasks to run.");
    }
    return lines.join("\n");
}
