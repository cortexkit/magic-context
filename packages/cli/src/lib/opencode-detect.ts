import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath, isExecutableFile } from "./find-on-path";

/** Where a detectable OpenCode installation was found. */
export type OpenCodeInstallSource =
    | "PATH"
    | "home-bin"
    | "openchamber"
    | "desktop"
    | "desktop-cli"
    | "app";

/** A single OpenCode installation found by the filesystem detection ladder. */
export interface OpenCodeInstallation {
    /** The canonical path used for display and, for CLI installs, execution. */
    path: string;
    source: OpenCodeInstallSource;
    kind: "cli" | "desktop";
}

/**
 * How OpenCode is present on this machine.
 *
 * - `cli`: a runnable `opencode` binary exists (stock install, PATH, a
 *   version-manager / package-manager shim, or the `opencode-cli` sidecar that
 *   OpenCode Desktop downloads under its userData directory). `opencode models`
 *   / `opencode --version` work.
 * - `desktop`: only the OpenCode Desktop app is installed, without a runnable
 *   bundled sidecar CLI. The Desktop GUI still counts as an install, so setup
 *   must degrade to manual model entry rather than claim OpenCode is absent
 *   (issue #196).
 * - `none`: no sign of OpenCode at all.
 *
 * `detectOpenCodeInstallations` exposes every rung. `detectOpenCode` below keeps
 *   the original single-install API by returning the first (active) rung.
 */
export type OpenCodeDetection =
    | { kind: "cli"; binary: string }
    | { kind: "desktop"; marker: string }
    | { kind: "none" };

// Electron userData appIds the Desktop app uses per release channel. The
// settings file under any of these is the most reliable "Desktop has run"
// marker (the GUI app path is a weaker "installed but maybe never run" signal).
export const OPENCODE_DESKTOP_APP_IDS = [
    "ai.opencode.desktop",
    "ai.opencode.desktop.beta",
    "ai.opencode.desktop.dev",
] as const;

// electron-store settings file Desktop writes into its userData dir.
const OPENCODE_DESKTOP_SETTINGS_FILE = "opencode.settings";

/**
 * Injectable seams so detection is hermetically testable (no host filesystem,
 * no real `$HOME`). Defaults bind to the real OS at call time.
 */
export interface DetectDeps {
    exists: (path: string) => boolean;
    isExecutable: (path: string) => boolean;
    /** Directory listing, used to find the versioned Desktop sidecar CLI. */
    readdir: (path: string) => string[];
    home: string;
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    /** PATH lookup for a bare `opencode` (the host PATH walk). */
    onPath: (binary: string) => string | null;
    /** Optional realpath function, injectable for tests, used to deduplicate installations that are symlink aliases. */
    realpath?: (path: string) => string;
}

function defaultDeps(overrides: Partial<DetectDeps> = {}): DetectDeps {
    // Resolve each default lazily so a fully injected caller never reads the
    // host environment while constructing a virtual detection filesystem.
    const env = overrides.env ?? process.env;
    return {
        exists: overrides.exists ?? existsSync,
        isExecutable: overrides.isExecutable ?? isExecutableFile,
        readdir: overrides.readdir ?? ((path) => readdirSync(path)),
        home: overrides.home ?? (env.HOME?.trim() || homedir()),
        platform: overrides.platform ?? process.platform,
        env,
        onPath: overrides.onPath ?? findOnPath,
        realpath: overrides.realpath,
    };
}

/** Stock OpenCode CLI location (~/.opencode/bin), OS-specific binary name. */
function stockCliBinary(d: DetectDeps): string {
    return d.platform === "win32"
        ? join(d.home, ".opencode", "bin", "opencode.exe")
        : join(d.home, ".opencode", "bin", "opencode");
}

