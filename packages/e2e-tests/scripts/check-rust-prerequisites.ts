#!/usr/bin/env bun

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface RustPrerequisiteOptions {
    repoRoot?: string;
    allowBuild?: boolean;
    /** Hermetic e2e builds ck-mc in its own Cargo target, so it needs source rather than a prebuilt binary. */
    requireCkMc?: boolean;
    env?: NodeJS.ProcessEnv;
}

export interface RustPrerequisiteResult {
    ok: boolean;
    missing: string[];
    ckMcBin?: string;
    commonsRoot?: string;
    subconsciousRoot?: string;
}

function isExecutable(path: string): boolean {
    try {
        return statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

function pathCommand(command: string, pathEnv: string | undefined): string | undefined {
    for (const directory of (pathEnv ?? "").split(":").filter(Boolean)) {
        const candidate = join(directory, command);
        if (isExecutable(candidate)) return candidate;
    }
    return undefined;
}

function cargoMetadata(cargo: string, repoRoot: string, env: NodeJS.ProcessEnv): boolean {
    const result = spawnSync(
        cargo,
        ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", join(repoRoot, "Cargo.toml")],
        { env, stdio: "ignore" },
    );
    return !result.error && result.status === 0;
}

function buildCkMc(cargo: string, repoRoot: string, env: NodeJS.ProcessEnv): boolean {
    const result = spawnSync(
        cargo,
        ["build", "--release", "-p", "mc-module", "--manifest-path", join(repoRoot, "Cargo.toml")],
        { cwd: repoRoot, env, stdio: "inherit" },
    );
    return !result.error && result.status === 0;
}

/**
 * Check the release-gate inputs without treating an unavailable Rust lane as a skip.
 * The optional PATH lookup makes the check testable with a fake ck-mc; the normal
 * workspace build still prefers target/release/ck-mc and can rebuild it in place.
 */
export function detectRustPrerequisites(options: RustPrerequisiteOptions = {}): RustPrerequisiteResult {
    const repoRoot = resolve(options.repoRoot ?? resolve(import.meta.dir, "../../.."));
    const env = options.env ?? process.env;
    const requireCkMc = options.requireCkMc ?? true;
    const missing: string[] = [];
    const cargo = pathCommand("cargo", env.PATH);
    const commonsRoot = resolve(repoRoot, "../commons");
    const subconsciousRoot = resolve(repoRoot, "../subconscious");

    if (!existsSync(join(repoRoot, "Cargo.toml"))) {
        missing.push(`cargo workspace: missing ${join(repoRoot, "Cargo.toml")}`);
    } else if (!cargo) {
        missing.push("cargo workspace: cargo is not available on PATH");
    } else if (!cargoMetadata(cargo, repoRoot, env)) {
        missing.push("cargo workspace: cargo metadata failed");
    }
    if (!existsSync(join(commonsRoot, "Cargo.toml"))) {
        missing.push(`sibling checkout: ../commons is missing (${join(commonsRoot, "Cargo.toml")})`);
    }
    if (!existsSync(join(subconsciousRoot, "Cargo.toml"))) {
        missing.push(
            `sibling checkout: ../subconscious is missing (${join(subconsciousRoot, "Cargo.toml")})`,
        );
    }

    let ckMcBin: string | undefined;
    if (requireCkMc) {
        const configuredCkMc = env.MC_E2E_CK_MC_BIN;
        ckMcBin = configuredCkMc && isExecutable(configuredCkMc) ? configuredCkMc : undefined;
        if (!ckMcBin) {
            const workspaceCkMc = join(repoRoot, "target/release/ck-mc");
            ckMcBin = isExecutable(workspaceCkMc) ? workspaceCkMc : pathCommand("ck-mc", env.PATH);
        }
        if (!ckMcBin && options.allowBuild && cargo && missing.length === 0) {
            if (buildCkMc(cargo, repoRoot, env)) {
                const workspaceCkMc = join(repoRoot, "target/release/ck-mc");
                if (isExecutable(workspaceCkMc)) ckMcBin = workspaceCkMc;
            }
        }
        if (!ckMcBin) {
            missing.push(
                "ck-mc binary: target/release/ck-mc is absent and no ck-mc executable was found on PATH",
            );
        }
    }

    return {
        ok: missing.length === 0,
        missing,
        ...(ckMcBin ? { ckMcBin } : {}),
        ...(existsSync(join(commonsRoot, "Cargo.toml")) ? { commonsRoot } : {}),
        ...(existsSync(join(subconsciousRoot, "Cargo.toml")) ? { subconsciousRoot } : {}),
    };
}

function parseArgs(args: string[]): { build: boolean; print: boolean; hermetic: boolean } {
    let build = false;
    let print = false;
    let hermetic = false;
    for (const arg of args) {
        if (arg === "--build") build = true;
        else if (arg === "--print") print = true;
        else if (arg === "--hermetic") hermetic = true;
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: check-rust-prerequisites.ts [--build] [--print] [--hermetic]");
            process.exit(0);
        } else throw new Error(`unknown argument: ${arg}`);
    }
    if (hermetic && (build || print)) {
        throw new Error("--hermetic cannot be combined with --build or --print");
    }
    return { build, print, hermetic };
}

if (import.meta.main) {
    try {
        const { build, print, hermetic } = parseArgs(Bun.argv.slice(2));
        const result = detectRustPrerequisites({ allowBuild: build, requireCkMc: !hermetic });
        if (!result.ok) {
            for (const reason of result.missing) console.error(`missing prerequisite: ${reason}`);
            process.exit(1);
        }
        if (print) console.log(result.ckMcBin);
        else if (hermetic) console.log("Hermetic Rust e2e source prerequisites resolved");
        else console.log("Rust e2e prerequisites resolved");
    } catch (error) {
        console.error(`Rust prerequisite detector failed: ${String(error)}`);
        process.exit(1);
    }
}
