/** Remember withheld flush and force-band requests in memory without consuming their queues or pressure latches. */
export class ParkedBustTriggers {
    private materialization = false;
    private force = false;

    permissions(boundary: boolean, materializationPending: boolean, forceEligible: boolean) {
        if (!materializationPending) this.materialization = false;
        if (!forceEligible) this.force = false;
        return {
            materialization: materializationPending && !(boundary && this.materialization),
            force: forceEligible && !(boundary && this.force),
        };
    }

    holdMaterialization(): void {
        this.materialization = true;
    }

    holdForce(): void {
        this.force = true;
    }

    settle(materializationPending: boolean, forceUnspent: boolean): void {
        if (!materializationPending) this.materialization = false;
        if (!forceUnspent) this.force = false;
    }

    get pending(): boolean {
        return this.materialization || this.force;
    }
}
