import { FORCE_MATERIALIZE_PERCENTAGE } from "./compartment-trigger";

export interface DeferredConsumptionArgs {
    schedulerDecision: "execute" | "defer";
    contextPercentage: number;
    /** True when this pass awaited a run that actually published new compartment state. */
    justAwaitedPublication: boolean;
    /** True when an active run would block materialization below the emergency bypass. */
    activeRunBlocksMaterialization: boolean;
}

export function canConsumeDeferredOnThisPass(args: DeferredConsumptionArgs): boolean {
    if (args.justAwaitedPublication) return true;
    if (args.activeRunBlocksMaterialization) return false;

    return (
        args.schedulerDecision === "execute" ||
        args.contextPercentage >= FORCE_MATERIALIZE_PERCENTAGE
    );
}
