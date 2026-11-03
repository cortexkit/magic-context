#!/usr/bin/env node

/**
 * version-sync.mjs
 *
 * Synchronizes package.json and Cargo.toml versions from a git tag or explicit argument.
 * The plugin packages and all Rust workspace members share each release version.
 *
 * Usage:
 *   node scripts/version-sync.mjs 0.1.0           # set version to 0.1.0
 *   node scripts/version-sync.mjs --from-tag       # read from GITHUB_REF_NAME (e.g. v0.1.0)
 *   node scripts/version-sync.mjs 0.1.0 --dry-run  # preview changes without writing
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const PACKAGES = [
    join(repoRoot, "packages", "plugin"),
    join(repoRoot, "packages", "pi-plugin"),
    join(repoRoot, "packages", "cli"),
];
const CARGO_MANIFESTS = JSON.parse(execFileSync("python3", [join(__dirname, "workspace_crates.py")], { encoding: "utf-8" }));
const CARGO_CRATES = Object.values(CARGO_MANIFESTS);
const CARGO_LOCK_PATH = join(repoRoot, "Cargo.lock");

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/;

function parseArgs(argv) {
    const args = argv.slice(2);
    let version = null;
    let fromTag = false;
    let dryRun = false;

    for (const arg of args) {
        if (arg === "--from-tag") {
            fromTag = true;
        } else if (arg === "--dry-run") {
            dryRun = true;
        } else if (!version && !arg.startsWith("-")) {
            version = arg;
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(1);
        }
    }

    if (fromTag) {
        const ref = process.env.GITHUB_REF_NAME;
        if (!ref) {
            console.error("--from-tag requires GITHUB_REF_NAME environment variable");
            process.exit(1);
        }
        version = ref.replace(/^v/, "");
    }

    if (!version) {
        console.error(
            "Usage: version-sync.mjs <version> [--dry-run]\n" +
                "       version-sync.mjs --from-tag [--dry-run]",
        );
        process.exit(1);
    }

    if (!SEMVER_RE.test(version)) {
        console.error(`Invalid semver version: '${version}'`);
        process.exit(1);
    }

    return { version, dryRun };
}

const { version, dryRun } = parseArgs(process.argv);

console.log(`${dryRun ? "[DRY RUN] " : ""}Syncing version to ${version}\n`);

for (const pkgDir of PACKAGES) {
    const pkgPath = join(pkgDir, "package.json");
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content);
    const label = pkgDir.replace(repoRoot + "/", "");

    // Detect existing indent style so version bumps don't reformat the
    // entire file. Tabs vs 2-space differ across our packages and we
    // want to preserve whatever each owner picked.
    const indent = detectIndent(content);

    if (pkg.version === version) {
        console.log(`${label}/package.json: (already at target version)`);
    } else {
        console.log(`${label}/package.json: ${pkg.version} → ${version}`);
        pkg.version = version;
        if (!dryRun) {
            writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}\n`, "utf-8");
        }
    }
}

for (const manifest of Object.keys(CARGO_MANIFESTS)) {
    const manifestPath = join(repoRoot, manifest);
    const content = readFileSync(manifestPath, "utf-8");
    const updated = setCargoManifestVersion(content, version, manifestPath);
    reportChange(manifest, content, updated);
}

const cargoLock = readFileSync(CARGO_LOCK_PATH, "utf-8");
const updatedCargoLock = setCargoLockVersions(cargoLock, version, CARGO_CRATES);
reportChange("Cargo.lock", cargoLock, updatedCargoLock);

function reportChange(label, before, after) {
    if (before === after) {
        console.log(`${label}: (already at target version)`);
        return;
    }
    console.log(`${label}: workspace crate versions → ${version}`);
    if (!dryRun) {
        writeFileSync(join(repoRoot, label), after, "utf-8");
    }
}

function setCargoManifestVersion(content, targetVersion, path) {
    const packageStart = content.search(/^\[package\][ \t]*\r?$/m);
    if (packageStart < 0) {
        throw new Error(`${path} has no [package] section`);
    }
    const packageBodyStart = content.indexOf("\n", packageStart) + 1;
    const remaining = content.slice(packageBodyStart);
    const nextSection = remaining.search(/^\[[^\]\r\n]+\][ \t]*\r?$/m);
    const packageBodyEnd = nextSection < 0 ? content.length : packageBodyStart + nextSection;
    const packageBody = content.slice(packageBodyStart, packageBodyEnd);
    const versionLine = /^([ \t]*version[ \t]*=[ \t]*")[^"]+("[^\r\n]*)$/m;
    const matches = packageBody.match(versionLine);
    if (!matches) {
        throw new Error(`${path} has no version in its [package] section`);
    }
    const updatedBody = packageBody.replace(versionLine, `$1${targetVersion}$2`);
    return content.slice(0, packageBodyStart) + updatedBody + content.slice(packageBodyEnd);
}

function setCargoLockVersions(content, targetVersion, crateNames) {
    const blocks = content.split(/(?=^\[\[package\]\][ \t]*\r?$)/m);
    const found = new Map(crateNames.map((name) => [name, 0]));
    const updated = blocks.map((block) => {
        const nameMatch = block.match(/^name = "([^"]+)"[ \t]*\r?$/m);
        if (!nameMatch || !found.has(nameMatch[1])) return block;
        const name = nameMatch[1];
        found.set(name, found.get(name) + 1);
        const versionLine = /^([ \t]*version[ \t]*=[ \t]*")[^"]+("[^\r\n]*)$/m;
        if (!versionLine.test(block)) {
            throw new Error(`Cargo.lock package ${name} has no version`);
        }
        return block.replace(versionLine, `$1${targetVersion}$2`);
    });
    const missing = [...found].filter(([, count]) => count !== 1).map(([name, count]) => `${name} (${count} entries)`);
    if (missing.length > 0) {
        throw new Error(`Cargo.lock must contain each workspace crate exactly once: ${missing.join(", ")}`);
    }
    return updated.join("");
}

/** Detect whether the JSON file is indented with tabs or N-space indent. */
function detectIndent(text) {
    const m = text.match(/^\{\r?\n([ \t]+)"/);
    if (!m) return 2;
    const lead = m[1];
    if (lead.startsWith("\t")) return "\t";
    return lead.length || 2;
}

console.log(`\n${dryRun ? "[DRY RUN] " : ""}Done.`);
