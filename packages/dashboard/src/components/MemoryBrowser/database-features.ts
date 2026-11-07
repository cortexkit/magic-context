import type { DatabaseCapabilities } from "../../lib/api";

export const MEMORY_HISTORY_REQUIREMENT = "Memory history needs Magic Context 0.50 or later";

// Hide the history/undo surface until both reads and restores are safe. An
// unresolved capability request must not briefly expose a non-working action.
export function memoryHistoryAvailable(capabilities: DatabaseCapabilities | undefined): boolean {
  return capabilities?.memoryHistory === true && capabilities.memoryUndo === true;
}

export function archiveConfirmation(count: number, historyAvailable: boolean): string {
  return `Archive ${count} memor${count === 1 ? "y" : "ies"}? They stop going into sessions.${historyAvailable ? " You can undo this from History." : ""}`;
}
