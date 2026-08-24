#!/usr/bin/env bun
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	AuditInputError,
	auditPackageNames,
	createProductionManifest,
	evaluateAudit,
	parsePolicy,
	resolvedDependencyPaths,
} from "./audit-production-policy";

function run(
	command: readonly string[],
	cwd: string,
	acceptedExitCodes: readonly number[] = [0],
): string {
	const result = Bun.spawnSync([...command], {
		cwd,
		stdout: "pipe",
		stderr: "inherit",
	});
	if (!acceptedExitCodes.includes(result.exitCode)) {
		throw new AuditInputError(
			`${command.join(" ")} failed with exit code ${result.exitCode}`,
		);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

async function main(): Promise<void> {
	const root = resolve(import.meta.dir, "..");
	const policy = parsePolicy(
		JSON.parse(
			await readFile(
				join(root, ".github/production-audit-policy.json"),
				"utf8",
			),
		),
		new Date().toISOString().slice(0, 10),
	);
	const packageArgs = process.argv.slice(2);
	const packages =
		packageArgs.length === 0
			? ["packages/plugin", "packages/pi-plugin", "packages/cli"]
			: packageArgs;
	const temporaryRoot = await mkdtemp(
		join(tmpdir(), "magic-context-production-audit-"),
	);
	let rejected = 0;
	try {
		for (const [index, packageArg] of packages.entries()) {
			const packageDirectory = isAbsolute(packageArg)
				? packageArg
				: join(root, packageArg);
			const source = JSON.parse(
				await readFile(join(packageDirectory, "package.json"), "utf8"),
			);
			const manifest = createProductionManifest(source);
			const artifact = manifest.name;
			const consumer = join(temporaryRoot, String(index));
			await Bun.write(
				join(consumer, "package.json"),
				JSON.stringify(manifest, null, 2),
			);
			console.log(`Auditing production dependencies for ${artifact}`);
			run(
				[
					process.execPath,
					"install",
					"--lockfile-only",
					"--save-text-lockfile",
					"--silent",
				],
				consumer,
			);
			const auditOutput = run(
				[process.execPath, "audit", "--audit-level=high", "--json"],
				consumer,
				[0, 1],
			);
			const audit: unknown = JSON.parse(auditOutput);
			const pathsByPackage = Object.fromEntries(
				auditPackageNames(audit).map((packageName) => [
					packageName,
					resolvedDependencyPaths(
						run([process.execPath, "pm", "why", packageName], consumer),
						artifact,
					),
				]),
			);
			const evaluation = evaluateAudit(audit, policy, artifact, pathsByPackage);
			for (const finding of evaluation.accepted) {
				console.log(
					`Accepted ${finding.id} in ${finding.package} for ${artifact} via ${finding.dependencyPath}; expires ${finding.exception.expires}`,
				);
			}
			for (const finding of evaluation.rejected) {
				console.error(
					`Unaccepted ${finding.severity.toUpperCase()} ${finding.id} in ${finding.package} for ${artifact} via ${finding.dependencyPath}`,
				);
			}
			rejected += evaluation.rejected.length;
		}
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
	if (rejected > 0)
		throw new AuditInputError(
			`${rejected} unaccepted HIGH/CRITICAL production advisory path(s)`,
		);
}

await main();
