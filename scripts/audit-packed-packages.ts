import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PACKAGES = [
    {
        name: "@cortexkit/opencode-magic-context",
        directory: join(REPO_ROOT, "packages/plugin"),
    },
    {
        name: "@cortexkit/pi-magic-context",
        directory: join(REPO_ROOT, "packages/pi-plugin"),
    },
    {
        name: "@cortexkit/magic-context",
        directory: join(REPO_ROOT, "packages/cli"),
    },
] as const;

type AuditVia = string | { url?: unknown; source?: unknown; title?: unknown; range?: unknown };

export type AuditReport = {
    metadata?: {
        vulnerabilities?: Partial<Record<"info" | "low" | "moderate" | "high" | "critical", number>>;
    };
    vulnerabilities?: Record<string, { severity?: string; via?: AuditVia[]; nodes?: string[] }>;
};

/**
 * High findings accepted for release, each limited to one advisory set and one
 * dependency path. Every other high or critical finding still fails the audit.
 *
 * toml <= 5.0.0: three CPU denial-of-service bugs in `toml.parse()` on crafted
 * input. It reaches users only through OpenCode's plugin package:
 * `@opencode-ai/plugin` -> `effect` -> `toml`. No published `@opencode-ai/plugin`
 * depends on a fixed `effect`, and npm overrides in our package do not apply to
 * the projects that install it. Magic Context never parses TOML. Remove this
 * entry once `@opencode-ai/plugin` depends on a fixed `effect`; the audit prints
 * a reminder when the entry no longer matches anything.
 *
 * zod < 4.6.6: oversized constrained collections can exhaust memory during
 * validation. Our packages require patched Zod, but @opencode-ai/plugin pins
 * 4.1.8. Accept only its nested copy and this advisory; remove the entry when
 * OpenCode updates the pin. A vulnerable direct or differently nested copy fails.
 *
 * effect < 4.0.0-beta.103: cookie attribute injection in Effect's HTTP cookie
 * helpers, rated moderate. `@opencode-ai/plugin` pins an affected beta, and that
 * copy is already rated high through `toml` above, so the audit refuses the
 * release until this advisory is listed too. Magic Context never calls Effect's
 * cookie code, and its own `effect` dependency is a later release candidate
 * outside the range. The entry accepts the advisory only at the range it was
 * published with: if the range is ever widened, it could reach our own copy,
 * and the audit fails again. Remove the entry when OpenCode updates the pin.
 */
export const ACCEPTED_ADVISORIES = [
    {
        vulnerablePackage: "toml",
        advisories: [
            "https://github.com/advisories/GHSA-4qx8-w7c3-pj3p",
            "https://github.com/advisories/GHSA-9j65-hcg3-gc64",
            "https://github.com/advisories/GHSA-9qmh-m7c6-f92p",
        ],
        // Packages allowed to be flagged only because they depend on the package above.
        dependentPath: ["effect", "@opencode-ai/plugin"],
    },
    {
        vulnerablePackage: "zod",
        advisories: ["https://github.com/advisories/GHSA-mrhx-c7xc-m3w5"],
        dependentPath: ["@opencode-ai/plugin"],
        vulnerableNodes: ["node_modules/@opencode-ai/plugin/node_modules/zod"],
    },
    {
        vulnerablePackage: "effect",
        advisories: ["https://github.com/advisories/GHSA-chp3-j5qr-2vfr"],
        advisoryRanges: [">=4.0.0-beta.0 <4.0.0-beta.103"],
        dependentPath: ["@opencode-ai/plugin"],
    },
] as const;

/**
 * Splits high and critical findings into accepted and refused. A finding is
 * accepted only when everything it is flagged for traces back to an accepted
 * advisory along that entry's dependency path. A new advisory on any package in
 * that path, including the root package itself, is refused.
 *
 * A package can be flagged for both reasons at once: its own listed advisory and
 * a dependency on another accepted package (`effect` carries its own advisory and
 * depends on `toml`). It is accepted only when both hold.
 */
