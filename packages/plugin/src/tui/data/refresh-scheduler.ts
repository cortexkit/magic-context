export interface RefreshClock {
    now(): number;
    setTimeout(callback: () => void, delay: number): unknown;
    clearTimeout(handle: unknown): void;
}

export function createRefreshScheduler<T>(options: {
    read(): Promise<T>;
    onSnapshot(snapshot: T): void;
    isRunning(snapshot: T): boolean;
    clock?: RefreshClock;
}) {
    const clock: RefreshClock = options.clock ?? {
        now: () => Date.now(),
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    let timer: unknown;
    let disposed = false;
    let inFlight = false;
    let generation = 0;
    let lastStarted = -Infinity;
    let blockedUntil = 0;
    let requestedAt = Infinity;
    let pollAt = Infinity;
    let burstStarted: number | undefined;

    function arm() {
        if (timer !== undefined) clock.clearTimeout(timer);
        timer = undefined;
        if (disposed || inFlight) return;
        const due = Math.max(Math.min(requestedAt, pollAt), lastStarted + 1000, blockedUntil);
        if (!Number.isFinite(due)) return;
        timer = clock.setTimeout(
            () => {
                timer = undefined;
                void read();
            },
            Math.max(0, due - clock.now()),
        );
    }

    async function read() {
        if (disposed || inFlight) return;
        const currentGeneration = generation;
        inFlight = true;
        lastStarted = clock.now();
        requestedAt = Infinity;
        pollAt = Infinity;
        burstStarted = undefined;
        try {
            const snapshot = await options.read();
            if (disposed || currentGeneration !== generation) return;
            blockedUntil = 0;
            options.onSnapshot(snapshot);
            pollAt = options.isRunning(snapshot) ? clock.now() + 2000 : Infinity;
        } catch {
            if (disposed || currentGeneration !== generation) return;
            blockedUntil = clock.now() + 30000;
            requestedAt = blockedUntil;
        } finally {
            inFlight = false;
            arm();
        }
    }

    return {
        event() {
            if (disposed) return;
            const now = clock.now();
            burstStarted ??= now;
            // A continuous stream must not postpone the trailing read without limit.
            requestedAt = Math.min(now + 200, burstStarted + 1000);
            arm();
        },
        refresh() {
            if (disposed) return;
            requestedAt = Math.min(requestedAt, clock.now());
            arm();
        },
        reset() {
            if (disposed) return;
            generation += 1;
            pollAt = Infinity;
            blockedUntil = 0;
            burstStarted = undefined;
            requestedAt = clock.now();
            arm();
        },
        dispose() {
            disposed = true;
            generation += 1;
            if (timer !== undefined) clock.clearTimeout(timer);
            timer = undefined;
        },
    };
}
