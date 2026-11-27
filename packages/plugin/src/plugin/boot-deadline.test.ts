import { afterEach, describe, expect, jest, test } from "bun:test";
import {
    __resetOffThreadMigrationClockForTests,
    __setOffThreadMigrationClockForTests,
    beginOffThreadMigration,
} from "../shared/off-thread-migration-clock";
import {
    createBootBudget,
    emitBootEnteringBreadcrumb,
    formatBootPhaseDiagnostics,
    remainingBootBudgetMs,
    runBootPhaseWithDeadline,
    runBootPhaseWithinBudget,
} from "./boot-deadline";

function useBootClock() {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const started = Date.now();
    __setOffThreadMigrationClockForTests({
        now: () => Date.now() - started,
        setTimeout(callback, delayMs) {
            const timer = setTimeout(callback, delayMs);
            return () => clearTimeout(timer);
        },
    });
}

const flushBoot = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("boot phase deadline", () => {
    afterEach(() => {
        __resetOffThreadMigrationClockForTests();
        jest.useRealTimers();
    });

    test("a schema migration running off the main thread does not count against the deadline", async () => {
        useBootClock();
        const messages: string[] = [];
        const endMigration = beginOffThreadMigration();
        const hooks = Promise.withResolvers<string>();
        try {
            const boot = runBootPhaseWithDeadline(
                "hooks",
                () => hooks.promise,
                20,
                (message) => messages.push(message),
            );
            jest.advanceTimersByTime(19);
            expect(messages).toEqual([]);
            jest.advanceTimersByTime(1);
            expect(messages).toEqual([
                "[magic-context] boot phase 'hooks' reached its 20ms deadline while a schema migration runs off the main thread; waiting for the migration, which does not count against the deadline",
            ]);
            jest.advanceTimersByTime(100);
            endMigration();
            hooks.resolve("real hooks");
            expect(await boot).toMatchObject({ status: "completed", value: "real hooks" });
            expect(messages).toHaveLength(1);
        } finally {
            endMigration();
            hooks.resolve("real hooks");
        }
    });

    test("the deadline still fires once the off-thread migration has finished", async () => {
        const endMigration = beginOffThreadMigration();
        setTimeout(endMigration, 40);
        try {
            const result = await runBootPhaseWithDeadline(
                "hooks",
                () => new Promise<never>(() => {}),
                20,
                () => {},
            );
            expect(result.status).toBe("timed_out");
        } finally {
            endMigration();
            __resetOffThreadMigrationClockForTests();
        }
    });

    test("plugin hook initialization resolves when the boot dependency never settles", async () => {
        const messages: string[] = [];

        const result = await runBootPhaseWithDeadline(
            "hooks",
            () => new Promise<never>(() => {}),
            20,
            (message) => messages.push(message),
        );

        expect(result.status).toBe("timed_out");
        expect(messages).toEqual([
            "[magic-context] boot phase 'hooks' exceeded its 20ms deadline; host startup will continue with Magic Context fail-closed",
        ]);
    });

    test("a phase that merely runs long hands its late value to the caller", async () => {
        // The contended-migration-lock shape: the open outlives the deadline but
        // succeeds. The caller must be able to adopt that value, otherwise a slow
        // box turns into a process-lifetime fail-closed session.
        useBootClock();
        const hooks = Promise.withResolvers<string>();
        let returned = false;
        const boot = runBootPhaseWithDeadline(
            "hooks",
            () => hooks.promise,
            10,
            () => {},
        );

        void boot.then(() => {
            returned = true;
        });
        jest.advanceTimersByTime(9);
        await flushBoot();
        expect(returned).toBe(false);
        jest.advanceTimersByTime(1);
        await flushBoot();
        expect(returned).toBe(true);
        const result = await boot;
        expect(result.status).toBe("timed_out");
        if (result.status !== "timed_out") return;
        hooks.resolve("real hooks");
        expect(await result.pending).toBe("real hooks");
    });

    test("one boot budget bounds consecutive phases by the original deadline", async () => {
        const messages: string[] = [];
        // Model a first phase consuming 25ms without asking the scheduler to sleep.
        const budget = createBootBudget(45, performance.now() - 45);
        expect(remainingBootBudgetMs(budget, budget.startedAt + 25)).toBe(20);
        expect(remainingBootBudgetMs(budget, budget.deadlineAt)).toBe(0);

        let hooksStarted = false;
        const result = await runBootPhaseWithinBudget(
            budget,
            "hooks",
            () => {
                hooksStarted = true;
                return new Promise<never>(() => {});
            },
            (message) => messages.push(message),
        );

        expect(result.status).toBe("timed_out");
        expect(result.elapsedMs).toBe(0);
        expect(hooksStarted).toBe(false);
        expect(messages[0]).toContain("whole-server 45ms budget");
        expect(messages[0]).toContain("phase 'hooks'");
    });

    test("an exhausted whole-server budget returns before a synchronous late-recovery prefix", async () => {
        const budget = createBootBudget(0);
        let invoked = false;
        const result = await runBootPhaseWithinBudget(
            budget,
            "hooks",
            async () => {
                invoked = true;
                return "late hooks";
            },
            () => {},
        );

        expect(result.status).toBe("timed_out");
        expect(invoked).toBe(false);
        if (result.status === "timed_out") await expect(result.pending).resolves.toBe("late hooks");
    });

    test("returns a completed phase value and timing", async () => {
        const result = await runBootPhaseWithDeadline(
            "rpc",
            async () => 42,
            100,
            () => {},
        );

        expect(result.status).toBe("completed");
        if (result.status === "completed") expect(result.value).toBe(42);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    test("flushes the entering breadcrumb with the real process and directory values", () => {
        const events: string[] = [];

        emitBootEnteringBreadcrumb(
            4312,
            "/work/incident-checkout",
            (message) => events.push(`report:${message}`),
            () => events.push("flush"),
        );

        expect(events).toEqual([
            "report:[magic-context] boot: entering pid=4312 dir=/work/incident-checkout",
            "flush",
        ]);
    });

    test("phase diagnostics distinguish elapsed work and the exhausted phase", () => {
        const quiet = formatBootPhaseDiagnostics({
            configMs: 0,
            conflictMs: 0,
            guardMs: 0,
            openMs: 0,
            migrateMs: 0,
            hooksMs: 0,
            rpcMs: 0,
            postMs: 0,
            totalMs: 0,
            budgetMs: 15_000,
            deadlinePhase: null,
        });
        const exhausted = formatBootPhaseDiagnostics({
            configMs: 1.4,
            conflictMs: 2.5,
            guardMs: 3.6,
            openMs: 4.7,
            migrateMs: 5.8,
            hooksMs: 6.9,
            rpcMs: 7.1,
            postMs: 8.2,
            totalMs: 39.3,
            budgetMs: 15_000,
            deadlinePhase: "hooks",
        });

        expect(quiet).toBe(
            "[magic-context] boot phases: config=0ms conflict=0ms guard=0ms open=0ms migrate=0ms hooks=0ms rpc=0ms post=0ms total=0ms budget=15000ms deadline_phase=none",
        );
        expect(exhausted).toBe(
            "[magic-context] boot phases: config=1ms conflict=3ms guard=4ms open=5ms migrate=6ms hooks=7ms rpc=7ms post=8ms total=39ms budget=15000ms deadline_phase=hooks",
        );
        expect(exhausted).not.toBe(quiet);
    });
});
