import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "comment-json";

let overrideAvailability: boolean | null = null;

export interface AftAvailability {
    available: boolean;
    opencode: boolean;
    pi: boolean;
    checkedPaths: string[];
}

function parseConfig(path: string): unknown {
    if (!existsSync(path)) return null;
    return parse(readFileSync(path, "utf-8"));
}

function entryMatchesAft(entry: unknown): boolean {
    const value = Array.isArray(entry) ? entry[0] : entry;
    return (
        typeof value === "string" &&
        (value.includes("@cortexkit/aft") ||
            value.includes("aft-opencode") ||
            value.includes("aft-pi"))
    );
}

function hasAftInArray(value: unknown): boolean {
    return Array.isArray(value) && value.some(entryMatchesAft);
}

function hasAftAtKeys(value: unknown, keys: string[]): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        if (hasAftInArray(record[key])) return true;
    }
    return false;
}

export function getAftAvailability(): AftAvailability {
    const home = process.env.HOME || homedir();
    const opencodePaths = [
        join(home, ".config", "opencode", "opencode.jsonc"),
        join(home, ".config", "opencode", "opencode.json"),
    ];
    const piPaths = [join(home, ".pi", "agent", "settings.json")];
    const checkedPaths = [...opencodePaths, ...piPaths];

    let opencode = false;
    for (const path of opencodePaths) {
        try {
            const config = parseConfig(path);
            if (hasAftAtKeys(config, ["plugin", "plugins", "mcp", "mcp_servers"])) {
                opencode = true;
                break;
            }
        } catch {
            // Malformed config is treated as unavailable; doctor reports parse errors separately.
        }
    }

    let pi = false;
    for (const path of piPaths) {
        try {
            const config = parseConfig(path);
            if (hasAftAtKeys(config, ["packages", "extensions"])) {
                pi = true;
                break;
            }
            const agent = (config as Record<string, unknown> | null)?.agent;
            if (hasAftAtKeys(agent, ["packages", "extensions"])) {
                pi = true;
                break;
            }
        } catch {
            // Malformed config is treated as unavailable; doctor reports parse errors separately.
        }
    }

    const detected = opencode || pi;
    return {
        available: overrideAvailability ?? detected,
        opencode,
        pi,
        checkedPaths,
    };
}

export function isAftAvailable(): boolean {
    return getAftAvailability().available;
}

/** Test-only override for deterministic key-files unit tests. */
export function setAftAvailabilityOverride(value: boolean | null): void {
    overrideAvailability = value;
}
