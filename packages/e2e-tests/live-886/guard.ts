import { cost, type Usage, type UsageRow, usageOf } from "./evidence";

export class Guard {
    mainID = "";
    mainPasses = 0;
    reason = "";
    private calls = new Map<string, { sessionID: string; kind: string; before: number; usage?: Usage }>();

    constructor(readonly stepCap: number, readonly dollarCap: number, readonly maxCallCost: number) {}

    outstandingCost(rows: UsageRow[]): number {
        return [...this.calls.values()].filter((call) => !call.usage && !(call.kind === "primary"
            && rows.filter((row) => row.session_id === call.sessionID).length > call.before)).length * this.maxCallCost;
    }

    extraCost(rows: UsageRow[]): number {
        let dollars = 0;
        for (const call of this.calls.values()) {
            const persisted = call.kind === "primary" && rows.filter((row) => row.session_id === call.sessionID).length > call.before;
            if (call.usage && !persisted) dollars += cost(call.usage);
        }
        return dollars;
    }

    result(callID: string, usage: Usage): void {
        const call = this.calls.get(callID);
        if (!call) throw new Error("Unknown provider response identity");
        call.usage = usage;
    }

    authorize(sessionID: string, rows: UsageRow[], kind = "primary", callID = String(this.calls.size)): boolean {
        if (this.reason) return false;
        if (kind === "primary" && sessionID === this.mainID && this.mainPasses >= this.stepCap) {
            this.reason = "step_cap";
            return false;
        }
        const spent = rows.reduce((sum, row) => sum + cost(usageOf(row)), 0) + this.extraCost(rows);
        const pending = this.outstandingCost(rows);
        if (spent + pending + this.maxCallCost > this.dollarCap) {
            this.reason = "spend_guard";
            return false;
        }
        if (kind === "primary" && [...this.calls.values()].some((call) => call.kind === "primary"
            && call.sessionID === sessionID && rows.filter((row) => row.session_id === sessionID).length <= call.before)) {
            this.reason = "missing_usage";
            throw new Error("Previous provider usage was not persisted; refusing another call");
        }
        this.calls.set(callID, { sessionID, kind, before: rows.filter((row) => row.session_id === sessionID).length });
        if (kind === "primary" && sessionID === this.mainID) this.mainPasses++;
        return true;
    }
}