/** Extra absolute CLI locations beyond stock-bin + PATH, per OS. */
function extraCliCandidates(d: DetectDeps): string[] {
    if (d.platform === "win32") {
        const appdata = d.env.APPDATA ?? "";
        const localappdata = d.env.LOCALAPPDATA ?? "";
        const userprofile = d.env.USERPROFILE ?? d.home;
        const out: string[] = [];
        if (appdata) {
            out.push(join(appdata, "npm", "opencode.cmd"));
            out.push(join(appdata, "npm", "opencode.exe"));
        }
        if (localappdata) {
            out.push(join(localappdata, "Microsoft", "WinGet", "Links", "opencode.exe"));
            out.push(join(localappdata, "opencode", "bin", "opencode.exe"));
        }
        if (userprofile) {
            out.push(join(userprofile, "scoop", "shims", "opencode.exe"));
        }
        return out;
    }
    return [
        "/usr/local/bin/opencode",
        "/opt/homebrew/bin/opencode",
        join(d.home, ".local", "bin", "opencode"),
        join(d.home, ".local", "share", "mise", "shims", "opencode"),
        join(d.home, ".asdf", "shims", "opencode"),
        join(d.home, ".volta", "bin", "opencode"),
    ];
}

/**
 * The OpenCode CLI bundled inside the OpenChamber app (macOS). OpenChamber runs
 * this binary as its OpenCode server, so it is a real, runnable install even
 * when no `opencode` is on PATH.
 */
function openChamberCliCandidates(d: DetectDeps): string[] {
    if (d.platform !== "darwin") return [];
    const bundled = ["Contents", "Resources", "opencode-cli", "opencode"];
    return [
        join("/Applications", "OpenChamber.app", ...bundled),
        join(d.home, "Applications", "OpenChamber.app", ...bundled),
    ];
}

function canonicalPath(d: DetectDeps, path: string): string {
    try {
        return d.realpath ? d.realpath(path) : realpathSync(path);
    } catch {
        // A virtual test path or a path that disappeared between the probe and
        // realpath lookup is still useful to report; retain its resolved spelling.
        return path;
    }
}

/** Add a candidate once, using its real path to collapse symlink aliases. */
function addCandidate(
    installations: OpenCodeInstallation[],
    seenRealpaths: Set<string>,
    d: DetectDeps,
    candidate: string,
    source: OpenCodeInstallSource,
    kind: OpenCodeInstallation["kind"],
): void {
    const path = canonicalPath(d, candidate);
    if (seenRealpaths.has(path)) return;
    seenRealpaths.add(path);
    installations.push({ path, source, kind });
}

/** XDG-aware config base used for the Linux Desktop userData location. */
function xdgConfigHome(d: DetectDeps): string {
    const xdg = d.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
    return join(d.home, ".config");
}

/** Per-OS Electron userData dir for a given Desktop appId. */
function desktopUserDataDir(d: DetectDeps, appId: string): string {
    switch (d.platform) {
        case "darwin":
            return join(d.home, "Library", "Application Support", appId);
        case "win32":
            return join(d.env.APPDATA ?? join(d.home, "AppData", "Roaming"), appId);
        default:
            return join(xdgConfigHome(d), appId);
    }
}

/** Per-OS GUI app install paths (secondary "installed but maybe never run"). */
function desktopAppPaths(d: DetectDeps): string[] {
    switch (d.platform) {
        case "darwin":
            return ["/Applications/OpenCode.app", join(d.home, "Applications", "OpenCode.app")];
        case "win32": {
            const localappdata = d.env.LOCALAPPDATA ?? join(d.home, "AppData", "Local");
            return [join(localappdata, "Programs", "OpenCode", "OpenCode.exe")];
        }
        default: {
            const dataHome =
                d.env.XDG_DATA_HOME && d.env.XDG_DATA_HOME.length > 0
                    ? d.env.XDG_DATA_HOME
                    : join(d.home, ".local", "share");
            return OPENCODE_DESKTOP_APP_IDS.map((appId) =>
                join(dataHome, "applications", `${appId}.desktop`),
            );
        }
    }
}

/**
 * The `opencode-cli` sidecar that OpenCode Desktop downloads under its
 * per-channel userData directory (`<userData>/cli/<version>-<arch>/`). Recent
 * Desktop releases ship a runnable CLI there even when no `opencode` binary is
 * on PATH; probing it lets setup and doctor enumerate the models of the host
 * the user is actually running instead of degrading to manual entry.
 *
 * Newest version first, so a stale sidecar left behind by an upgrade is never
 * preferred over the one the current Desktop release downloaded.
 */
