import { computeHardCacheExpired, parseCacheTtl } from "../../features/magic-context/scheduler";

interface IdleWindow {
    cacheTtl: string;
    lastResponseTime: number;
    timer?: ReturnType<typeof setTimeout>;
}

/** Schedule a host-side fold only after the served request's frozen cache TTL expires. */
export class HostFoldIdle {
    private readonly windows = new Map<string, IdleWindow>();
    constructor(
        private readonly fold: (sessionID: string, eligible: () => boolean) => Promise<void>,
        private readonly now = Date.now,
        private readonly timers = { setTimeout, clearTimeout },
    ) {}

    active(sessionID: string): void {
        const window = this.windows.get(sessionID);
        if (window?.timer) this.timers.clearTimeout(window.timer);
        this.windows.delete(sessionID);
    }

    idle(sessionID: string, cacheTtl: string, lastResponseTime: number): void {
        this.active(sessionID);
        let ttl: number;
        try {
            ttl = parseCacheTtl(cacheTtl);
        } catch {
            // Match the context scheduler's fallback for invalid persisted TTLs.
            ttl = 5 * 60 * 1000;
        }
        if (!Number.isFinite(ttl) || lastResponseTime <= 0) return;
        const window: IdleWindow = { cacheTtl, lastResponseTime };
        this.windows.set(sessionID, window);
        const eligible = () =>
            this.windows.get(sessionID) === window &&
            computeHardCacheExpired(window.cacheTtl, window.lastResponseTime, this.now());
        const wake = () => {
            if (this.windows.get(sessionID) !== window) return;
            if (eligible()) {
                window.timer = undefined;
                const release = () => {
                    if (this.windows.get(sessionID) === window) this.windows.delete(sessionID);
                };
                void this.fold(sessionID, eligible).then(release, release);
                return;
            }
            // Node clamps longer delays to 1ms. Chunk them, and keep the strict
            // greater-than boundary used by the context scheduler.
            const remaining = Math.max(1, lastResponseTime + ttl - this.now() + 1);
            window.timer = this.timers.setTimeout(wake, Math.min(remaining, 2_147_483_647));
            window.timer.unref?.();
        };
        wake();
    }

    dispose(): void {
        for (const sessionID of this.windows.keys()) this.active(sessionID);
    }
}
