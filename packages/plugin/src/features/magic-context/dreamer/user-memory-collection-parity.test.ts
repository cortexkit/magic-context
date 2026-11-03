import { expect, test } from "bun:test";
import parity from "../../../../test-fixtures/runtime/user-memory-collection-parity.json";
import { parsePluginConfig } from "../../../config";
import { userObservationCollectionEnabled, userObservationsRequested } from "./task-config";

// The Rust module reads the same cases (config.rs tests), so a Rust-mode
// historian collects user observations for exactly the configs the plugin does.
test("user-observation collection matches the Rust module for unset, empty and set schedules", () => {
    expect(parity.cases).toHaveLength(7);
    for (const entry of parity.cases) {
        const config = parsePluginConfig(entry.user as Record<string, unknown>);
        expect({
            label: entry.label,
            collect: userObservationCollectionEnabled(config.dreamer),
        }).toEqual({
            label: entry.label,
            collect: entry.collect,
        });
        expect({
            label: entry.label,
            requested: userObservationsRequested(config.dreamer),
        }).toEqual({
            label: entry.label,
            requested: entry.requested,
        });
    }
});
