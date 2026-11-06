import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    __resetNotificationStateForTests,
    drainNotifications,
} from "../../shared/rpc-notifications";
import { startUpdateChecks } from "./update-check";

// The notification queue is process-wide; other test files in the same run leave toasts in it.
beforeEach(() => __resetNotificationStateForTests());
afterEach(() => __resetNotificationStateForTests());

function oneEventContext() {
    return {
        event: {
            subscribe: async function* ({ signal }: { signal: AbortSignal }) {
                if (!signal.aborted) yield {};
            },
        },
        storage: { get: async () => undefined, set: async () => {} },
    };
}

describe("OpenCode 2 update notice", () => {
    it("rechecks storage at expiry before starting another host's duplicate check", async () => {
        const originalNow = Date.now;
        let now = 1_800_000_000_000;
        let stored: unknown;
        let gets = 0;
        let sets = 0;
        let checks = 0;
        Date.now = () => now;
        try {
            const context = {
                event: {
                    subscribe: async function* () {
                        yield {};
                        now += 60 * 60 * 1000;
                        stored = now; // A different host has just checked the registry.
                        yield {};
                        yield {};
                    },
                },
                storage: {
                    get: async () => {
                        gets++;
                        return stored;
                    },
                    set: async (_key: string, value: unknown) => {
                        sets++;
                        stored = value;
                    },
                },
            };
            await startUpdateChecks(context, async () => {
                checks++;
                return null;
            }).done;
            expect(gets).toBe(2);
            expect(sets).toBe(1);
            expect(checks).toBe(1);
        } finally {
            Date.now = originalNow;
        }
    });

    it("reads the persisted throttle once for an hourly burst of host events", async () => {
        let gets = 0;
        let checks = 0;
        let sets = 0;
        const context = {
            event: {
                subscribe: async function* () {
                    for (let i = 0; i < 1000; i++) yield {};
                },
            },
            storage: {
                get: async () => {
                    gets++;
                    return undefined;
                },
                set: async () => {
                    sets++;
                },
            },
        };
        await startUpdateChecks(context, async () => {
            checks++;
            return null;
        }).done;
        expect(gets).toBe(1);
        expect(sets).toBe(1);
        expect(checks).toBe(1);
    });

    it("points the user at OpenCode's own plugin update instead of an automatic update", async () => {
        const checks = startUpdateChecks(
            oneEventContext() as unknown as Parameters<typeof startUpdateChecks>[0],
            async () => "999.0.0",
        );
        await checks.done;
        const toasts = drainNotifications().filter((notification) => notification.type === "toast");
        expect(toasts).toHaveLength(1);
        const message = String(toasts[0]?.payload.message);
        expect(message).toContain("Magic Context 999.0.0 is available");
        // OpenCode 2 installs a new `@latest` release only when asked: the
        // plugins dialog's update action (ctrl+u) or `opencode plugin update`.
        // Its ctrl+r only re-checks, so the notice must not send users there.
        expect(message).toContain("/plugins");
        expect(message).toContain("ctrl+u");
        expect(message).toContain("`opencode plugin update`");
        expect(message).not.toContain("ctrl+r");
    });

    it("stays quiet when the registry has nothing newer", async () => {
        const checks = startUpdateChecks(
            oneEventContext() as unknown as Parameters<typeof startUpdateChecks>[0],
            async () => "0.0.1",
        );
        await checks.done;
        expect(drainNotifications().filter((n) => n.type === "toast")).toHaveLength(0);
    });
});