export function classifyHighFindings(
    report: AuditReport,
    rootPackage: string,
): { accepted: string[]; refused: string[]; unusedExceptions: string[] } {
    const findings = report.vulnerabilities ?? {};
    const acceptedNames = new Set<string>();
    const usedExceptions = new Set<string>();
    const allowedEdges = new Map<string, Set<string>>();
    // Packages whose own advisories are all listed, but which are also flagged
    // through a dependency. The loop below accepts them once that dependency is.
    const ownAdvisoriesAccepted = new Set<string>();
    for (const entry of ACCEPTED_ADVISORIES) {
        const vulnerable = findings[entry.vulnerablePackage];
        if (!vulnerable) continue;
        const via = vulnerable.via ?? [];
        const ownAdvisories = via.filter((item) => typeof item !== "string");
        const onlyAccepted =
            ownAdvisories.length > 0 &&
            ownAdvisories.every(
                (item) =>
                    typeof item === "object" &&
                    item !== null &&
                    typeof item.url === "string" &&
                    (entry.advisories as readonly string[]).includes(item.url) &&
                    (!("advisoryRanges" in entry) ||
                        (typeof item.range === "string" &&
                            (entry.advisoryRanges as readonly string[]).includes(item.range))),
            );
        if (!onlyAccepted) continue;
        if ("vulnerableNodes" in entry) {
            const nodes = vulnerable.nodes ?? [];
            if (
                nodes.length === 0 ||
                !nodes.every((node) => (entry.vulnerableNodes as readonly string[]).includes(node))
            ) continue;
        }
        usedExceptions.add(entry.vulnerablePackage);
        if (ownAdvisories.length === via.length) acceptedNames.add(entry.vulnerablePackage);
        else ownAdvisoriesAccepted.add(entry.vulnerablePackage);
        let previous: string = entry.vulnerablePackage;
        for (const dependent of [...entry.dependentPath, rootPackage]) {
            const allowed = allowedEdges.get(dependent) ?? new Set<string>();
            allowed.add(previous);
            allowedEdges.set(dependent, allowed);
            previous = dependent;
        }
    }
    // A package can depend on both accepted chains. Resolve them together, but
    // never let a direct dependency skip the intermediate packages in a path.
    let changed = true;
    while (changed) {
        changed = false;
        for (const [dependent, allowed] of allowedEdges) {
            if (acceptedNames.has(dependent)) continue;
            const finding = findings[dependent];
            if (!finding) continue;
            const dependentVia = finding.via ?? [];
            if (
                dependentVia.length > 0 &&
                dependentVia.every((item) =>
                    typeof item === "string"
                        ? allowed.has(item) && acceptedNames.has(item)
                        : ownAdvisoriesAccepted.has(dependent),
                )
            ) {
                acceptedNames.add(dependent);
                changed = true;
            }
        }
    }
    const accepted: string[] = [];
    const refused: string[] = [];
    for (const [name, finding] of Object.entries(findings)) {
        if (finding.severity !== "high" && finding.severity !== "critical") continue;
        (acceptedNames.has(name) ? accepted : refused).push(`${name} (${finding.severity})`);
    }
    const unusedExceptions = ACCEPTED_ADVISORIES.map((entry) => entry.vulnerablePackage).filter(
        (name) => !usedExceptions.has(name),
    );
    return { accepted, refused, unusedExceptions };
}

function run(command: string, args: string[], cwd: string, allowedStatuses = [0]): string {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 20 * 1024 * 1024,
    });
    const status = result.status ?? -1;
    if (!allowedStatuses.includes(status)) {
        throw new Error(
            `${command} ${args.join(" ")} failed with status ${status}\n${result.stdout}${result.stderr}`,
        );
    }
    return result.stdout;
}

function packedFilename(output: string): string {
    const result = JSON.parse(output) as Array<{ filename?: unknown }>;
    const filename = result[0]?.filename;
    if (typeof filename !== "string" || filename.length === 0) {
        throw new Error("npm pack did not report a tarball filename");
    }
    return filename;
}

function auditPackedPackage(
    packageInfo: (typeof PACKAGES)[number],
    temporaryRoot: string,
): Set<string> {
    const packageRoot = join(temporaryRoot, packageInfo.name.split("/").at(-1) ?? "package");
    const packOutput = run(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryRoot],
        packageInfo.directory,
    );
    const tarball = join(temporaryRoot, packedFilename(packOutput));
    if (!existsSync(tarball)) {
        throw new Error(`npm pack did not create ${tarball}`);
    }

    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify(
            {
                name: "magic-context-packed-audit",
                private: true,
                dependencies: { [packageInfo.name]: `file:${tarball}` },
            },
            null,
            2,
        ),
        { flag: "wx" },
    );
    run(
        "npm",
        [
            "install",
            "--package-lock-only",
            "--legacy-peer-deps",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
        ],
        packageRoot,
    );

    const auditOutput = run("npm", ["audit", "--json"], packageRoot, [0, 1]);
    const report = JSON.parse(auditOutput) as AuditReport;
    const counts = report.metadata?.vulnerabilities;
    if (!counts) {
        throw new Error(`${packageInfo.name}: npm audit returned no vulnerability metadata`);
    }
    const high = counts.high ?? 0;
    const critical = counts.critical ?? 0;
    console.log(
        `[packed-audit] ${packageInfo.name}: low=${counts.low ?? 0} moderate=${counts.moderate ?? 0} high=${high} critical=${critical}`,
    );
    const { accepted, refused, unusedExceptions } = classifyHighFindings(report, packageInfo.name);
    if (accepted.length > 0) {
        console.log(
            `[packed-audit] ${packageInfo.name}: accepted by a documented exception: ${accepted.join(", ")}`,
        );
    }
    if (refused.length > 0 || ((high > 0 || critical > 0) && accepted.length === 0)) {
        throw new Error(
            `${packageInfo.name}: packed consumer graph has ${high} high and ${critical} critical vulnerabilities${refused.length ? `: ${refused.join(", ")}` : ""}`,
        );
    }
    return new Set(ACCEPTED_ADVISORIES.map((e) => e.vulnerablePackage).filter((n) => !unusedExceptions.includes(n)));
}

if (import.meta.main) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "magic-context-packed-audit-"));
    try {
        const used = new Set<string>();
        for (const packageInfo of PACKAGES) {
            for (const name of auditPackedPackage(packageInfo, temporaryRoot)) used.add(name);
        }
        for (const entry of ACCEPTED_ADVISORIES) {
            if (!used.has(entry.vulnerablePackage)) {
                console.log(
                    `[packed-audit] NOTE: the exception for ${entry.vulnerablePackage} matched nothing; remove it from ACCEPTED_ADVISORIES.`,
                );
            }
        }
        console.log(
            "[packed-audit] PASS: packed consumer graphs contain no high/critical findings outside documented exceptions",
        );
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
}