function desktopBundledCliCandidates(d: DetectDeps): string[] {
    const binary = d.platform === "win32" ? "opencode-cli.exe" : "opencode-cli";
    const candidates: string[] = [];
    for (const appId of OPENCODE_DESKTOP_APP_IDS) {
        const cliRoot = join(desktopUserDataDir(d, appId), "cli");
        let entries: string[];
        try {
            entries = d.readdir(cliRoot);
        } catch {
            continue;
        }
        const newestFirst = entries
            .slice()
            .sort((a, b) => b.localeCompare(a, "en", { numeric: true, sensitivity: "base" }));
        for (const entry of newestFirst) {
            const candidate = join(cliRoot, entry, binary);
            if (d.isExecutable(candidate)) candidates.push(candidate);
        }
    }
    return candidates;
}

/** The Desktop "has run" settings markers across all release channels. */
export function openCodeDesktopSettingsMarkers(deps?: Partial<DetectDeps>): string[] {
    const d = defaultDeps(deps);
    return OPENCODE_DESKTOP_APP_IDS.map((appId) =>
        join(desktopUserDataDir(d, appId), OPENCODE_DESKTOP_SETTINGS_FILE),
    );
}

/**
 * Enumerate every detectable OpenCode installation.
 *
 * This intentionally keeps the existing probes and their priority: the
 * resolved PATH binary is the active install, followed by the stock home-bin
 * binary, other known CLI locations, the CLI bundled in OpenChamber, the CLI
 * sidecar bundled in OpenCode Desktop, Desktop userData markers, and GUI app
 * paths. Pure filesystem checks (no exec) keep this safe in restricted shells.
 * Pass `deps` to test against a virtual filesystem.
 */
export function detectOpenCodeInstallations(deps?: Partial<DetectDeps>): OpenCodeInstallation[] {
    const d = defaultDeps(deps);
    const installations: OpenCodeInstallation[] = [];
    const seenRealpaths = new Set<string>();

    // PATH is deliberately first: this is the binary a shell and the plugin
    // registration workflow resolve when more than one install is present.
    const onPath = d.onPath("opencode");
    if (onPath && d.isExecutable(onPath)) {
        addCandidate(installations, seenRealpaths, d, onPath, "PATH", "cli");
    }

    const stockBin = stockCliBinary(d);
    if (d.isExecutable(stockBin)) {
        addCandidate(installations, seenRealpaths, d, stockBin, "home-bin", "cli");
    }

    for (const candidate of extraCliCandidates(d)) {
        if (d.isExecutable(candidate)) {
            addCandidate(installations, seenRealpaths, d, candidate, "PATH", "cli");
        }
    }

    for (const candidate of openChamberCliCandidates(d)) {
        if (d.isExecutable(candidate)) {
            addCandidate(installations, seenRealpaths, d, candidate, "openchamber", "cli");
        }
    }

    for (const candidate of desktopBundledCliCandidates(d)) {
        addCandidate(installations, seenRealpaths, d, candidate, "desktop-cli", "cli");
    }

    for (const appId of OPENCODE_DESKTOP_APP_IDS) {
        const marker = join(desktopUserDataDir(d, appId), OPENCODE_DESKTOP_SETTINGS_FILE);
        if (d.exists(marker)) {
            addCandidate(installations, seenRealpaths, d, marker, "desktop", "desktop");
        }
    }
    for (const appPath of desktopAppPaths(d)) {
        if (d.exists(appPath)) {
            addCandidate(installations, seenRealpaths, d, appPath, "app", "desktop");
        }
    }

    return installations;
}

/**
 * Return the first detected installation in the original single-installation
 * shape so existing callers continue to use the installation selected for checks.
 */
export function detectOpenCode(deps?: Partial<DetectDeps>): OpenCodeDetection {
    const active = detectOpenCodeInstallations(deps)[0];
    if (!active) return { kind: "none" };
    return active.kind === "cli"
        ? { kind: "cli", binary: active.path }
        : { kind: "desktop", marker: active.path };
}
