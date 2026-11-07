import { computeHardCacheExpired, parseCacheTtl } from "../../features/magic-context/scheduler";

interface IdleWindow {
    cacheTtl: string;
    lastResponseTime: number;
    timer?: ReturnType<typeof setTimeout>;
}

function idleWindowMs(cacheTtl: string): number {
    try {
        return parseCacheTtl(cacheTtl);
    } catch {
        // Use five minutes when a persisted cache lifetime is invalid.
        return 5 * 60 * 1000;
    }
}

/** False when the cache lifetime never expires, so an idle host fold can never arm. */
export function idleFoldCanArm(cacheTtl: string): boolean {
    return Number.isFinite(idleWindowMs(cacheTtl));
}

/** Schedule a host-side fold only after the served request's frozen cache TTL expires. */
export class HostFoldIdle {
    private readonly windows = new Map<string, IdleWindow>();
    private readonly attempted = new Map<string, { cacheTtl: string; lastResponseTime: number }>();
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
        const ttl = idleWindowMs(cacheTtl);
        if (!Number.isFinite(ttl) || lastResponseTime <= 0) return;
        const attempted = this.attempted.get(sessionID);
        if (attempted?.cacheTtl === cacheTtl && attempted.lastResponseTime === lastResponseTime)
            return;
        const window: IdleWindow = { cacheTtl, lastResponseTime };
        this.windows.set(sessionID, window);
        const eligible = () =>
            this.windows.get(sessionID) === window &&
            computeHardCacheExpired(window.cacheTtl, window.lastResponseTime, this.now());
        const wake = () => {
            if (this.windows.get(sessionID) !== window) return;
            if (eligible()) {
                window.timer = undefined;
                // Keep the response window marked as attempted even if its timer
                // is canceled or the host does not admit the queued checkpoint.
                this.attempted.set(sessionID, { cacheTtl, lastResponseTime });
                const release = () => {
                    if (this.windows.get(sessionID) === window) this.windows.delete(sessionID);
                };
                void this.fold(sessionID, eligible).then(release, release);
                return;
            }
            // Node clamps longer delays to 1ms. Chunk long waits, while
            // keeping the fold deadline strictly past the cache lifetime.
            const remaining = Math.max(1, lastResponseTime + ttl - this.now() + 1);
            window.timer = this.timers.setTimeout(wake, Math.min(remaining, 2_147_483_647));
            window.timer.unref?.();
        };
        wake();
    }

    dispose(): void {
        for (const sessionID of this.windows.keys()) this.active(sessionID);
        this.attempted.clear();
    }
}
