/**
 * Remembers, in memory, cache-busting requests whose work was held because the current
 * turn still keeps signed thinking: an explicit flush, the context-pressure force band and
 * Pi's history refresh. A parked request leaves its queue or pressure flag in place but
 * permits no rebuild until a pass without that thinking.
 */
export class ParkedBustTriggers {
    private materialization = false;
    private force = false;
    private history = false;

    /**
     * `historyPending` is the Pi plugin's history-refresh signal; the OpenCode transform
     * does not park that signal and omits it. While `boundary` is true (the current turn
     * still keeps signed thinking) a parked request permits nothing; the first pass
     * without a boundary gets its permission back.
     */
    permissions(
        boundary: boolean,
        materializationPending: boolean,
        forceEligible: boolean,
        historyPending = false,
    ) {
        if (!materializationPending) this.materialization = false;
        if (!forceEligible) this.force = false;
        if (!historyPending) this.history = false;
        return {
            materialization: materializationPending && !(boundary && this.materialization),
            force: forceEligible && !(boundary && this.force),
            history: historyPending && !(boundary && this.history),
        };
    }

    holdMaterialization(): void {
        this.materialization = true;
    }

    holdForce(): void {
        this.force = true;
    }

    holdHistory(): void {
        this.history = true;
    }

    settle(materializationPending: boolean, forceUnspent: boolean, historyPending = false): void {
        if (!materializationPending) this.materialization = false;
        if (!forceUnspent) this.force = false;
        if (!historyPending) this.history = false;
    }

    get pending(): boolean {
        return this.materialization || this.force || this.history;
    }
}
