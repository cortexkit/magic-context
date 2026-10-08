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

type AuditReport = {
    metadata?: {
        vulnerabilities?: Partial<Record<"info" | "low" | "moderate" | "high" | "critical", number>>;
    };
    vulnerabilities?: Record<string, { severity?: string; via?: unknown }>;
};

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
): void {
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
    if (high > 0 || critical > 0) {
        const findings = Object.entries(report.vulnerabilities ?? {})
            .filter(([, finding]) => finding.severity === "high" || finding.severity === "critical")
            .map(([name, finding]) => `${name} (${finding.severity})`)
            .join(", ");
        throw new Error(
            `${packageInfo.name}: packed consumer graph has ${high} high and ${critical} critical vulnerabilities${findings ? `: ${findings}` : ""}`,
        );
    }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "magic-context-packed-audit-"));
try {
    for (const packageInfo of PACKAGES) {
        auditPackedPackage(packageInfo, temporaryRoot);
    }
    console.log("[packed-audit] PASS: packed consumer graphs contain no high/critical findings");
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}
