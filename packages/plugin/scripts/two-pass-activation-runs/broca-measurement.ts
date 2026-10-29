import { SubcClient } from "@cortexkit/subc-client";
import { randomUUID } from "node:crypto";
import { attestHost } from "../two-pass-live-replay/host-drivers";
import { underRoot } from "./activation-driver";
import type { BrocaMeasurementRoute } from "./measurement-transports";

/** Probe exactly one isolated runner session without admitting an inference send. */
export function brocaMeasurementRoute(options: {
    connectionFile: string;
    runnerPid: number;
    observed(value: { sessionId: string; status: "unobservable"; reason: string; description?: unknown }): void;
}): BrocaMeasurementRoute {
    return {
        async open(input) {
            const connectionFile = underRoot(input.root, options.connectionFile);
            await attestHost(input.root, input.env, options.runnerPid);
            const client = await SubcClient.connect({ connectionFile });
            const sessionId = `cache-measurement-${randomUUID()}`;
            let route: Awaited<ReturnType<typeof client.routeOpen>> | undefined;
            try {
                route = await client.routeOpen({ kind: "management_surface", module_id: "broca" },
                    { project_root: input.root, harness: "two-pass-cache-measurement", session: sessionId });
                const description = await client.request(route, { method: "role.describe", params: {} }, { timeoutMs: 10_000 });
                // This probe does not send or inspect a two-turn assistant history. Retention
                // flags alone cannot establish which message bytes would reach the provider.
                options.observed({ sessionId, status: "unobservable", description,
                    reason: "Pinned SubcClient lacks runner role-version declarations and no raw-history measurement wire contract is available. No session.send was dispatched; use the first-party fallback." });
                return null;
            } finally {
                if (route) await client.closeRoute(route);
                client.close();
            }
        },
    };
}
