import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseJsonc } from "comment-json";

import { log } from "../../shared/logger";
import { getCurrentRuntimePackageJsonPath } from "./checker";
import { CACHE_DIR, PACKAGE_NAME } from "./constants";
import { PackageJsonSchema } from "./types";

interface BunLockfile {
    workspaces?: {
        ""?: {
            dependencies?: Record<string, string>;
        };
    };
    packages?: Record<string, unknown>;
}

interface AutoUpdateInstallContext {
    installDir: string;
    packageJsonPath: string;
}

function warn(message: string): void {
    log(`WARN: ${message}`);
}

function stripPackageNameFromPath(pathValue: string, packageName: string): string | null {
    let current = pathValue;
    for (const segment of [...packageName.split("/")].reverse()) {
        if (basename(current) !== segment) return null;
        current = dirname(current);
    }
    return current;
}

function removeFromBunLock(installDir: string, packageName: string): boolean {
    const lockPath = join(installDir, "bun.lock");
    if (!existsSync(lockPath)) return false;

    try {
        const lock = parseJsonc(readFileSync(lockPath, "utf-8")) as BunLockfile;
        let modified = false;

        if (lock.workspaces?.[""]?.dependencies?.[packageName]) {
            delete lock.workspaces[""].dependencies[packageName];
            modified = true;
        }

        if (lock.packages?.[packageName]) {
            delete lock.packages[packageName];
            modified = true;
        }

        if (modified) {
            writeFileSync(lockPath, JSON.stringify(lock, null, 2));
            log(`[auto-update-checker] Removed from bun.lock: ${packageName}`);
        }

        return modified;
    } catch {
        return false;
    }
}

function ensureDependencyVersion(
    packageJsonPath: string,
    packageName: string,
    version: string,
): boolean {
    if (!existsSync(packageJsonPath)) return false;

    try {
        const raw = parseJsonc(readFileSync(packageJsonPath, "utf-8"));
        const pkgJson = PackageJsonSchema.safeParse(raw);
        if (!pkgJson.success) return false;

        const nextPackageJson = { ...pkgJson.data };
        const dependencies = { ...(nextPackageJson.dependencies ?? {}) };
        if (dependencies[packageName] === version) return true;

        dependencies[packageName] = version;
        nextPackageJson.dependencies = dependencies;
        writeFileSync(packageJsonPath, JSON.stringify(nextPackageJson, null, 2));
        log(
            `[auto-update-checker] Updated dependency in package.json: ${packageName} → ${version}`,
        );
        return true;
    } catch (err) {
        warn(`[auto-update-checker] Failed to update package.json dependency: ${String(err)}`);
        return false;
    }
}

function removeInstalledPackage(installDir: string, packageName: string): boolean {
    const packageDir = join(installDir, "node_modules", packageName);
    if (!existsSync(packageDir)) return false;

    rmSync(packageDir, { recursive: true, force: true });
    log(`[auto-update-checker] Package removed: ${packageDir}`);
    return true;
}

export function resolveInstallContext(
    runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): AutoUpdateInstallContext | null {
    if (runtimePackageJsonPath) {
        const packageDir = dirname(runtimePackageJsonPath);
        const nodeModulesDir = stripPackageNameFromPath(packageDir, PACKAGE_NAME);

        if (nodeModulesDir && basename(nodeModulesDir) === "node_modules") {
            const installDir = dirname(nodeModulesDir);
            const packageJsonPath = join(installDir, "package.json");
            if (existsSync(packageJsonPath)) return { installDir, packageJsonPath };
        }

        return null;
    }

    const legacyPackageJsonPath = join(dirname(CACHE_DIR), "package.json");
    if (existsSync(legacyPackageJsonPath)) {
        return { installDir: dirname(CACHE_DIR), packageJsonPath: legacyPackageJsonPath };
    }

    return null;
}

export function preparePackageUpdate(
    version: string,
    packageName: string = PACKAGE_NAME,
    runtimePackageJsonPath: string | null = getCurrentRuntimePackageJsonPath(),
): string | null {
    try {
        const installContext = resolveInstallContext(runtimePackageJsonPath);
        if (!installContext) {
            warn("[auto-update-checker] No install context found for auto-update");
            return null;
        }

        if (!ensureDependencyVersion(installContext.packageJsonPath, packageName, version))
            return null;

        const packageRemoved = removeInstalledPackage(installContext.installDir, packageName);
        const lockRemoved = removeFromBunLock(installContext.installDir, packageName);

        if (!packageRemoved && !lockRemoved) {
            log(
                `[auto-update-checker] No cached package artifacts removed for ${packageName}; continuing with updated dependency spec`,
            );
        }

        return installContext.installDir;
    } catch (err) {
        warn(`[auto-update-checker] Failed to prepare package update: ${String(err)}`);
        return null;
    }
}

export async function runBunInstallSafe(
    installDir: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    try {
        if (options.signal?.aborted) return false;
        const proc = spawn("bun", ["install"], {
            cwd: installDir,
            stdio: "pipe",
        });

        const abortProcess = () => {
            try {
                proc.kill();
            } catch {
                // best-effort
            }
        };
        options.signal?.addEventListener("abort", abortProcess, { once: true });

        const exitPromise = new Promise<boolean>((resolveExit) => {
            proc.on("error", () => resolveExit(false));
            proc.on("exit", (code) => resolveExit(code === 0));
        });
        const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
            timeout = setTimeout(() => resolveTimeout("timeout"), options.timeoutMs ?? 60_000);
        });
        const result = await Promise.race([exitPromise, timeoutPromise]);
        options.signal?.removeEventListener("abort", abortProcess);

        if (result === "timeout" || options.signal?.aborted) {
            abortProcess();
            return false;
        }

        return result;
    } catch (err) {
        warn(`[auto-update-checker] bun install error: ${String(err)}`);
        return false;
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}
