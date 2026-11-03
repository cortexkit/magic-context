import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readHostEvents, stageEventObserver } from "./event-observer";

for (const lane of ["opencode-1", "opencode-2", "omp"] as const) {
    test(`${lane} event sidecar is read-only and masks credential material`, async () => {
        const parent = join(realpathSync(tmpdir()), "magic-context");
        mkdirSync(parent, { recursive: true });
        const root = mkdtempSync(join(parent, "event-sidecar-"));
        const observer = stageEventObserver(root, lane);
        const environment = process.env;
        process.env = { MC_HOST_EVENT_JSONL: observer.eventsPath, CLINE_API_KEY: "mock-observer-material" };
        const event = { type: "example", data: { password: "mock-password", text: "secret mock-observer-material" } };
        let cleanup = () => {};
        try {
            const plugin = (await import(pathToFileURL(observer.entrypoint).href)).default;
            if (lane === "opencode-1") await (await plugin.server()).event({ event });
            else if (lane === "opencode-2") cleanup = plugin.setup({ event: { async *subscribe() { yield event; } } });
            else {
                const handlers = new Map<string, (event: unknown) => void>();
                plugin({ on(name: string, handler: (event: unknown) => void) { handlers.set(name, handler); } });
                handlers.get("agent_end")!(event);
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
            const rows = readHostEvents(observer.eventsPath) as Array<{ event: unknown }>;
            expect(rows).toHaveLength(1);
            expect(rows[0].event).toEqual({ type: "example", data: { password: "[REDACTED]", text: "secret [REDACTED]" } });
            expect(event.data.password).toBe("mock-password");
        } finally { cleanup(); process.env = environment; rmSync(root, { recursive: true, force: true }); }
    });
}
