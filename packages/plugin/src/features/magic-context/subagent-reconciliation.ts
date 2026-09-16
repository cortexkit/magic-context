import type { Database } from "../../shared/sqlite";
import { getLastCompartmentEndMessage } from "./compartment-storage";

/** Existing summaries must remain visible after new reconciliation is disabled. */
export function canRenderSessionHistory(
    db: Database,
    sessionId: string,
    isSubagent: boolean,
    reconciliationEnabled: boolean,
): boolean {
    return !isSubagent || reconciliationEnabled || getLastCompartmentEndMessage(db, sessionId) >= 0;
}
